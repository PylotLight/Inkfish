# bun-electron-app

Pure [Bun](https://bun.com) + [Electron](https://www.electronjs.org/) + React + Vite + TypeScript.

Created with `bun init` (bun v1.3.14). Bun is the only CLI used — package manager, runtime for
scripts, and test runner. Note: Electron itself still embeds Node for its main/preload processes;
Bun manages deps and tooling, it does not replace Electron's Node runtime.

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

## Structure

- `electron.vite.config.ts` — electron-vite build config
- `src/main/index.ts` — Electron main process
- `src/preload/index.ts` — contextBridge API (`window.api`)
- `src/renderer/` — React + Vite renderer (`index.html` entry)
