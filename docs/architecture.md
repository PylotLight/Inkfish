# Architecture

Three processes, one bridge, one shared contract layer.

```
main (Node, Electron)  ──ipcMain.handle──┐
                                          ├─▶ preload (contextBridge → window.api)
renderer (React, browser) ──invoke───────┘
```

- `src/main/index.ts` — app lifecycle only: single-instance lock, vault init
  (`ensureVault` + seed projects + `openDb` + re-scan), `whenReady` wiring,
  `Alt+Space` global shortcut, quit handling. No business logic.
- `src/main/window.ts` — main `BrowserWindow` creation, `showWindow`/`hideWindow`, vibrancy state.
- `src/main/popover.ts` — 380×520 capture popover (`vibrancy: popover`,
  frameless, always-on-top, hides on blur), `togglePopover()` near the cursor.
- `src/main/tray.ts` — system tray + context menu (New note / Show Inkfish /
  Quit). Left-click pops the menu; it never auto-shows the window.
- `src/main/vault.ts` — vault writer: inbox `.md` + frontmatter, project
  routing, undo (`.undone`), assets, Teams `.vtt` parsing. `.md` files are the
  source of truth; nothing here deletes raw.
- `src/main/db.ts` — sqlite index (`node:sqlite` + FTS5, `inkfish.db` in the
  vault root), in-memory fallback. Embeddings column reserved for sqlite-vec.
- `src/main/ai.ts` — `transcribe()` / `classify()` / `summarize()` / `speak()`
  abstraction: Apple → rules chain, provider reported per result.
- `src/main/ipc.ts` — every renderer→main call. Sections mirror the preload bridge.
- `src/preload/index.ts` — typed `window.api`. Nothing here but forwarding.
- `src/shared/config.ts` — runtime values safe to import anywhere (app name, id, geometry).
- `src/shared/types.ts` — type-only contracts (domain + IPC payloads).
- `src/renderer/` — React shell: `App.tsx` (sidebar + note stage, `#capture`
  hash → popover capture) and views in `views/` (`Capture`, `InboxQueue`,
  `NoteEditor`, `Onboarding`, `MeetingImport`).

## Rules

1. **Renderer never imports main-process modules.** Type-only imports from `src/shared/`
   are allowed and erased at build time.
2. **New IPC tool = 3 edits:** `ipcMain.handle` in `src/main/ipc.ts`, expose in
   `src/preload/index.ts`, call via `window.api`. Shared payload types go in
   `src/shared/types.ts`. The bridge is typed end-to-end, so the renderer sees the new
   call immediately.
3. **New section = 2 edits:** add a view in `src/renderer/src/views/`, register it in
   `App.tsx`. Nav, layout, and glass styling come free.
4. **Tray items** go in the menu template in `src/main/tray.ts`; window actions reuse the
   helpers in `src/main/window.ts` / `src/main/popover.ts`.
5. **Vault writes happen in main only.** The renderer asks via `window.api`
   (`inbox:add`, `notes:save`, `assets:save`); the main process writes the
   `.md`, updates the index, and — for inbox items — fires the non-blocking
   classify → route worker.

## Layout model

The app shell is locked to the viewport (`.shell { height: 100vh; overflow: hidden }`).
Sidebar and top bar are fixed; only `.view` scrolls (main panes scroll
internally). Keep it that way — any opaque
full-window background also kills the native vibrancy (see vibrancy doc).
