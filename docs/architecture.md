# Architecture

Inkfish is **one repository, four deliverables, and two toolchains.** The
desktop app is the product; the other three attach to it in different ways,
and a single shared TypeScript layer (`src/shared/`) is what actually makes
this a monorepo rather than a folder of unrelated projects.

## The four deliverables

| Deliverable      | Location       | Toolchain       | What it is                                                                                                                                                                                     | Ships on                         |
| ---------------- | -------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **Desktop app**  | (root) `src/`  | Bun             | The product: menu-bar capture, Electron + React + Vite + TypeScript                                                                                                                            | `vX.Y.Z` (desktop)               |
| **STT helper**   | `stt/`         | Swift / SwiftPM | A **sub-component of the desktop app**: builds `inkfish-stt`, bundled into `Inkfish.app/Contents/Resources/bin/` and spawned by the main process. Not a standalone app; no release of its own. | inside the desktop app           |
| **Android**      | `android/`     | npm / Expo      | A **sibling product**: the Expo + React Native companion. Own APK, own tag, own release; pairs with the Mac over LAN sync.                                                                     | `android-vX.Y.Z` (its own train) |
| **CLI launcher** | `packages/cli` | Bun / Node      | A **distribution shim for the desktop app**: `bunx @pylotlight/inkfish` downloads the desktop release zip. No dependencies of its own.                                                         | with the desktop app (npm)       |

They are **not four equal peers.** The desktop app is the thing; `stt/` is a
native dependency _of_ the desktop app, `packages/cli` is a launcher _for_
the desktop app, and `android/` is the only genuinely separate application.
`stt/` and `packages/cli` ride the desktop release train; `android/` ships on
its own.

## Two toolchains, one loose monorepo

- The root package (`inkfish`), `stt/` (SwiftPM) and `packages/cli` all run on
  **Bun** — the repository has a single `bun.lock`.
- `android/` is the exception: an independent **npm** package with its own
  `package-lock.json` (and a temporary `node-forge` / Zod override). There is
  **no `workspaces` field** — this is a _loose_ monorepo, a directory of
  co-located, individually-installable projects, not a single Bun workspace
  tree. `DEVELOPING.md` states it plainly: "Everything uses Bun; … the Android
  app in `android/` is the exception."

## The shared layer: `src/shared/`

This is what makes it a real monorepo. `src/shared/` is a single source of
truth for the platform-agnostic logic, imported by **both** the desktop app
(from `src/main`, `src/renderer`, `src/preload`) and the **Android** app (via
relative imports like `../../../src/shared/routing`). A change in a shared
module compiles into both apps at once.

The Android app imports the platform-agnostic subset:

```
src/shared/{routing, daily, journal, tags, title-sync, note-move, images, autosave, update-feed, sync}
```

The rest of `src/shared/` — the `mini-window*`, `stt*`, `proxy*`, `window-geometry`,
`menubar`, `systemAudio`, `command-palette` and `sidebar` modules — is
**desktop-only** (Electron/OS specific) but lives in the same directory because it
is at minimum shared _within_ the desktop app (main ↔ preload ↔ renderer).

This coupling is what the CI and release tooling key on:

- **CI** — `typecheck-android` runs when `android/` **or** `src/shared/`
  changes (the Android typecheck sees the shared modules it imports).
- **Release** — a change under `src/shared/` is counted for **both** trains,
  and `src/shared/sync/**` in particular defaults to a coordinated
  desktop + android release: the phone and the Mac must speak the same sync
  protocol.

## The shared _data_ contract

Beyond shared code, the two apps agree on an **on-disk vault format** — plain
`.md` notes plus `assets/` and `staging/{inbox,daily,undone}/`. Android's
`src/lib/format.ts` _ports_ the desktop's `src/main/vault.ts` rules so the
frontmatter keys, path shapes and daily-note format are byte-compatible; sync
is then a plain encrypted file copy, not a protocol translation.

## Release trains (independent)

Desktop and Android ship on separate tag series; `stt/` and `packages/cli`
ride the desktop train:

```
desktop  vX.Y.Z          → release.yml         (mac dmg/zip + Homebrew cask + npm launcher)
android  android-vX.Y.Z  → android-release.yml (signed APK, never "latest")
--app both               → both
```

With no `--app`, the script looks at what changed since each app's last tag
(android = `android/**` + `src/shared/**`; desktop = the rest that ships +
`src/shared/**`; docs/tests/`*.md`/`Casks`/`.github` don't count) and offers
a suggestion. Details in [docs/releasing.md](releasing.md).

---

## The desktop app

Three processes, one bridge. (`src/shared/` is the desktop's within-app
contract layer _and_ the cross-app layer above; the desktop-only modules in it
are listed alongside the rest below.)

```
main (Node, Electron)  ──ipcMain.handle──┐
                                          ├─▶ preload (contextBridge → window.api)
renderer (React, browser) ──invoke───────┘
```

- `src/main/index.ts` — app lifecycle only: single-instance lock, vault init
  (`ensureVault` + seed projects + `openDb` + re-scan), `whenReady` wiring,
  global capture shortcuts (via `main/shortcuts.ts`), quit handling. No business logic.
- `src/main/shortcuts.ts` — configurable capture / append-to-today global shortcuts
  (`userData/shortcuts.json`, Settings → Shortcuts): live re-register, keeps the old one when
  the new one is refused (invalid, taken by another app, already an Inkfish shortcut).
- `src/main/window.ts` — main `BrowserWindow` creation, `showWindow`/`hideWindow`, vibrancy state.
- `src/main/popover.ts` — 380×520 capture popover (`vibrancy: popover`,
  frameless, always-on-top, hides on blur), `togglePopover()` near the cursor.
- `src/main/tray.ts` — menu bar icon. Left-click pops quick capture under the
  icon, right-click shows the menu (New note / Append to today / Open today /
  Show Inkfish / Quit). `src/main/menubar.ts` (menu bar mode) decides whether
  the icon exists, what a click opens, and hides the Dock icon.
- `src/main/mini-window.ts` — floating always-on-top note windows (pop out
  with ⇧⌘M), tucking, snapping, per-display geometry.
- `src/main/vault.ts` — vault writer: inbox `.md` + frontmatter, project
  routing, undo (`.undone`), assets, Teams `.vtt` parsing. `.md` files are the
  source of truth; nothing here deletes raw.
- `src/main/db.ts` — sqlite index (`node:sqlite` + FTS5, `inkfish.db` in app
  data, a cache rebuilt from the notes), in-memory fallback. Embeddings column reserved for sqlite-vec.
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
