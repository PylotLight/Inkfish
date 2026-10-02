# Electron Starter (Bun)

[Bun](https://bun.com) + [Electron](https://www.electronjs.org/) + React + Vite + TypeScript —
a foundational desktop-app template with tray, native macOS glass, and an agent-mode example.
Bun is the only CLI: package manager, script runner, runtime for tooling. (Electron's
main/preload processes still run on its embedded Node; Bun manages deps and tooling.)

## Quickstart

```bash
bun install   # also guarantees the Electron binary via postinstall
bun run dev   # dev server + app (wrapped: cleans terminal state on exit)
bun run typecheck
bun run build     # → out/{main,preload,renderer}/
bun run start     # launch the built app
```

Other scripts: `dev:bare` (raw `electron-vite dev`), `preview` (serve built renderer),
`clean` (remove `out/`), `assets` (regenerate tray icons).

## Make it yours

When cloning for a real app, touch these and nothing else:

1. `package.json` — `name`, `version`, `description`
2. `src/shared/config.ts` — `APP_NAME`, `APP_TAGLINE`, `APP_ID`, window size
3. `src/renderer/index.html` — `<title>`
4. `assets/` — replace tray icons (`bun run assets` regenerates from code, or drop in your own
   PNGs: `trayTemplate.png` for macOS, `tray.png` elsewhere)
5. `LICENSE` — copyright holder
6. `.github/workflows/ci.yml` — keep as-is (install → typecheck → build)

## Structure

- `src/shared/config.ts` — app identity + window defaults (imported by all processes)
- `src/shared/types.ts` — IPC contracts (`SysInfo`, `GlassState`, `VibrancyName`)
- `src/main/index.ts` — app lifecycle only (single instance, ready/quit wiring)
- `src/main/window.ts` — window creation, show/hide, vibrancy state
- `src/main/tray.ts` — system tray + context menu (left-click pops the menu, never auto-shows)
- `src/main/ipc.ts` — all renderer→main handlers
- `src/preload/index.ts` — typed `window.api` bridge (mirrors `ipc.ts`)
- `src/renderer/src/App.tsx` — sidebar shell + top bar
- `src/renderer/src/views/` — example sections: `Kitchen` (controls/IPC), `TrayDemo`
  (tray/dock/notifications), `Glass` (vibrancy + mock dashboard), `Agent` (agentic UI pattern)
- `scripts/dev.ts` — dev runner (drains terminal reply bytes on exit, see below)
- `scripts/make-tray-icon.ts` — dependency-free tray PNG generator

## Extending

**New section:** add a view in `src/renderer/src/views/`, register it in the `TABS` array in
`App.tsx`. Done — nav, layout, and glass styling come free.

**New IPC tool:** add `ipcMain.handle('domain:action', …)` in `src/main/ipc.ts`, expose it in
`src/preload/index.ts`, call it via `window.api`. Shared payload types go in
`src/shared/types.ts`. Never import main-process modules from the renderer — type-only imports
from `src/shared/` only.

**Tray:** edit the menu template in `src/main/tray.ts`. Window helpers live in
`src/main/window.ts` (`showWindow`, `hideWindow`).

**Agent tools:** the Agent view calls real bridge tools (`sys.info`, `notify.send`). Add yours
the same way (IPC + preload), then list them in the plan steps.

**Vibrancy rule:** the renderer shell must stay translucent — any opaque full-window background
covers the native `NSVisualEffectView` blur. `backgroundColor: '#00000000'` + `transparent` +
`vibrancy` in `window.ts`, translucent CSS in `index.css`. Non-mac platforms get the CSS
`backdrop-filter` fallback automatically.

## Troubleshooting

### Garbage characters (`^[[?62;22c`, `^[[9;1R`, `^[[11;rgb:...`) after exiting dev

On startup Electron probes terminal capabilities; the terminal answers by injecting reply bytes
into stdin, and after `^C` your shell reads them as keystrokes. `bun run dev` runs through
`scripts/dev.ts`, which drains those bytes on exit. If you kill the process from another
terminal, run `reset`. `bun run dev:bare` skips the wrapper.

### `bun run dev` fails with `Error: spawn ENOEXEC`

The `electron` npm package ships without its binary; it is downloaded by an install script that
Bun does not run. Recovery:

```bash
rm -rf node_modules/electron/dist
bun install   # root postinstall → checksum-verified install-electron
```

Then verify: `cat node_modules/electron/dist/version` matches `package.json`, and on macOS
`file node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` reports a Mach-O
executable.
