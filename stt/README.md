# local STT (native binaries only — no python)

Inkfish never spawns `python3` / `pip`. Voice transcription goes through
native sidecars behind the `transcribe()` abstraction (`src/main/ai.ts`):

1. `$INKFISH_STT_BIN` (explicit override, must emit `{text, segments}` JSON),
2. `parakeet-cli` on `PATH` or in `/opt/homebrew/bin` / `/usr/local/bin`
   (Homebrew `whisper-cpp` formula ships it, Metal on Apple Silicon; models
   from `ggml-org/parakeet-GGUF`),
3. `inkfish-stt` Apple Speech CLI — `stt/inkfish-stt.swift`, built by
   `bun run stt:build` (release workflow does it) into `stt/bin/`, bundled as
   `Inkfish.app/Contents/Resources/bin/inkfish-stt`. On-device
   `SFSpeechRecognizer`, macOS 12+, zero downloads. First use prompts for
   Speech Recognition permission. If the locale has no on-device model, turn
   on Dictation (System Settings › Keyboard) or set
   `INKFISH_STT_ALLOW_NETWORK=1`. `inkfish-stt --check` prints status.

Mic capture needs `NSMicrophoneUsageDescription` (set via
`build.mac.extendInfo`); main routes `getUserMedia` through
`systemPreferences.askForMediaAccess`.

Input is the 16 kHz mono WAV the renderer already produces
(`Capture.tsx → toWav()`); audio file imports decode via WebAudio.
Any failure rejects — the UI keeps the audio asset and asks for typed text,
nothing is lost.

Manual transcript paste and Teams `.vtt` import always work offline
(main window → Meeting → Import).
