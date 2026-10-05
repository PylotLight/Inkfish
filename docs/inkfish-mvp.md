# Inkfish MVP — inbox → processed notes

Menu-bar quick capture with auto AI sort. Same animal vein as blobfish:
glassfish (transparent/glass UI), angler (lure for stray thoughts),
remora (sticks notes to projects) were the runners-up. Picked: **inkfish**
— squid/cuttlefish squirts ink fast, smartest invertebrate = AI sorts later.

## 1. Core flow (the whole app)

```
Tray popover (Opt-Space) → inbox/ (dumping ground, raw .md + assets)
  text / voice / image / Teams-meeting snippet
  → classify (project, type, tags, title, formatted MD)
  → projects/<name>/YYYY-MM-DD-slug.md (processed note, links back to inbox id)
  → searchable, undo/reassign if AI got it wrong
```

- Quick note add to various dirs/projects: tray popover has project picker
  (default: Auto). `Cmd-Enter` saves to `inbox/`, non-blocking.
- Auto-sorted: background worker formats + routes. Inbox list shows
  `inbox → ready` state per item. Never deletes raw.
- Idea tracking: every processed note keeps `inbox:` frontmatter ref,
  project backlinks, created/source (tray, meeting, image).
- Teams-call notes: same inbox path — meeting recorder drops transcript
  chunks into inbox as `kind: meeting`, processed into meeting note template
  (attendees, decisions, actions).

## 2. Features (P0 → P1 → later)

P0 (MVP, local only, free):
- [x] Tray: popover quick-add (text), global shortcut, project dropdown + Auto
- [x] Vault = plain folder (`~/Inkfish/`): `inbox/`, `projects/<name>/`, `assets/`
- [x] Editor: CodeMirror 6 GFM source + preview, image paste → assets/ (Shiki code highlight deferred to polish)
- [x] Voice: record in popover → local wav → STT sidecar → inbox text (see §4)
- [x] Meeting: manual transcript paste + import .wav/.mp3 (STT) / .vtt, Teams export .vtt accepted (live mic+system capture via ScreenCaptureKit = later)
- [x] SQLite index: FTS5 + metadata, plain .md stays source of truth (node:sqlite + memory fallback)
- [x] Glass UI: vibrancy popover + main 3-pane (sidebar / editor / inbox queue)

P1:
- [ ] Auto-router v1: Apple Intelligence (where available) → rules fallback
- [ ] sqlite-vec similarity: "related notes", duplicate detection, project suggest
- [ ] Image notes: paste/drop → OCR optional, thumbnail in note

Later:
- [ ] TTS abstraction (`speak(note)`): AVSpeech / Apple voices first, Piper later
- [ ] Calendar-aware meeting titles, speaker labels Me/Them → names
- [ ] Sync: Git or iCloud Drive (vault is just files, no server needed)

## 3. Glass UI / UX

- Template already gives native `fullscreen-ui` vibrancy + transparent window
  (see `docs/vibrancy-and-tray.md`). Keep: no opaque full-window backgrounds.
- Tray popover 380×~500: autofocus input, `Cmd-Enter` save, kind tabs
  Text | Voice | Image, project picker, subtle ink-squirt save animation.
- Main: sidebar (Projects + Inbox count), center editor, right rail inbox queue
  with status pills. Dark-first, Liquid Glass materials.
- Onboarding: 3 steps — vault location, Mic/ScreenRecording permission test,
  shortcut confirm. Empty state: "drop a .md folder here".

## 4. AI: Apple Intelligence + parakeet-redux

- Apple Intelligence first where present (Foundation Models / on-device LLM
  for classify/format/summarize, Speech framework for short dictation).
  Abstract behind `summarize()`, `classify()`, `transcribe()` so Apple
  Intelligence can slot in front. No account, offline default.
- STT: `moondream/parakeet-redux` (HF, CC-BY-4.0) — 1.58-bit ternary build of
  `nvidia/parakeet-tdt-0.6b-v3`, 178 MB, ~38× realtime CPU / ~43× GPU on M2 Air
  via Photon (Metal on Apple GPUs, NEON/AVX elsewhere), word+segment timestamps,
  built-in VAD segmentation (≤30s), beats original on FLEURS-25 + long-form.
  - Runs via Photon (`pip install moondream`, `md.photon("moondream/parakeet-redux")`).
    MVP: sidecar process (`bun spawn` python photon) transcribing wav → segments.
    Fallback: Apple Speech on short clips. Keep audio → transcript separate from
    transcript → summary model (anarlog pattern).
- Noise weakness noted in model card (MUSAN gap) → recommend headphones,
  keep Teams built-in transcript import as backup path.

## 5. DB: sqlite + vector

- `inkfish.db` (bun:sqlite / better-sqlite3 via main process only):
  `projects`, `inbox_items`, `notes` (vault path + frontmatter), FTS5 on body.
- `sqlite-vec` extension for `note_embeddings`: small local embed model
  (e.g. nomic-embed / Apple NL first pass), cosine search for related/similar,
  project auto-suggest. Embeddings are cache — .md files are truth.
- Assets stay plain files (`assets/YYYY/MM/<id>.wav|png`), DB stores paths.

## 6. Build order (matches template rules)

1. `src/shared/types.ts` — done (NoteKind/Status/Project/InboxItem/ProcessedNote).
2. Tray popover view + `Opt-Space` shortcut, IPC `inbox:add` (rule: handle in
   `src/main/ipc.ts` → expose in preload → `window.api`).
3. Vault writer (main): inbox .md + sqlite row + FTS entry.
4. STT sidecar (`stt/` python photon) + meeting import.
5. Classifier worker (Apple Intelligence → rules), router to projects/.
6. sqlite-vec related search + polish glass popover.

Verify each step: `bun run typecheck`, `bun run build`, `bun run start`.
