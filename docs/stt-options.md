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

| Engine id                                        | Package                        | Notes                                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web-parakeet-redux`                             | `@karanganesan/vocule`         | Redux in a worker; ~178 MB; closed-source engine, MIT package                                                                                                                           |
| `web-parakeet-v2`                                | `parakeet.js`                  | TDT 0.6B v2 ONNX; fp16 encoder on WebGPU (1.24 GB; WebGPU can't run int8), int8 on CPU (652 MB). Native Core ML v2 is ~442 MB                                                           |
| `web-zipformer-small`                            | sherpa-onnx WASM               | Experimental [Zipformer Small English bundle](https://huggingface.co/wundr-ai/zipformer-small-librispeech-en-wasm); offline int8 transducer, ~28.2 MB model / ~39.9 MB with runtime     |
| `web-moonshine-streaming-small-en`               | `@moonshine-ai/moonshine-wasm` | Experimental official Small Streaming English runtime; threaded CPU/WASM, model files downloaded from the official catalog                                                              |
| `web-moonshine-v2-small`                         | `@huggingface/transformers`    | **Experimental** [community v2 Small export](https://huggingface.co/Workmind/moonshine-streaming-small-ONNX); q8 CPU, ~158 MB                                                           |
| `web-moonshine-tiny`                             | `@huggingface/transformers`    | [Original Tiny](https://huggingface.co/onnx-community/moonshine-tiny-ONNX), not v2; q8 CPU, ~28 MB                                                                                      |
| `web-moonshine-base`                             | `@huggingface/transformers`    | [Original Base](https://huggingface.co/onnx-community/moonshine-base-ONNX), not v2; q8 CPU, ~63 MB                                                                                      |
| `web-whisper-tiny-en`                            | `@huggingface/transformers`    | [Whisper Tiny.en](https://huggingface.co/onnx-community/whisper-tiny.en); q8 CPU, ~41 MB                                                                                                |
| `web-whisper-base-en`                            | `@huggingface/transformers`    | [Whisper Base.en](https://huggingface.co/onnx-community/whisper-base.en); q8 CPU, ~77 MB                                                                                                |
| `web-distil-whisper-small-en`                    | `@huggingface/transformers`    | [Distil-Whisper Small.en](https://huggingface.co/distil-whisper/distil-small.en); q8 CPU, ~172 MB                                                                                       |
| `web-wav2vec2-base-960h`                         | `@huggingface/transformers`    | Experimental [Wav2Vec2 Base 960h ONNX](https://huggingface.co/onnx-community/wav2vec2-base-960h-ONNX); q8 CPU, ~95 MB, English CTC baseline without punctuation restoration             |
| `web-moonshine-streaming-tiny-int8-experimental` | `onnxruntime-web`              | Experimental [optimized Moonshine Streaming Tiny](https://huggingface.co/felixem/moonshine-streaming-tiny-optimized); ~79.8 MB INT8, separate encoder/decoder/KV-cache graphs, WASM CPU |
| `web-qwen3-asr-06b`                              | `llama-web-bridge`             | Experimental [Qwen3-ASR 0.6B GGUF](https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF); Q8_0 model + audio projector, ~1.02 GB before runtime; **not** the text-only Qwen3 0.6B model  |

Bundled as devDependencies (Vite bundles them into the renderer; native
`onnxruntime-node`/`sharp` deps are never loaded or shipped). Needs CSP
`'wasm-unsafe-eval'`, `worker-src blob: data:`, `connect-src https:` and the
`SharedArrayBuffer` feature switch (main/index.ts). Ready state is a
localStorage flag; weights live in Cache Storage / IndexedDB. Adds ~65 MB of
wasm to the app bundle.

Qwen's bridge is instead fetched at build/dev startup by
`scripts/lib/qwen-runtime.ts`: six `v0.1.44` JS/WASM assets are SHA-256 checked,
cached under `node_modules/.cache`, and copied same-origin into `qwen-runtime/`
with MIT license notices. This adds about 18 MB of runtime assets, but no native
addon or app-side Python dependency. The first build needs GitHub access;
subsequent builds reuse verified local assets. Runtime code is not imported from
an external website and the renderer CSP is not relaxed.

### Comparing the compact models

Download the models in **Settings › Voice Engine**, then run the existing Quick
and Deep benchmarks to compare WER and warm decode speed with Redux. The seven
Transformers.js models are English-only and use single-threaded WASM q8 in dedicated module
workers, not the GPU/ANE. Their labels show approximate ONNX encoder + merged
decoder bytes (or the single CTC graph), excluding tokenizer/config files and the shared bundled runtime;
they are not peak RAM figures. No accuracy or speed win over Redux is assumed.

The v2 Small export is a third-party conversion using Transformers.js's original
Moonshine compatibility path. It runs full utterances, **not live streaming**;
Tiny/Base in that catalog are explicitly the original Moonshine architecture.
The separate optimized Streaming Tiny option uses its own ONNX Runtime adapter,
not the original Moonshine compatibility path. Moonshine input is
split at quiet boundaries into at most 20 s windows; v2 windows are zero-padded
to 80-sample frames. Whisper also decodes independent quiet-cut windows (20 s,
or 15 s for Distil-Whisper), avoiding its timestamp-stitching path which dropped
whole sections in a Whisper Base q8 long-clip regression test.
Live dictation captions remain Redux-only.

Each new model has its own Cache Storage bucket. Reset/timeout/delete terminates
its worker and rejects pending requests; deleting one model does not erase the
others. The native download-source preference also applies to the Transformers.js models
(HTTPS mirrors only). Downloads use Chromium's session network routing. WASM
assets ship locally, so cached models can run offline. The new runtime uses one
thread deliberately, avoiding the old nested pthread-pool startup path.

The optimized Streaming Tiny export is revision-pinned and also honors the HTTPS
model mirror. It pads 16 kHz PCM to 80 samples, runs short quiet-cut windows and
feeds the decoder's present tensors back as past KV inputs. This is a
full-utterance benchmark/file harness, **not live microphone streaming**.

**Known testing limitation:** the pinned optimized Tiny INT8 export loads in
Electron but returned an empty transcript for the six-second speech fixture.
The model-card inference path also predicted EOS immediately in native ONNX
Runtime on the same speech, including with normalized audio. This is not a
successful transcription check or proof of browser compatibility. The option is
kept explicitly experimental for export/runtime investigation; do not interpret
an empty result as an accuracy win or silently substitute the original Tiny model.

Qwen3-ASR cannot use the installed Transformers.js pipeline. Its separate
[browser bridge](https://github.com/leehack/llama-web-bridge) uses llama.cpp with
a GGUF model and audio projector. Downloads and memory use are much larger than
the compact ONNX candidates. It handles whole-input WAV windows up to 30 seconds;
GPU/CPU execution is reported by the actual backend, never inferred from the
presence of the WebGPU API. No accuracy or performance advantage is assumed.

Both Qwen weights are revision-pinned and respect the HTTPS model mirror.
The bridge caches the language model; a separate app cache holds the projector,
since the upstream projector loader does not cache it. Delete clears both. The
adapter runs the bridge directly inside an app-owned module worker with one CPU
thread, avoiding additional bridge/pthread workers. Memory64 and CPU fallback
remain device-dependent; no GPU/ANE result is claimed from this Linux sandbox.

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
both Quick and Deep on Redux, Zipformer Small, Workmind Moonshine v2 Small,
the official Moonshine Small Streaming runtime, Wav2Vec2 Base 960h, optimized
Moonshine Streaming Tiny INT8, and Qwen3-ASR 0.6B. Pass
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

To test only the three additional candidates on the owner's device:

```sh
bun run bench:stt:web --quick web-wav2vec2-base-960h web-moonshine-streaming-tiny-int8-experimental web-qwen3-asr-06b
bun run bench:stt:web --deep web-wav2vec2-base-960h web-moonshine-streaming-tiny-int8-experimental web-qwen3-asr-06b
```

Use `--smoke` instead for a six-second non-empty-transcript/runtime check, without
WER scoring or a warm-up pass. As with benchmark runs, `--offline` blocks remote
requests and a retained `INKFISH_STT_BENCH_PROFILE` allows cache verification.
Smoke decode is bounded at 120 seconds, or 600 seconds for the large Qwen model;
its initial single-threaded CPU attempt exceeded 120 seconds after loading and
processing audio. The final six-second Qwen smoke completed with a non-empty
transcript in ~130 seconds of decode and ~89 seconds of load on this Linux CPU.
This verifies the in-app path, not accuracy or a GPU/ANE performance comparison.
Wav2Vec2 passed online and cached-offline six-second checks. Qwen's complete
offline reload and the owner's Quick/Deep measurements remain untested. The
regular Quick/Deep per-clip time limits are unchanged, so slow devices may record
a timeout rather than a score.
On Linux prefix commands with `xvfb-run -a` if running headlessly.

All requested candidates are listed in **Settings › Voice Engine**.
Zipformer uses the pinned upstream sherpa-onnx browser bundle in a dedicated
worker; its runtime and model download together into a separate cache. The
official Moonshine option uses its actual streaming API with chunked PCM, not
the Workmind full-utterance conversion. Inkfish's file/benchmark interface still
returns the final text after the whole clip; live microphone captions remain
Redux-only. The official published runtime requires SharedArrayBuffer and
threads; it does not include a prebuilt single-thread fallback.

Quick/Deep runs of these two WASM adapters are left to the owner. No accuracy,
speed advantage, or direct Redux comparison is claimed from this Linux sandbox,
which has no WebGPU adapter. The Workmind export previously measured 3.52% WER /
1.99× real time on Quick and 20.33% WER / 1.95× on Deep here; those CPU results are
not a comparison against Redux and are not representative of a Mac's GPU/ANE.

## WASM / pure-JS review (2026-10)

| Option                                                | Verdict                                                                                                                                  |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Parakeet Redux WASM                                   | Redundant — the same Redux weights run natively on the ANE via FluidAudio, much faster than WASM CPU.                                    |
| Transformers.js (Moonshine/Whisper, WASM q8)          | Shipped for compact-model comparisons, isolated in workers. GPU/ANE acceleration is not claimed.                                         |
| Moonshine WASM (`@moonshine-ai/moonshine-wasm` 0.1.5) | Reintroduced as an experimental selectable official Small Streaming option. Threaded runtime; user-device Quick/Deep validation pending. |
| Moonshine JS                                          | Superseded by moonshine-wasm.                                                                                                            |
| Transcribe.js / shout (whisper.cpp WASM)              | CPU-only Whisper; slower than Transformers.js WebGPU. Skip.                                                                              |
| vosk-browser                                          | Low accuracy; command words only. Skip.                                                                                                  |

"SpeechAnalyzer needs a Swift helper" no longer counts against it — the helper ships already.
