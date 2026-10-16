# Inkfish

Menu-bar quick capture with AI auto-sort. Capture fast — AI sorts it later.
Bun + Electron + React + Vite + TypeScript.

> Status: P0 MVP (local only, free) — tray popover → staging inbox →
> auto-routed top-level notes. See [docs/inkfish-mvp.md](docs/inkfish-mvp.md).

![Inkfish home with fictional notes, folders, and inbox captures](docs/screenshots/home-synthetic-data.png)

*Example workspace and all visible notes are synthetic.*

## Install

**Homebrew (macOS):**

```bash
brew tap pylotlight/inkfish https://github.com/PylotLight/Inkfish.git
brew install --cask inkfish
```

Or download binaries (macOS dmg/zip, Apple Silicon + Intel) from
[Releases](https://github.com/PylotLight/Inkfish/releases). Builds are unsigned
for now — macOS Gatekeeper (stricter on macOS 26/Tahoe) may report
““Inkfish” is damaged and can’t be opened”. That means unsigned + quarantined,
not a bad build. Click Cancel (don't trash it), then clear the quarantine flag:

```bash
xattr -cr /Applications/Inkfish.app
```

and open again (right-click → Open on first launch).

**npm / Bun (convenience):**

```bash
bunx inkfish
npx inkfish
```

This downloads the npm package and launches the built app. On first run the
launcher fetches a pinned Electron via your own runner (`bunx`/`npx`, ~100 MB,
cached afterwards) — no separate install step. For the signed install prefer
Homebrew or a GitHub release asset above.

## Quickstart

```bash
bun install
bun run dev        # dev server + app
bun run typecheck
bun run build      # → out/{main,preload,renderer}/
bun run start      # launch the built app
```

Press **Opt-Space** anywhere to pop the capture window, type, `Cmd-Enter` to
save to a staging inbox. The background worker formats + routes it to a
top-level folder (`work/`, `personal/`, …). Your vault lives at `~/Inkfish/`
and holds finalised outputs only; raw inbox captures and day-log scratch
live in hidden app data. Plain `.md` files stay the source of truth.

## Dev profile (run dev beside the installed app)

Any unpackaged run (`bun run dev`, `bun run start`, `electron .`) is **Inkfish
Dev**, a separate profile, so you can keep the release app open while you hack:

| | Release (`Inkfish.app`) | Dev (`bun run dev`) |
|---|---|---|
| App name / userData | `Inkfish` | `Inkfish Dev` (`~/Library/Application Support/Inkfish Dev`) |
| Single-instance lock | its own | its own (both run at once) |
| Notes folder default | `~/Inkfish` | `~/Inkfish Dev` (never adopts `~/Inkfish` on its own) |
| Settings, AI keys, menu bar, mini windows, onboarding | its own | its own, starts fresh |
| LAN sync | `:47821`, its own pairing + device id | `:47822`, separate pairing, device named `<host> (Inkfish Dev)` |
| Capture shortcuts | `⌥Space` / `⇧⌥Space` | `⌃⌥Space` / `⇧⌃⌥Space` |
| Mini window toggle | `⌃⌥M` | off until you set one |
| Tell-apart | — | `DEV` pill by the logo, window title, Dock badge `dev`, tray title `dev` (mac) / tooltip |

- You *can* point dev at your real notes by picking `~/Inkfish` in onboarding
  or Settings, but it has to be an explicit pick, and then both apps write to it.
- `INKFISH_PROFILE=<name> bun run dev` gives another isolated profile
  (`Inkfish <name>`), e.g. a second dev instance or a clean QA run. It works on a
  packaged app too.
- `INKFISH_SHORTCUTS=off` registers no global shortcuts for that run.
- An explicit `--user-data-dir` (smoke tests) is left alone.
- `INKFISH_VAULT` / `INKFISH_DATA` still override the notes folder / app data dir.
- Before this, dev on macOS shared the release app's data folder (`inkfish` and
  `Inkfish` are the same folder on a case-insensitive disk), so the first dev
  run after this change starts with an empty profile and runs onboarding again.

## Docs

- `docs/inkfish-mvp.md` — the MVP spec: flow, P0/P1, glass UI, AI, DB, build order
- `docs/getting-started.md` — setup, scripts, checklist
- `docs/architecture.md` — processes, bridge rules, how to add views/IPC/tray items
- `docs/vibrancy-and-tray.md` — translucency rules, tray behavior, hiding semantics
- `docs/releasing.md` — cutting a release (`bun run release`), Homebrew tap, signing
- `docs/troubleshooting.md` — terminal garbage, `spawn ENOEXEC`, opaque window, stale preload

Cutting a release: `bun run release` — see
[docs/releasing.md](docs/releasing.md).
