# Speech-to-text options

Rule: native or in-app only — no python/pip, no Homebrew installs, no `.node` addons.

Inkfish ships three engines (Settings › Voice Engine):

| Engine id            | Model                              | Runs on              | Notes                                                              |
| -------------------- | ---------------------------------- | -------------------- | ------------------------------------------------------------------ |
| `parakeet-redux`     | Moondream 1.58-bit Parakeet v3     | Mac GPU (Core ML)    | 25 langs, ~220 MB, macOS 15; bundled helper `inkfish-stt`          |
| `web-parakeet-redux` | Same Redux weights via vocule      | WebGPU + WASM in-app | ~178 MB; `@karanganesan/vocule`, closed-source engine, MIT package |
| `apple-analyzer`     | SpeechAnalyzer / SpeechTranscriber | macOS 26 (built in)  | language assets via AssetInventory                                 |

Native Redux downloads once (FluidAudio, Apache-2.0) to
`~/Library/Application Support/FluidAudio/Models`. The Web build caches its
weights in the renderer's Cache Storage (`vocule-verified-weights-v1`) and runs
in a worker; it needs CSP `'wasm-unsafe-eval'`, `worker-src blob: data:`,
`connect-src https:` and the `SharedArrayBuffer` feature switch
(main/index.ts). Live dictation captions use the Web build.

## Removed (2026-10)

Everything else was dropped to keep the list focused: native Parakeet v2 / v3 /
Ultra / Flash, Phonon-2, Nemotron 3.5, Cohere Transcribe; the legacy Apple
Speech (SFSpeechRecognizer) engine; and the Web engines Parakeet v2 (parakeet.js),
Zipformer, Moonshine (all variants incl. Tiny and the official WASM runtime),
Whisper / Distil-Whisper, Wav2Vec2 and Qwen3-ASR.

A saved choice of a removed engine migrates to Parakeet Redux (native on the
Mac, Web elsewhere). On first launch the renderer deletes the removed Web
engines' Cache Storage buckets / IndexedDB databases (app-private storage).
Removed native models are **not** auto-deleted: FluidAudio's model folder is
shared with other FluidAudio apps, so Inkfish leaves it alone.

## Benchmarks

Settings › Voice Engine runs Quick (one clean read clip) and Deep (Australian
earnings calls + harder read speech) on every ready engine.

Outside Settings, the Web build can be measured with:

```sh
INKFISH_STT_BENCH_PROFILE=/tmp/inkfish-web-bench \
  xvfb-run -a bun run bench:stt:web
```

On macOS omit `xvfb-run -a`. This builds a separate benchmark renderer with the
app's production CSP and sandboxed Electron settings and runs Quick and Deep on
`web-parakeet-redux` (pass `--quick`, `--deep` or `--smoke`). Results go to
`bench-results.json` (override with `INKFISH_STT_BENCH_OUTPUT`); `--offline`
blocks remote requests on a retained profile. Redux needs a working WebGPU
adapter; a missing adapter is recorded as a failure. `bun run bench:stt`
benchmarks the native helper engines.
