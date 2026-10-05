# Getting started

Inkfish repo: menu-bar quick capture with AI inbox-to-project flow.
Everything below uses Bun only.

## Run it

```bash
bun install   # also guarantees the Electron binary via postinstall
bun run dev   # dev server + app (wrapped: cleans terminal state on exit)
```

Press **Opt-Space** anywhere for the capture popover, type, `Cmd-Enter` to
squirt into the inbox. First launch shows 3-step onboarding (vault location,
mic test, shortcut confirm).

## Verify it

```bash
bun run typecheck
bun run build     # → out/{main,preload,renderer}/
bun run start     # launch the built app
```

## Vault

Defaults to `~/Inkfish/` (`inbox/`, `projects/<name>/`, `assets/`,
`inkfish.db`). Override for testing: `INKFISH_VAULT=/tmp/vault bun run dev`.

## Scripts

| Script | What it does |
|--------|--------------|
| `dev` | `bun scripts/dev.ts` — dev server + app with terminal cleanup on exit |
| `dev:bare` | Raw `electron-vite dev` (no wrapper) |
| `build` | Production build into `out/` |
| `start` | Launch the built app (`electron ./out/main/index.js`) |
| `preview` | Serve the built renderer only |
| `clean` | Remove `out/` |
| `test` | `bun test` — vault/AI/DB unit tests (also runs in CI) |
| `typecheck` | `tsc --noEmit` over `src/`, `scripts/`, and config |
| `assets` | Regenerate tray PNGs, zero dependencies |
| `icon` | Regenerate app icon (`build/icon.png` + `build/icon.icns`), zero dependencies |
| `dist` / `dist:mac` / `dist:linux` / `dist:ci` | Package via electron-builder → `release/` |
| `release` | `bun scripts/release.ts` — cut a release, tag it (see `docs/releasing.md`) |
| `postinstall` | Runs automatically: downloads the Electron binary Bun skips |

## Install paths (for users, not devs)

- Homebrew: `brew tap pylotlight/inkfish https://github.com/PylotLight/Inkfish.git && brew install --cask inkfish`
- npm/Bun: `bunx inkfish` / `npx inkfish`
- Cutting a release: `bun run release` — see `docs/releasing.md`.
