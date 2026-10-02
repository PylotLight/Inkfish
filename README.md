# Electron Starter (Bun)

Bun + Electron + React + Vite + TypeScript — a foundational desktop-app template with tray,
native macOS glass, and an agent-mode example. **This repo is a GitHub template:** start a
new app with **Use this template**, then follow `docs/getting-started.md`.

Bun is the only CLI: package manager, script runner, runtime for tooling. (Electron's
main/preload processes still run on its embedded Node; Bun manages deps and tooling.)

## Quickstart

```bash
bun install
bun run dev        # dev server + app
bun run typecheck
bun run build      # → out/{main,preload,renderer}/
bun run start      # launch the built app
```

## Included

- **Kitchen sink tab** — IPC ping, versions, form controls, dialog patterns
- **Tray** — menu on click (never auto-shows), Show/Hide/test-notification/Quit,
  dependency-free generated icons
- **macOS glass** — native `fullscreen-ui` vibrancy + transparent window, CSS fallback
  elsewhere, live material switcher
- **App & dock hiding** — real `app.hide()` and `app.dock.hide()` tray-only mode
- **Agent mode tab** — goal → visible plan → real bridge tools → streaming log
- **Starter bones** — single-instance lock, typed `contextBridge` bridge, shared
  config/types across processes, dev wrapper that cleans terminal state on exit,
  MIT license, CI

## Docs

- `docs/getting-started.md` — setup, scripts, make-it-yours checklist
- `docs/architecture.md` — processes, bridge rules, how to add views/IPC/tray items
- `docs/vibrancy-and-tray.md` — translucency rules, tray behavior, hiding semantics
- `docs/troubleshooting.md` — terminal garbage, `spawn ENOEXEC`, opaque window, stale preload
