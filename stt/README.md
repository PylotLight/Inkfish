# local STT (native binaries only — no python)

Inkfish never spawns `python3` / `pip`. Voice transcription goes through
native sidecars behind the `transcribe()` abstraction (`src/main/ai.ts`):

1. `$INKFISH_STT_BIN` (explicit override, must emit `{text, segments}` JSON),
2. `parakeet-cli` on `PATH` (e.g. Homebrew `whisper-cpp` formula ships it,
   Metal on Apple Silicon; models from `ggml-org/parakeet-GGUF`),
3. `inkfish-stt` Apple Speech CLI in app resources (macOS, `SFSpeechRecognizer`,
   zero downloads — ships later).

Input is the 16 kHz mono WAV the renderer already produces
(`Capture.tsx → toWav()`); audio file imports decode via WebAudio.
Any failure rejects — the UI keeps the audio asset and asks for typed text,
nothing is lost.

Manual transcript paste and Teams `.vtt` import always work offline
(main window → Meeting → Import).
