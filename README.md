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
- `src/main/index.ts` — Electron main process
- `src/preload/index.ts` — contextBridge API (`window.api`)
- `src/renderer/` — React + Vite renderer (`index.html` entry)
