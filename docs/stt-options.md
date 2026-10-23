# Speech-to-text options

Rule: native or in-app only — no python/pip, no Homebrew installs, no `.node` addons.

## Shipped (bundled helper `inkfish-stt`, Settings › Voice Engine)

| Engine id               | Model                              | Runs on  | Notes                                        |
| ----------------------- | ---------------------------------- | -------- | -------------------------------------------- |
| `apple-speech`          | SFSpeechRecognizer                 | macOS    | built in; needs Siri or Dictation enabled    |
| `apple-analyzer`        | SpeechAnalyzer / SpeechTranscriber | macOS 26 | built in; language assets via AssetInventory |
| `parakeet-v2`           | Parakeet TDT 0.6B v2               | ANE      | English, ~440 MB                             |
| `parakeet-v3`           | Parakeet TDT 0.6B v3               | ANE      | 25 langs, ~480 MB                            |
| `parakeet-ultra`        | Moondream post-trained v3          | ANE      | 25 langs, ~630 MB                            |
| `parakeet-redux`        | Moondream 1.58-bit v3              | ANE      | 25 langs, ~220 MB, macOS 15                  |
| `phonon-2`              | Fermion five-value v3              | ANE      | English, ~360 MB, macOS 15                   |
| `parakeet-flash`        | Parakeet TDT-CTC 110M              | ANE      | English, tiny                                |
| `nemotron-multilingual` | Nemotron 3.5 streaming 0.6B        | ANE      | ~40 langs                                    |
| `cohere-transcribe`     | Cohere Transcribe 03-2026 q8       | ANE      | 14 langs, ~2 GB, slow, macOS 15              |

All FluidAudio (Apache-2.0) models download once to
`~/Library/Application Support/FluidAudio/Models`. Removed: `parakeet-cli`
(Homebrew whisper-cpp) — no external dependency remains.

## In-app Web engines (renderer, WebGPU/WASM — `src/renderer/src/webStt.ts`)

| Engine id                     | Package                     | Notes                                                                                                                         |
| ----------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `web-parakeet-redux`          | `@karanganesan/vocule`      | Redux in a worker; ~178 MB; closed-source engine, MIT package                                                                 |
| `web-parakeet-v2`             | `parakeet.js`               | TDT 0.6B v2 ONNX; fp16 encoder on WebGPU (1.24 GB; WebGPU can't run int8), int8 on CPU (652 MB). Native Core ML v2 is ~442 MB |
| `web-moonshine-v2-small`      | `@huggingface/transformers` | **Experimental** [community v2 Small export](https://huggingface.co/Workmind/moonshine-streaming-small-ONNX); q8 CPU, ~158 MB |
| `web-moonshine-tiny`          | `@huggingface/transformers` | [Original Tiny](https://huggingface.co/onnx-community/moonshine-tiny-ONNX), not v2; q8 CPU, ~28 MB                            |
| `web-moonshine-base`          | `@huggingface/transformers` | [Original Base](https://huggingface.co/onnx-community/moonshine-base-ONNX), not v2; q8 CPU, ~63 MB                            |
| `web-whisper-tiny-en`         | `@huggingface/transformers` | [Whisper Tiny.en](https://huggingface.co/onnx-community/whisper-tiny.en); q8 CPU, ~41 MB                                      |
| `web-whisper-base-en`         | `@huggingface/transformers` | [Whisper Base.en](https://huggingface.co/onnx-community/whisper-base.en); q8 CPU, ~77 MB                                      |
| `web-distil-whisper-small-en` | `@huggingface/transformers` | [Distil-Whisper Small.en](https://huggingface.co/distil-whisper/distil-small.en); q8 CPU, ~172 MB                             |

Bundled as devDependencies (Vite bundles them into the renderer; native
`onnxruntime-node`/`sharp` deps are never loaded or shipped). Needs CSP
`'wasm-unsafe-eval'`, `worker-src blob: data:`, `connect-src https:` and the
`SharedArrayBuffer` feature switch (main/index.ts). Ready state is a
localStorage flag; weights live in Cache Storage / IndexedDB. Adds ~65 MB of
wasm to the app bundle.

### Comparing the compact models

Download the models in **Settings › Voice Engine**, then run the existing Quick
and Deep benchmarks to compare WER and warm decode speed with Redux. The new
models are English-only and use single-threaded WASM q8 in dedicated module
workers, not the GPU/ANE. Their labels show approximate ONNX encoder + merged
decoder bytes, excluding tokenizer/config files and the shared bundled runtime;
they are not peak RAM figures. No accuracy or speed win over Redux is assumed.

The v2 Small export is a third-party conversion using Transformers.js's original
Moonshine compatibility path. It runs full utterances, **not live streaming**;
Tiny/Base are explicitly the original Moonshine architecture. No v2 Tiny/Medium
option is shipped without a verified compatible export. Moonshine input is
split at quiet boundaries into at most 20 s windows; v2 windows are zero-padded
to 80-sample frames. Whisper also decodes independent quiet-cut windows (20 s,
or 15 s for Distil-Whisper), avoiding its timestamp-stitching path which dropped
whole sections in a Whisper Base q8 long-clip regression test.
Live dictation captions remain Redux-only.

Each new model has its own Cache Storage bucket. Reset/timeout/delete terminates
its worker and rejects pending requests; deleting one model does not erase the
others. The native download-source preference also applies to these six models
(HTTPS mirrors only). Downloads use Chromium's session network routing. WASM
assets ship locally, so cached models can run offline. The new runtime uses one
thread deliberately, avoiding the old nested pthread-pool startup path.

Runtime smoke test after building (downloads into an isolated Electron profile):

```sh
bunx electron-vite build
xvfb-run -a node scripts/electron-stt-smoke.cjs
```

On macOS omit `xvfb-run -a`. Pass model IDs to run a subset. Set
`INKFISH_STT_SMOKE_PROFILE` to retain the test cache between runs, then use
`--offline --full` to test the entire 79 s clip with remote requests blocked.
Do not rebuild the renderer while this test is running. The CLI
`bun run bench:stt` still benchmarks only native helper engines.

For repeatable Web engine measurements outside Settings:

```sh
INKFISH_STT_BENCH_PROFILE=/tmp/inkfish-web-bench \
  xvfb-run -a bun run bench:stt:web
```

On macOS omit `xvfb-run -a`. This builds a separate benchmark renderer with the
application's production CSP and sandboxed Electron settings. By default it runs
both Quick and Deep on Redux and the Workmind Moonshine v2 Small export. Pass
`--quick` or `--deep`, followed by any shipped `web-` engine IDs, for a subset.
The same application engine loaders, bundled audio, warm-up, per-clip time limits,
normalization and corpus WER scoring are used. Timed Web calls include audio
decoding, as they do in Settings. Model loading and the first decode are timed
separately as warm-up; this is not a native-helper benchmark.

The runner saves each success or failure incrementally to `bench-results.json`;
override its location with `INKFISH_STT_BENCH_OUTPUT`. Set
`INKFISH_STT_BENCH_PROFILE` to retain model caches, then pass `--offline` on a
later run to block all HTTP(S) requests. Without a profile override, the temporary
profile is removed after a completed run. Do not rebuild this benchmark renderer
while it is running. Redux requires a working WebGPU adapter; a missing adapter
is recorded as a failure, not a zero score or an inferred CPU result. A run with
any failed engine exits nonzero while preserving other engines' results.

Zipformer Small and the official Moonshine Voice streaming runtime are not added
as selectable engines by this benchmark change. Zipformer still needs a built
sherpa-onnx browser runtime and an end-to-end adapter. The official Moonshine
prototype still needs production asset/worker/CSP validation. Neither is claimed
to have passed Quick or Deep, and no Redux comparison is claimed on machines
without WebGPU.

## WASM / pure-JS review (2026-10)

| Option                                                | Verdict                                                                                                                                                                    |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Parakeet Redux WASM                                   | Redundant — the same Redux weights run natively on the ANE via FluidAudio, much faster than WASM CPU.                                                                      |
| Transformers.js (Moonshine/Whisper, WASM q8)          | Shipped for compact-model comparisons, isolated in workers. GPU/ANE acceleration is not claimed.                                                                           |
| Moonshine WASM (`@moonshine-ai/moonshine-wasm` 0.1.x) | Tried and removed (Oct 2026): its threaded Emscripten build stalled loading inside Electron (CSP `unsafe-eval` / pthread pool), and Redux · Web already streams live text. |
| Moonshine JS                                          | Superseded by moonshine-wasm.                                                                                                                                              |
| Transcribe.js / shout (whisper.cpp WASM)              | CPU-only Whisper; slower than Transformers.js WebGPU. Skip.                                                                                                                |
| vosk-browser                                          | Low accuracy; command words only. Skip.                                                                                                                                    |

"SpeechAnalyzer needs a Swift helper" no longer counts against it — the helper ships already.
