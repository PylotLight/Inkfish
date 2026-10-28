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
bun lint           # built-in JS/TS lint; use the Bun canary channel (see below)
bun run format:check # check formatting with Bun (also available as bun fmt --check)
bun run typecheck  # bun check (tsc-compatible) over src/, scripts/ and config
bun run build      # builds the Swift helper (stt/bin/inkfish-stt), then out/{main,preload,renderer}/
bun run start      # launch the built app
```

Run `bun lint` with the latest Bun canary to match CI. Switch an existing Bun installation with `bun upgrade --canary`, and return to stable afterward with `bun upgrade --stable`; see [Bun's canary build instructions](https://bun.com/docs/installation#canary-builds). The repository's `.bun-version` remains the stable pin for the regular test, typecheck and build jobs.

## Scripts

| Script                          | What it does                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| `lint`                          | `bun lint`: built-in JavaScript and TypeScript linter (run with Bun canary)                 |
| `format` / `format:check`       | format the repository / check formatting with Bun                                           |
| `dev`                           | `bun scripts/dev.ts`: dev server + app with terminal cleanup on exit                        |
| `dev:bare`                      | raw `electron-vite dev` (no wrapper)                                                        |
| `build`                         | Swift transcription helper + production build into `out/`                                   |
| `start`                         | launch the built app (`electron ./out/main/index.js`)                                       |
| `preview`                       | serve the built renderer only                                                               |
| `clean`                         | remove `out/`                                                                               |
| `test`                          | `bun test`                                                                                  |
| `test:cli`                      | only the bunx launcher's tests (`packages/cli`)                                             |
| `typecheck`                     | `bun check`                                                                                 |
| `typecheck:android`             | `bun check -p android` (needs `npm ci` in `android/` first)                                 |
| `stt:build`                     | build only the Swift helper (`scripts/build-stt.ts`)                                        |
| `bench:stt`                     | speech-to-text benchmark (`scripts/bench-stt.ts`)                                           |
| `test:electron-ai`              | smoke Electron's native AI (Prompt API) handler                                             |
| `assets`                        | regenerate tray PNGs from `assets/Inkfish_logo.png`                                         |
| `icon`                          | regenerate the app icon (`build/icon.png` + `build/icon.icns`)                              |
| `dist` / `dist:mac` / `dist:ci` | package with electron-builder into `release/`                                               |
| `release`                       | `bun scripts/release.ts`: bump, changelog, tag (see [docs/releasing.md](docs/releasing.md)) |
| `postinstall`                   | runs automatically: downloads the Electron binary Bun skips                                 |

## Dev profile (run dev beside the installed app)

Any unpackaged run (`bun run dev`, `bun run start`, `electron .`) is **Inkfish Dev**, a separate profile, so you can keep the release app open while you hack:

|                                                              | Release (`Inkfish.app`)               | Dev (`bun run dev`)                                                                      |
| ------------------------------------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| App name / userData                                          | `Inkfish`                             | `Inkfish Dev` (`~/Library/Application Support/Inkfish Dev`)                              |
| Single-instance lock                                         | its own                               | its own (both run at once)                                                               |
| Notes folder default                                         | `~/Inkfish`                           | `~/Inkfish Dev` (never adopts `~/Inkfish` on its own)                                    |
| Settings, AI keys, menu bar, mini windows, onboarding        | its own                               | its own, starts fresh                                                                    |
| LAN sync                                                     | `:47821`, its own pairing + device id | `:47822`, separate pairing, device named `<host> (Inkfish Dev)`                          |
| Capture shortcuts (defaults, change in Settings → Shortcuts) | `⌥Space` / `⇧⌥Space`                  | `⌃⌥Space` / `⇧⌃⌥Space`                                                                   |
| Mini window toggle                                           | `⌃⌥M`                                 | off until you set one                                                                    |
| Tell-apart                                                   |                                       | `DEV` pill by the logo, window title, Dock badge `dev`, tray title `dev` (mac) / tooltip |

- You _can_ point dev at your real notes by picking `~/Inkfish` in onboarding or Settings, but it has to be an explicit pick, and then both apps write to it.
- `INKFISH_PROFILE=<name> bun run dev` gives another isolated profile (`Inkfish <name>`), e.g. a second dev instance or a clean QA run. It works on a packaged app too.
- `INKFISH_SHORTCUTS=off` registers no global shortcuts for that run (a shortcut changed in Settings is still saved, just not registered).
- An explicit `--user-data-dir` (smoke tests) is left alone.
- `INKFISH_VAULT=/tmp/notes INKFISH_DATA=/tmp/appdata bun run dev` overrides the notes folder / app data dir.

## Storage: notes folder + hidden app data

- **Notes folder** (picked in onboarding, nothing is created until you confirm): finished outputs only. Plain `.md` notes in top-level folders (`work/`, `personal/`, …), `assets/` attachments, plus whatever was already there. A "project" is just a folder name. An existing vault (Obsidian etc.) gets indexed on import and is otherwise left alone. This is the source of truth.
- **App data** (`userData`: `~/Library/Application Support/Inkfish`): `inkfish.json` (which notes folder), `inkfish.db` (FTS5 + metadata cache, rebuilt from the files by Rescan), `staging/` (raw inbox captures + day-log scratch), `trash/`, `undone/`, and the per-feature settings files (AI provider, sync peers, menu bar, mini windows, window state).
- Secrets (AI API key, sync peer keys) are sealed with Electron's async `safeStorage` (keychain item `Inkfish Safe Storage`), never written in plaintext.

## CI

`.github/workflows/ci.yml` on PRs and main: `bun test` + typecheck + build on Linux, a lint/format job (`bun lint` and `bun run format:check`) on Bun canary, the bunx launcher job (`cli`), the Android typecheck when `android/` or `src/shared/` changes, and the Swift helper build on macOS when `stt/` changes. The main verification job continues to use `.bun-version`; the dedicated lint/format job intentionally uses `bun-version: canary`. Repo variables `INKFISH_LINUX_RUNNER` / `INKFISH_MAC_RUNNER` / `INKFISH_CI_CACHE` point it at self-hosted runners (see the comment at the top of the workflow).

## Releasing

Mac and Android release independently:

- `bun scripts/release.ts patch --app desktop`: bumps `package.json`, regenerates `CHANGELOG.md` with git-cliff, tags `vX.Y.Z`. The tag runs `.github/workflows/release.yml` (macOS arm64 zip + dmg, GitHub release, Homebrew cask, npm launcher).
- `bun scripts/release.ts patch --app android`: tags `android-vX.Y.Z` (patch from the last android tag). The tag runs `.github/workflows/android-release.yml` (signed APK, GitHub release, never marked latest).
- `--app both` does both; leave `--app` off to see what changed per app since its last tag and pick (`src/shared/sync/**` changes suggest both). `--yes` skips the prompt, `--push` pushes, `--dry-run` changes nothing.

### Pre-releases (test builds)

Add `--pre` to cut a test build instead of a real release, for either app or both:

```fish
bun scripts/release.ts patch --app both --pre --yes   # v0.2.15-beta.1 + android-v0.2.8-beta.1
bun scripts/release.ts patch --app both --pre --yes   # again: v0.2.15-beta.2 + android-v0.2.8-beta.2
bun scripts/release.ts patch --app both --yes         # done testing: v0.2.15 + android-v0.2.8
```

- Versions are semver pre-releases, `X.Y.Z-beta.N`. The first `--pre` takes the normal bump (patch by default) and adds `-beta.1`; running it again bumps N; a normal release afterwards ships plain `X.Y.Z`. A bigger bump (`minor --pre`) goes past an open beta. `--pre=rc` gives `-rc.N`; `prerelease` as the first word works the same as `--pre`. `--dry-run` shows the plan.
- Desktop test builds bump `package.json` (the app has to know its own version) but leave `CHANGELOG.md` alone: `cliff.toml` ignores pre-release tags, so the final release's section covers everything since the last stable one.
- Change detection still counts from each app's last **stable** tag.
- Workflows: any tag with a `-` is a GitHub **pre-release**, never marked latest, with a "test build" note at the top of the release notes (changes since the last stable tag). The Mac workflow updates the Homebrew cask like a stable release (brew users get the test build) but skips the npm job, so `bunx @pylotlight/inkfish` users never get a test build. Android gets a signed APK as usual. A beta shares its final's `versionCode`, so beta → beta → final each install over the last.
- In the apps: test builds are only offered with **Beta updates** on (Mac: Settings → About & updates; Android: Settings › Updates). It's off by default, and "latest" ignores pre-releases. Someone on a beta with the toggle off isn't offered anything until the final `X.Y.Z` ships (no downgrade), then gets that. Versions compare as SemVer 2.0 everywhere (`0.2.15-beta.1 < 0.2.15-beta.2 < 0.2.15`).
- Sync doesn't care: the handshake compares integer `protocol` / `minPeer` numbers, never app versions, so a beta talks to a stable build of the same protocol and never shows "update phone" / "update Mac" just for being a beta.
- npm: skipped for pre-releases on purpose. An npm version can't be reused once published, and a dist-tag slip would move `latest` for every `bunx` user; testers get the Mac build from the GitHub pre-release. (The publish step would still use the `next` dist-tag if it ever ran on one.)

Release notes carry a `tested with android-vX` (Mac) / `tested with vY` (Android) line. Sync stays compatible across mixed versions through the `protocol` / `minPeer` handshake; a too-old side shows "update phone" / "update Mac" on its sync badge. Details, the tap, signing and the npm setup: [docs/releasing.md](docs/releasing.md).

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
