# bun-electron-app

Pure [Bun](https://bun.com) + [Electron](https://www.electronjs.org/) + React + Vite + TypeScript —
kitchen-sink demo and starter template.

Created with `bun init` (bun v1.3.14). Bun is the only CLI used — package manager, runtime for
scripts, and test runner. Note: Electron itself still embeds Node for its main/preload processes;
Bun manages deps and tooling, it does not replace Electron's Node runtime.

## Features

- **Kitchen sink tab** — IPC ping, versions, form controls, modal dialog patterns
- **Tray** — `src/main/tray.ts` owns a system tray with Show/Hide/test-notification/Quit menu.
  Left-click pops the menu — it never auto-shows the window. Icons in `assets/` generated
  dependency-free via `bun run assets`
- **macOS glass** — `vibrancy: fullscreen-ui` + transparent window + hidden-inset traffic lights
  on darwin, CSS `backdrop-filter` fallback everywhere else (Glass tab). The renderer shell must
  stay translucent — any opaque full-window background covers the native blur. The Glass tab also
  lets you switch the vibrancy material live via `win.setVibrancy()`
- **App & dock hiding** — `Hide` uses real `app.hide()` (⌘H behavior); the Tray tab adds
  `app.dock.hide()` tray-only mode. Restoring always re-shows the app (`app.show()`) so the
  window can't get stuck hidden
- **Agent mode tab** — starter pattern for agentic UI: goal → visible plan → real tool calls
  through the preload bridge (`sys.info`, `notify.send`) → streaming log, with cancel and
  hide-to-tray while running
- **Starter bones** — single-instance lock, `contextBridge` preload API with types,
  `out/` builds, `postinstall` guaranteeing the Electron binary under Bun, typecheck, MIT
  license, minimal CI (`bun install` → typecheck → build)

## Setup (bun only)

```bash
bun install
```

## Dev

```bash
bun run dev
```

## Typecheck

```bash
bun run typecheck
```

## Build (renderer + main + preload → `out/`)

```bash
bun run build
```

## Start built app

```bash
bun run start
```

## Troubleshooting

### `bun run dev` fails with `Error: spawn ENOEXEC`

This comes from `electron-vite` spawning the Electron binary at
`node_modules/electron/dist/...`. `ENOEXEC` means that file isn't a runnable program —
almost always because the Electron binary download is missing or incomplete. The `electron`
npm package does not contain the binary; it is downloaded by its install script, which Bun
does not run automatically.

Recovery (bun only):

```bash
rm -rf node_modules/electron/dist
bun install   # runs the root `postinstall` → `install-electron`, checksum-verified
```

Then sanity-check the binary before running dev:

```bash
# macOS (Apple Silicon): a valid Mach-O arm64 executable with +x
file "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ls -l "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
cat node_modules/electron/dist/version   # must match package.json (e.g. 44.5.1)
```

If the version mismatches or the file isn't a Mach-O executable, repeat the recovery steps
above. Corporate proxies/AV quarantining `Electron.app` can also cause this — re-download and
allow-list the project directory if it recurs.

## Structure

- `electron.vite.config.ts` — electron-vite build config
- `assets/` — tray icons (`bun run assets` regenerates via `scripts/make-tray-icon.ts`)
- `scripts/make-tray-icon.ts` — dependency-free PNG generator (bun only)
- `src/main/index.ts` — Electron main process (window, vibrancy, single instance, IPC)
- `src/main/tray.ts` — system tray + context menu
- `src/preload/index.ts` — contextBridge API (`window.api`) with types
- `src/renderer/` — React + Vite renderer (`index.html` entry, tabbed views in `src/`)
- `.github/workflows/ci.yml` — install → typecheck → build
