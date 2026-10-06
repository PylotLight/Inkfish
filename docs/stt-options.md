# STT options (native only — python removed)

Constraint (enforced): no pip/python anywhere in install or runtime.
`transcribe()` (`src/main/ai.ts`) resolves a native engine in order —
`$INKFISH_STT_BIN` → `parakeet-cli` on `PATH` → `inkfish-stt` Apple Speech
CLI in app resources — and rejects otherwise (audio kept, manual text
fallback). The `{ text, segments }` contract is unchanged.

## Option 1 — parakeet-cli sidecar (recommended, smallest diff)

- `mudler/parakeet.cpp`: C++17 parakeet port on ggml, no Python at inference.
  Every release ships prebuilt `parakeet-cli` bundles.
- `parakeet-cli transcribe --model <alias> --input audio.wav --json` →
  `{"text","words":[{"w","start","end","conf"}],"tokens":[...]}` — exactly our
  `SttResult` shape, word timestamps + confidence, WER 0 vs NeMo.
- Same model family as today: `parakeet-tdt-0.6b-v3` (multilingual, 25
  European langs, CC-BY-4.0) as GGUF from `mudler/parakeet-cpp-gguf`
  (f16/q8_0/q6_k/q5_k/q4_k; 110m hybrid also available for smaller/faster).
  CLI auto-downloads models on first run — cache into the vault (`models/`).
- Alternative binary source: Homebrew's `whisper-cpp` formula now ships
  `parakeet-cli` (Metal on Apple Silicon), models from `ggml-org/parakeet-GGUF`.
  Casks support `depends_on formula: "whisper-cpp"`, so
  `brew install --cask inkfish` pulls it automatically.
- Input formats include flac/mp3/ogg/wav; our renderer already emits 16 kHz
  WAV, and file imports can decode via WebAudio — no ffmpeg needed.
- Tradeoff: quantized 0.6B model is ~400–700 MB vs today's 178 MB ternary;
  first run downloads it.

## Option 2 — own Swift Apple Speech CLI (Apple-first, zero downloads)

- ~150-line Swift tool: `SFSpeechURLRecognitionRequest` + JSON stdout,
  compiled by `swiftc` in the release workflow, shipped in app resources.
  Precedent: `maclisten`, `georgemandis/stenographer`, `finnvoor/yap`,
  `Arthur-Ficial/ohr`.
- No models, no downloads; `requiresOnDeviceRecognition` keeps audio on-device.
- Chain becomes Apple CLI → parakeet-cli (Option 1) → manual text.
- Tradeoffs: accuracy below parakeet/whisper on meetings; needs
  `NSSpeechRecognitionUsageDescription` + permission UX verified on a real Mac
  (TCC attributes prompts to the app bundle — fine for us, but untested);
  Linux dev falls back to Option 1. `yap`/`ohr` require macOS 26 — our own
  CLI targets macOS 12+ APIs instead.

## Option 3 — sherpa-onnx-node (in-process npm)

- Apache-2.0, prebuilt per-platform NAPI binaries (`darwin-arm64/x64`,
  `linux`, `win`), whisper/zipformer/paraformer/nemo/moonshine models with
  token timestamps + VAD + diarization. No sidecar process.
- Tradeoffs: prebuilts target Node ABI, so Electron needs an
  `electron-rebuild` step in packaging and dev (`bun run dev` loads the real
  Electron binary — stale ABI = crash); ~100–500 MB model downloads.
  Most moving parts of the three.

## Dismissed

- **EchoGarden** (TS/ONNX, no python): GPLv3 — would force-relicense the MIT app.
- **nodejs-whisper**: compiles whisper.cpp from source at `npm install`
  (needs Xcode CLT + cmake + make on every user machine) — worse than brew.
- **transformers.js / ONNX-in-JS**: CPU-only, slow next to Metal/ANE.
- **Web Speech API**: cloud recognition, breaks the offline default.
