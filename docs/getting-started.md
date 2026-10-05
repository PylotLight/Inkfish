# Getting started

Inkfish repo: menu-bar quick capture with AI inbox-to-project flow.
Everything below uses Bun only.

## Run it

```bash
bun install   # also guarantees the Electron binary via postinstall
bun run dev   # dev server + app (wrapped: cleans terminal state on exit)
```

Press **Opt-Space** anywhere for the capture popover, type, `Cmd-Enter` to
save into the inbox. First launch shows 3-step onboarding (notes location,
mic test, shortcut confirm).

## Verify it

```bash
bun run typecheck
bun run build     # → out/{main,preload,renderer}/
bun run start     # launch the built app
```

## Storage: notes home + hidden app data

Two separate homes:

- **Notes home** (you pick it in the setup wizard — nothing is created
  until you confirm): plain `.md` + assets only. A fresh empty folder, or an
  existing vault (Obsidian etc.) whose `.md` files get indexed on import —
  Inkfish adds `inbox/`, `projects/<name>/`, `assets/` inside and never
  touches your files otherwise. This is the source of truth, always.
- **App data** (hidden, platform-standard `userData` — `~/.config/Inkfish`
  on Linux, `~/Library/Application Support/Inkfish` on mac): `inkfish.json`
  (which notes folder), `inkfish.db` (FTS5 + metadata + embeddings **cache**,
  rebuilt from files by Rescan any time), downloaded models later.

Move the notes home later from Settings → Notes home.
Overrides for testing: `INKFISH_VAULT=/tmp/notes INKFISH_DATA=/tmp/appdata bun run dev`.

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
