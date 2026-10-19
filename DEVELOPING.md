# Developing Inkfish

Bun + Electron + React + Vite + TypeScript. Everything uses Bun; there's no Node.js toolchain to set up (the Android app in `android/` is the exception, see its README). The user-facing overview is in [README.md](README.md).

## Run it

```bash
bun install        # also fetches the Electron binary via postinstall (Bun skips electron's own)
bun run dev        # dev server + app (wrapped: cleans terminal state on exit)
```

⌥Space anywhere opens the capture window (⌃⌥Space for a dev run, see below), ⌘↩ saves to the inbox. First launch runs onboarding (notes folder, mic test, shortcut).

```bash
bun test           # unit tests (also runs packages/cli's tests)
bun run typecheck  # bun check (bun >= 1.4.3, tsc-compatible) over src/, scripts/ and config
bun run build      # builds the Swift helper (stt/bin/inkfish-stt), then out/{main,preload,renderer}/
bun run start      # launch the built app
```

## Scripts

| Script | What it does |
|--------|--------------|
| `dev` | `bun scripts/dev.ts`: dev server + app with terminal cleanup on exit |
| `dev:bare` | raw `electron-vite dev` (no wrapper) |
| `build` | Swift transcription helper + production build into `out/` |
| `start` | launch the built app (`electron ./out/main/index.js`) |
| `preview` | serve the built renderer only |
| `clean` | remove `out/` |
| `test` | `bun test` |
| `test:cli` | only the bunx launcher's tests (`packages/cli`) |
| `typecheck` | `bun check` |
| `typecheck:android` | `bun check -p android` (needs `npm ci` in `android/` first) |
| `stt:build` | build only the Swift helper (`scripts/build-stt.ts`) |
| `bench:stt` | speech-to-text benchmark (`scripts/bench-stt.ts`) |
| `test:electron-ai` | smoke Electron's native AI (Prompt API) handler |
| `assets` | regenerate tray PNGs from `assets/Inkfish_logo.png` |
| `icon` | regenerate the app icon (`build/icon.png` + `build/icon.icns`) |
| `dist` / `dist:mac` / `dist:ci` | package with electron-builder into `release/` |
| `release` | `bun scripts/release.ts`: bump, changelog, tag (see [docs/releasing.md](docs/releasing.md)) |
| `postinstall` | runs automatically: downloads the Electron binary Bun skips |

## Dev profile (run dev beside the installed app)

Any unpackaged run (`bun run dev`, `bun run start`, `electron .`) is **Inkfish Dev**, a separate profile, so you can keep the release app open while you hack:

| | Release (`Inkfish.app`) | Dev (`bun run dev`) |
|---|---|---|
| App name / userData | `Inkfish` | `Inkfish Dev` (`~/Library/Application Support/Inkfish Dev`) |
| Single-instance lock | its own | its own (both run at once) |
| Notes folder default | `~/Inkfish` | `~/Inkfish Dev` (never adopts `~/Inkfish` on its own) |
| Settings, AI keys, menu bar, mini windows, onboarding | its own | its own, starts fresh |
| LAN sync | `:47821`, its own pairing + device id | `:47822`, separate pairing, device named `<host> (Inkfish Dev)` |
| Capture shortcuts | `⌥Space` / `⇧⌥Space` | `⌃⌥Space` / `⇧⌃⌥Space` |
| Mini window toggle | `⌃⌥M` | off until you set one |
| Tell-apart | | `DEV` pill by the logo, window title, Dock badge `dev`, tray title `dev` (mac) / tooltip |

- You *can* point dev at your real notes by picking `~/Inkfish` in onboarding or Settings, but it has to be an explicit pick, and then both apps write to it.
- `INKFISH_PROFILE=<name> bun run dev` gives another isolated profile (`Inkfish <name>`), e.g. a second dev instance or a clean QA run. It works on a packaged app too.
- `INKFISH_SHORTCUTS=off` registers no global shortcuts for that run.
- An explicit `--user-data-dir` (smoke tests) is left alone.
- `INKFISH_VAULT=/tmp/notes INKFISH_DATA=/tmp/appdata bun run dev` overrides the notes folder / app data dir.

## Storage: notes folder + hidden app data

- **Notes folder** (picked in onboarding, nothing is created until you confirm): finished outputs only. Plain `.md` notes in top-level folders (`work/`, `personal/`, …), `assets/` attachments, plus whatever was already there. A "project" is just a folder name. An existing vault (Obsidian etc.) gets indexed on import and is otherwise left alone. This is the source of truth.
- **App data** (`userData`: `~/Library/Application Support/Inkfish`): `inkfish.json` (which notes folder), `inkfish.db` (FTS5 + metadata cache, rebuilt from the files by Rescan), `staging/` (raw inbox captures + day-log scratch), `trash/`, `undone/`, and the per-feature settings files (AI provider, sync peers, menu bar, mini windows, window state).
- Secrets (AI API key, sync peer keys) are sealed with Electron's async `safeStorage` (keychain item `Inkfish Safe Storage`), never written in plaintext.

## CI

`.github/workflows/ci.yml` on PRs and main: `bun test` + typecheck + build on Linux, the bunx launcher job (`cli`), the Android typecheck when `android/` or `src/shared/` changes, and the Swift helper build on macOS when `stt/` changes. Repo variables `INKFISH_LINUX_RUNNER` / `INKFISH_MAC_RUNNER` / `INKFISH_CI_CACHE` point it at self-hosted runners (see the comment at the top of the workflow).

## Releasing

`bun run release` bumps the version, regenerates `CHANGELOG.md` with git-cliff and tags `vX.Y.Z`. Pushing the tag runs `.github/workflows/release.yml`: macOS arm64 zip + dmg, GitHub release, Homebrew cask bump, then the npm launcher. Details, the tap, signing and the npm setup: [docs/releasing.md](docs/releasing.md).

## Repo map

- `src/main`, `src/preload`, `src/renderer`, `src/shared`: the Electron app ([docs/architecture.md](docs/architecture.md))
- `stt/`: the bundled Swift helper `inkfish-stt` (speech-to-text, Apple Intelligence, system audio tap) ([stt/README.md](stt/README.md))
- `android/`: the Expo Android companion app ([android/README.md](android/README.md))
- `packages/cli/`: the `bunx @pylotlight/inkfish` launcher ([packages/cli/DEVELOPING.md](packages/cli/DEVELOPING.md))
- `Casks/`: the Homebrew tap (rendered by the release workflow)

## Docs

- [docs/architecture.md](docs/architecture.md): processes, bridge rules, how to add views/IPC/tray items
- [docs/vibrancy-and-tray.md](docs/vibrancy-and-tray.md): translucency rules, tray behaviour, hiding semantics
- [docs/sync.md](docs/sync.md): Mac ↔ Android LAN sync design
- [docs/intelligence.md](docs/intelligence.md): on-device Apple Intelligence cleanup and filing
- [docs/stt-options.md](docs/stt-options.md): speech-to-text engines
- [docs/releasing.md](docs/releasing.md): cutting a release, Homebrew tap, signing, npm
- [docs/troubleshooting.md](docs/troubleshooting.md): terminal garbage, `spawn ENOEXEC`, opaque window, stale preload
- [docs/inkfish-mvp.md](docs/inkfish-mvp.md): the original MVP spec (historical)
