# Speech-to-text options

Rule: native or in-app only — no python/pip, no Homebrew installs, no `.node` addons.

## Shipped (bundled helper `inkfish-stt`, Settings › Voice Engine)

| Engine id | Model | Runs on | Notes |
|---|---|---|---|
| `apple-speech` | SFSpeechRecognizer | macOS | built in; needs Siri or Dictation enabled |
| `apple-analyzer` | SpeechAnalyzer / SpeechTranscriber | macOS 26 | built in; language assets via AssetInventory |
| `parakeet-v2` | Parakeet TDT 0.6B v2 | ANE | English, ~440 MB |
| `parakeet-v3` | Parakeet TDT 0.6B v3 | ANE | 25 langs, ~480 MB |
| `parakeet-ultra` | Moondream post-trained v3 | ANE | 25 langs, ~630 MB |
| `parakeet-redux` | Moondream 1.58-bit v3 | ANE | 25 langs, ~220 MB, macOS 15 |
| `phonon-2` | Fermion five-value v3 | ANE | English, ~360 MB, macOS 15 |
| `parakeet-flash` | Parakeet TDT-CTC 110M | ANE | English, tiny |
| `nemotron-multilingual` | Nemotron 3.5 streaming 0.6B | ANE | ~40 langs |
| `cohere-transcribe` | Cohere Transcribe 03-2026 q8 | ANE | 14 langs, ~2 GB, slow, macOS 15 |

All FluidAudio (Apache-2.0) models download once to
`~/Library/Application Support/FluidAudio/Models`. Removed: `parakeet-cli`
(Homebrew whisper-cpp) — no external dependency remains.

## In-app Web engines (renderer, WebGPU/WASM — `src/renderer/src/webStt.ts`)

| Engine id | Package | Notes |
|---|---|---|
| `web-parakeet-redux` | `@karanganesan/vocule` | Redux in a worker; ~178 MB; closed-source engine, MIT package |
| `web-parakeet-v2` | `parakeet.js` | TDT 0.6B v2 ONNX; fp16 encoder on WebGPU (~1.2 GB) |
| `web-moonshine` | `@moonshine-ai/moonshine-wasm` | Base, English; SmallStreaming powers live captions |
| `web-whisper-turbo` | `@huggingface/transformers` | whisper-large-v3-turbo, WebGPU |
| `web-whisper-base` | `@huggingface/transformers` | whisper-base q8 |

Bundled as devDependencies (Vite bundles them into the renderer; native
`onnxruntime-node`/`sharp` deps are never loaded or shipped). Needs CSP
`'wasm-unsafe-eval'`, `worker-src blob: data:`, `connect-src https:` and the
`SharedArrayBuffer` feature switch (main/index.ts). Ready state is a
localStorage flag; weights live in Cache Storage / IndexedDB. Adds ~65 MB of
wasm to the app bundle.

## WASM / pure-JS review (2026-10)

| Option | Verdict |
|---|---|
| Parakeet Redux WASM | Redundant — the same Redux weights run natively on the ANE via FluidAudio, much faster than WASM CPU. |
| Transformers.js (Whisper, WebGPU) | Only worth it as a Windows/Linux/Intel fallback. Costs onnxruntime-web (~20 MB), CSP `wasm-unsafe-eval`, and a renderer-side engine. Later. |
| Moonshine WASM (`@moonshine-ai/moonshine-wasm` 0.1.x) | The one new capability: true streaming English for live captions while recording. Young package — try as a live-preview layer, keep the batch engine for the saved transcript. |
| Moonshine JS | Superseded by moonshine-wasm. |
| Transcribe.js / shout (whisper.cpp WASM) | CPU-only Whisper; slower than Transformers.js WebGPU. Skip. |
| vosk-browser | Low accuracy; command words only. Skip. |

"SpeechAnalyzer needs a Swift helper" no longer counts against it — the helper ships already.
