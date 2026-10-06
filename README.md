# Inkfish

Menu-bar quick capture with AI auto-sort. Capture fast — AI sorts it later.
Bun + Electron + React + Vite + TypeScript.

> Status: P0 MVP (local only, free) — tray popover → staging inbox →
> auto-routed top-level notes. See [docs/inkfish-mvp.md](docs/inkfish-mvp.md).

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

## Docs

- `docs/inkfish-mvp.md` — the MVP spec: flow, P0/P1, glass UI, AI, DB, build order
- `docs/getting-started.md` — setup, scripts, checklist
- `docs/architecture.md` — processes, bridge rules, how to add views/IPC/tray items
- `docs/vibrancy-and-tray.md` — translucency rules, tray behavior, hiding semantics
- `docs/releasing.md` — cutting a release (`bun run release`), Homebrew tap, signing
- `docs/troubleshooting.md` — terminal garbage, `spawn ENOEXEC`, opaque window, stale preload

Cutting a release: `bun run release` — see
[docs/releasing.md](docs/releasing.md).
