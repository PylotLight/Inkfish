# Intelligence: on-device note cleanup

Inkfish cleans up and files captures with a small local language model, a step
past transcription (like FluidVoice's Fluid Intelligence). Nothing leaves the Mac.

## Apple Intelligence (shipped first)

- **Model:** Apple Foundation Models, the ~3B on-device LLM behind Apple
  Intelligence (macOS 26, Apple silicon). Built into the OS, so there's nothing to download.
- **Where it runs:** the bundled `inkfish-stt` helper (`stt/Sources/InkfishSTT/Intelligence.swift`).
  - `inkfish-stt ai status` returns availability: `available`, `appleIntelligenceNotEnabled`,
    `modelNotReady`, `deviceNotEligible`, `osTooOld` or `sdkMissing`.
  - `inkfish-stt ai run` takes a JSON request on stdin (`{task: cleanup|organize|summarize, text,
    projects, style, instructions, temperature, cleanup}`) and returns JSON.
- **Guided generation:** `@Generable` structs (`CleanedNote`, `OrganisedNote`, `OrganisedCleanNote`,
  `NoteSummary`) return typed fields, so there's no preamble and no JSON parsing of free text.
- **Context window:** about 4k tokens. Cleanup splits long notes into ~2.4k-character chunks, each in a
  fresh session. Organise reads the first 6k characters.
- **Prompting:** the note is wrapped in `<note>` tags and treated as data, so the model never answers
  or obeys it. User "words" (names, spelling) ride in the instructions.
- **Weak-linked:** `FoundationModels` is weak-linked (Package.swift) when building with Swift 6.2 / the
  macOS 26 SDK. Older toolchains compile a stub that reports `sdkMissing`.

## Where it's used

`src/main/ai.ts › classify()` handles inbox processing and reassignment:

1. Rules run first, as always.
2. When Settings › Apple Intelligence is on and the model is available, `organize` (or `cleanup`) runs.
3. Cleanup replaces the body, and organise sets the title, tags and project. A model project name
   that isn't a real project is ignored. An explicit Capture project pick always wins.
4. Any error or unavailability returns the rules result. The raw capture is never deleted.

Meetings and images skip the model. `summarize()` uses it when available.

## Settings

Settings › Intelligence › Apple Intelligence has:

- Status, a fix-it hint and **Open System Settings** (Apple Intelligence & Siri)
- Toggles for using it, cleanup, organising and action items
- Cleanup style (Light, Standard, Structured), creativity (temperature) and "Your words"
- A playground to run Clean up, Organise or Summarise on any text, with timing

Prefs live in app data as `intelligence.json`, so the main-process router reads them.

## Next

- A downloadable open model for Macs without Apple Intelligence: Gemma 4 E2B/E4B or Qwen3.5 4B
  via MLX Swift in the same helper, as a second tab under Intelligence.
- A LoRA fine-tune on raw→clean pairs (Fluid-1 is a fine-tuned Gemma). Apple also supports
  Foundation Models adapters.
