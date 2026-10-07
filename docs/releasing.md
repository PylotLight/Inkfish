# Releasing

Releases are tag-driven: one local command cuts the release, one GitHub
Actions workflow does the rest.

```bash
bun run release            # let git-cliff pick the next version from commits
bun run release minor      # or force a bump: patch | minor | major | 1.2.3
bun run release --dry-run  # preview version + changelog, change nothing
git push --follow-tags     # or pass --push to do it in one go
```

What happens, end to end:

1. **`scripts/release.ts`** bumps `package.json`, regenerates `CHANGELOG.md`
   with [git-cliff](https://git-cliff.org) (conventional commits → Keep a
   Changelog sections, compare links included), commits
   `chore(release): vX.Y.Z` and creates the annotated tag `vX.Y.Z`.
2. **`.github/workflows/release.yml`** (triggered by the tag push):
   - builds macOS artifacts (`zip` + `dmg`, Apple silicon / arm64 only) on `macos-14`
   - generates release notes with git-cliff and publishes the GitHub release
   - renders the Homebrew cask (version + sha256s) and commits it to
     `Casks/inkfish.rb` on main — see below

Prerequisites locally: `git-cliff` on PATH (`brew install git-cliff` or
`cargo install git-cliff`).

Changelog grouping lives in `cliff.toml`: `feat` → Added, `fix` → Fixed,
`perf` → Performance, `refactor`/`style` → Changed, `docs` → Documentation,
`revert` → Reverted; `chore`/`ci`/`build`/`test` are skipped and anything
else lands in Other. Commits with a `!` (`feat!: ...`) get a **breaking**
marker and make the suggested bump major.

## Homebrew tap (this repo — no setup)

A Homebrew tap is just a git repo with a `Casks/` directory, so this repo
doubles as the tap: `Casks/inkfish.rb` lives on main, and the release
workflow re-renders it from `Casks/inkfish.rb.tmpl` (via
`scripts/render-cask.ts`) and commits it back with the built-in
`GITHUB_TOKEN` — no second repo, no access tokens, nothing to set up. Token
pushes don't re-trigger workflows, so the tap commit can't start a loop, and
its `chore(tap):` message is excluded from the changelog by `cliff.toml`.

Users install with:

```bash
brew tap pylotlight/inkfish https://github.com/PylotLight/Inkfish.git
brew install --cask inkfish
```

(The full URL is needed because the repo isn't named `homebrew-*`; without an
explicit URL `brew tap` would look for `PylotLight/homebrew-inkfish`.)

One caveat: the workflow pushes the cask commit straight to main. If you ever
turn on branch protection for main, either allow GitHub Actions to bypass it
or the `homebrew` job needs a PAT — the rest of the release is unaffected.

Until the first release is published, the committed cask has placeholder
checksums and the download URLs 404 — that's expected; the `v0.1.0` release
fills in real values.

## npm / Bun launcher

`package.json` declares `bin: { inkfish: ./bin/inkfish.mjs }`, so once
published to npm the app also runs via:

```bash
bunx inkfish
npx inkfish
```

The launcher boots the checked-in `out/` build with a pinned Electron
(on-demand fetch on first run, cached after). Publishing to npm is manual for
now (`npm publish` after the release workflow, once `out/` is built) —
Homebrew + GitHub releases remain the primary distribution.

## Code signing (optional, later)

Artifacts ship unsigned for now: macOS Gatekeeper quarantines the download, and
on recent macOS (26/Tahoe especially) the first open can show
"“Inkfish” is damaged and can’t be opened" instead of the usual unsigned-app
warning. It means unsigned + quarantined, not a corrupt build. Workaround:
click Cancel, then `xattr -cr /Applications/Inkfish.app` and open again
(right-click → Open on first launch). Homebrew deprecated and then removed
its `--no-quarantine` flag (v5/v6), so manual `xattr` is now the only path.

To sign and notarize later, add these secrets and electron-builder picks them
up automatically — no workflow changes needed (the `mac` target already sets
`hardenedRuntime` + entitlements in `package.json` / `build/entitlements.mac.plist`):

- `CSC_LINK` (base64 Developer ID Application cert), `CSC_KEY_PASSWORD`
- `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`

Until then, don't submit the cask to the core
`homebrew-cask` repo; the personal tap is the right home for unsigned builds.
