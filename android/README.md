# Inkfish Android (V1 — local only)

Expo + TypeScript client. Focused scope: **capture → inbox → notes → edit → today**,
all on-device. Sync ships later — but the on-disk format is already identical
to Mac, so sync will be a plain file copy.

## Run

```bash
cd android
npm install
npx expo start        # scan the QR with Expo Go (Android)
```

No dev build needed for V1 (all modules are Expo Go compatible).

## What V1 does

Navigation: floating toolbar **Home · Inbox · ＋ · Today · Settings** (Lucide
icons, the set Obsidian uses), left file drawer from ☰, Android back closes
drawer → sheet → note → returns Home.

- **Home** — date, capture line (tap = composer, mic = voice memo), inbox
  waiting, today's last entries, recent notes, search in the top bar

- **Capture** (＋, full-screen sheet) — text + voice memo (`.m4a` via `expo-audio`), Inbox/Today toggle,
  project hint chips (Auto default)
- **Inbox** — queue with `inbox → processing → ready`, Route / Move→ / Undo
- **Notes** — file drawer by folder, search, new note; editor opens in
  reading view, pencil to edit, **autosaves** (no Save button)
- **Today** — day-log append + view (`daily/YYYY-MM-DD.md`)
- **Settings** — vault paths, counts, re-scan

Voice V1 **records audio only** — the `.m4a` is saved under
`vault/assets/YYYY/MM/` and linked from the inbox item. Transcription happens
on Mac after sync (or a future on-device engine). Audio is never lost.

## Layout (mirrors Mac byte-for-byte)

```
<app-documents>/inkfish/vault/...          finalised notes + assets/  (Mac: ~/Inkfish/)
<app-documents>/inkfish/staging/inbox/…    raw captures
<app-documents>/inkfish/staging/daily/…    day-log scratch
<app-documents>/inkfish/staging/undone/…   undone routings
```

- Frontmatter keys are identical (`id, kind, status, created, source,
  projectHint, assets` for inbox; `id, inbox, project, kind, created, tags`
  for routed notes) — see `src/lib/format.ts`, ported from
  `src/main/vault.ts`.
- Router is the same keyword scorer as Mac `rulesClassify` (`provider:
  'rules'`) — see `rulesClassify` in `src/lib/format.ts`.
- Routed path shape is the same: `<project>/YYYY-MM-DD-slug.md`.

## Deliberate V1 gaps (see Settings screen)

- No SQLite/FTS index — files are scanned directly (fine for hundreds of
  notes; Mac rebuilds its index from files on first sync anyway)
- Substring search only (Mac: FTS5)
- No on-device STT / Apple Intelligence (rules router only)

## Files

```
App.tsx                  tab shell + StoreProvider
src/lib/format.ts        pure vault-format port (no RN imports — unit-testable)
src/lib/vault.ts         expo-file-system I/O (files are source of truth)
src/lib/store.tsx        React context: inbox/notes/projects + actions
src/components/Markdown.tsx  tiny dependency-free markdown renderer
src/screens/            Capture / Inbox / Notes / Editor / Daily / Settings
src/theme.ts            dark palette
```
