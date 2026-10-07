# Transcription helper (native only — no python)

`stt/` is a SwiftPM package that builds `inkfish-stt`, an internal helper the
app spawns (bundled as `Inkfish.app/Contents/Resources/bin/inkfish-stt`).
Users never run it; everything is driven from Settings › Voice Engine.

Engines (`src/main/stt.ts` lists and runs them):

| id | engine | notes |
|---|---|---|
| `apple-speech` | SFSpeechRecognizer | built in; macOS needs Siri or Dictation enabled |
| `apple-analyzer` | SpeechAnalyzer / SpeechTranscriber | macOS 26 + built with the macOS 26 SDK; assets via AssetInventory |
| `parakeet-*`, `phonon-2`, `nemotron-multilingual`, `cohere-transcribe` | FluidAudio CoreML on the ANE | see docs/stt-options.md |

Helper commands: `engines`, `transcribe <audio> --engine ID`, `prepare --engine ID`, `remove --engine ID`.
FluidAudio caches models in `~/Library/Application Support/FluidAudio/Models`.
`$INKFISH_STT_BIN` overrides everything (must print `{text, segments}`).

Build: `bun run dev` / `bun run build` run `scripts/build-stt.ts` (needs Xcode
or the command line tools with Swift 6; first build fetches FluidAudio).
Package targets macOS 14+.
