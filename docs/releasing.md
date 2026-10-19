# Releasing

Releases are tag-driven and per app: the Mac app and the Android app each
have their own tag series and workflow, so either can ship without the other.

| app | tag | workflow |
| --- | --- | --- |
| desktop (Mac) | `vX.Y.Z` | `.github/workflows/release.yml` |
| android | `android-vX.Y.Z` | `.github/workflows/android-release.yml` (never marked latest) |

```bash
bun scripts/release.ts                       # show what changed per app since its last tag, ask which to ship
bun scripts/release.ts patch --app android   # android-v0.2.5 → android-v0.2.6 (tag only)
bun scripts/release.ts patch --app desktop   # v0.2.12 → v0.2.13 (package.json + CHANGELOG + tag)
bun scripts/release.ts patch --app both      # both, android tag on the desktop release commit
bun scripts/release.ts --yes --push          # CI / no prompt: ship whatever changed
bun scripts/release.ts --dry-run             # plan + changelog preview, change nothing
```

Default bump is **patch**, from each app's own last tag. `minor | major | x.y.z`
work too (`x.y.z` needs a single `--app`); `auto` lets git-cliff pick
(desktop only). Nothing is pushed without `--push`; otherwise it prints the
`git push origin HEAD <tags>` to run.

Change detection (no `--app`): `android/**` counts for android, everything
else that ships counts for desktop, `src/shared/**` counts for both. Docs,
`*.md`, tests, `Casks/`, `.github/` and the release script itself don't count.
Anything in `src/shared/sync/**` suggests **both** so the phone and the Mac
stay on the same sync protocol.

Every release body ends with a `tested with <other app's tag>` line
(desktop: newest `android-v*`; android: newest `v*`), so you can see which
pair was tested together. Write hand-edited notes with the same line.

### Mixing versions (sync protocol handshake)

The Mac's `/v1/hello` advertises `protocol` + `minPeer`, the phone sends the
same as `x-inkfish-protocol` / `x-inkfish-min-peer` headers. Missing = protocol
1, so older builds keep working. Bump `PROTOCOL` in
`src/shared/sync/protocol.ts` when the wire format changes and raise
`MIN_PEER` only when an older peer would actually break: the side that's
too old then shows **update phone** / **update Mac** on the sync badge
(Mac sidebar, phone header) instead of failing quietly.

Desktop, end to end (android is just the tag → APK → GitHub release, see
`android/build/README.md`):

1. **`scripts/release.ts`** bumps `package.json`, regenerates `CHANGELOG.md`
   with [git-cliff](https://git-cliff.org) (conventional commits → Keep a
   Changelog sections, compare links included), commits
   `chore(release): vX.Y.Z` and creates the annotated tag `vX.Y.Z`.
2. **`.github/workflows/release.yml`** (triggered by the tag push):
   - builds macOS artifacts (`zip` + `dmg`, Apple silicon / arm64 only) on
     `macos-15`, or the self-hosted Mac named by the `INKFISH_MAC_RUNNER` repo variable
   - generates release notes with git-cliff and publishes the GitHub release
   - renders the Homebrew cask (version + sha256) and commits it to
     `Casks/inkfish.rb` on main — see below
   - publishes the bunx/npx launcher `@pylotlight/inkfish` to npm (dry run
     until `NPM_PUBLISH` is set) — see below

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

## npm launcher (`bunx @pylotlight/inkfish`)

`packages/cli` is a tiny launcher package: on first run it downloads this
release's `Inkfish-<version>-mac-arm64.zip`, checks it against the SHA-256
baked into the package at publish time, caches it in `~/.cache/inkfish` and
opens it. The npm version always equals the app version.

The release workflow's `npm` job publishes it after the cask bump, from
`ubuntu-latest` with npm trusted publishing (OIDC + provenance, no token).
It's gated by the repo variable `NPM_PUBLISH=true`; until then each release
does a dry run (`npm publish --dry-run`) and warns. One-time setup (first
manual publish, trusted publisher on npmjs.com, the variable):
[packages/cli/DEVELOPING.md](../packages/cli/DEVELOPING.md#publishing).

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
