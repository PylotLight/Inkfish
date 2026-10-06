# Inkfish MVP — inbox → processed notes

Menu-bar quick capture with auto AI sort. Same animal vein as blobfish:
glassfish (transparent/glass UI), angler (lure for stray thoughts),
remora (sticks notes to projects) were the runners-up. Picked: **inkfish**
— squid/cuttlefish squirts ink fast, smartest invertebrate = AI sorts later.

## 1. Core flow (the whole app)

```
Capture popover (Opt-Space) → staging inbox (dumping ground, raw .md + assets)
  combined composer: text + dropped images + dictated transcripts,
  Teams-meeting snippets land as kind: meeting
  → classify (project, type, tags, title, formatted MD)
  → <name>/YYYY-MM-DD-slug.md (processed note, links back to inbox id)
  → searchable, undo/reassign if AI got it wrong
```

- Quick note add to various dirs/projects: tray popover has project picker
  (default: Auto) plus a Today toggle for day-log appends. `Cmd-Enter` saves
  to the staging inbox (or appends to today), non-blocking.
- Auto-sorted: background worker formats + routes. Inbox list shows
  `inbox → ready` state per item. Never deletes raw.
- Idea tracking: every processed note keeps `inbox:` frontmatter ref,
  project backlinks, created/source (tray, meeting, image).
- Teams-call notes: same inbox path — meeting recorder drops transcript
  chunks into staging as `kind: meeting`, processed into meeting note template
  (attendees, decisions, actions).

## 2. Features (P0 → P1 → later)

P0 (MVP, local only, free):
- [x] Tray: popover quick-add (text), global shortcut, project dropdown + Auto.
  Left-click pops capture; right-click shows the menu (never both).
- [x] Vault = plain folder (`~/Inkfish/`): finalised outputs only —
  top-level `<name>/` note folders, `assets/`. A "project" is just a folder
  name, not an app dir. Working state (raw inbox, day-log scratch, trash,
  undone, index) lives in hidden app data, never in the vault.
- [x] Editor: CodeMirror 6 GFM source + preview with folding, image paste →
  assets/, long fenced blocks collapse in preview
- [x] Voice: record in popover → local wav → STT sidecar → inbox text (see §4)
- [x] Meeting: manual transcript paste + import .wav/.mp3 (STT) / .vtt, Teams export .vtt accepted (live mic+system capture via ScreenCaptureKit = later)
- [x] SQLite index: FTS5 + metadata, plain .md stays source of truth (node:sqlite + memory fallback)
- [x] Glass UI: vibrancy popover + sidebar / note-stage layout (core sidebar, center editor)

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
- Capture popover 380×~500: autofocus input, `Cmd-Enter` save, combined
  composer (type + image drop + dictate), project picker, subtle save animation.
- Main: Home dashboard on launch; core sidebar (search, Home/Notes/Inbox tabs, folder tree, kind filters, notes list) + center note stage with Read/Edit/Split; full-page settings hold themes (incl. custom accent), density, motion, vault moves; sidebar footer has Settings + Quit like Blobfish
  with status pills. Dark-first, Liquid Glass materials.
- Onboarding: 3 steps — vault location, Mic/ScreenRecording permission test,
  shortcut confirm. Empty state: "drop a .md folder here".

## 4. AI: Apple Intelligence + native STT (no python)

- Apple Intelligence first where present (Foundation Models / on-device LLM
  for classify/format/summarize, Speech framework for short dictation).
  Abstract behind `summarize()`, `classify()`, `transcribe()` so Apple
  Intelligence can slot in front. No account, offline default.
- STT: native binaries only — `$INKFISH_STT_BIN` → `parakeet-cli`
  (parakeet-tdt-0.6b-v3 family, GGUF) → `inkfish-stt` Apple Speech CLI.
  No pip/python in install or runtime (see `docs/stt-options.md` and
  `stt/README.md`). Missing engine = reject with a clear message; the UI
  keeps the audio asset and falls back to manual text. Keep audio →
  transcript separate from transcript → summary.
- Noise weakness noted in model card (MUSAN gap) → recommend headphones,
  keep Teams built-in transcript import as backup path.

## 5. DB: sqlite + vector (cache only — .md files are truth)

- `inkfish.db` lives in the hidden app-data dir (never in the notes home),
  main-process only (`node:sqlite`, in-memory fallback): `notes` index rows
  (vault path + frontmatter copy), FTS5 on body. Delete it any time — Rescan
  rebuilds everything from files.
- `sqlite-vec` extension for `note_embeddings`: small local embed model
  (e.g. nomic-embed / Apple NL first pass), cosine search for related/similar,
  project auto-suggest. Embeddings are cache — .md files are truth.
- Assets stay plain files (`assets/YYYY/MM/<id>.wav|png`), DB stores paths.

## 6. Build order (matches template rules)

1. `src/shared/types.ts` — done (NoteKind/Status/Project/InboxItem/ProcessedNote).
2. Tray popover view + `Opt-Space` shortcut, IPC `inbox:add` (rule: handle in
   `src/main/ipc.ts` → expose in preload → `window.api`).
3. Vault writer (main): inbox .md + sqlite row + FTS entry.
4. STT wiring (native `parakeet-cli` / Apple CLI) + meeting import.
5. Classifier worker (Apple Intelligence → rules), router to top-level folders.
6. sqlite-vec related search + polish glass popover.

Verify each step: `bun run typecheck`, `bun run build`, `bun run start`.
