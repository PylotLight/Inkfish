# Developing the launcher (`packages/cli`)

Not published to npm (only `README.md` ships, plus `bin/`, `lib/`, `app.config.mjs` and `release.json`). The user-facing docs are in [README.md](README.md).

The launcher is plain ES modules with no dependencies and no build step. It isn't part of the Electron app or the root `bun install`. It's a port of Surffish's `packages/cli` (PylotLight/Surffish#267, #268): `lib/` is the same generic code, only [`app.config.mjs`](app.config.mjs), `bin/inkfish.mjs`, `package.json` and the docs are Inkfish-specific. Fixes to `lib/` are worth sending back to Surffish.

## What's Inkfish-specific

[`app.config.mjs`](app.config.mjs): display name, command/cache id (`inkfish`, `~/.cache/inkfish`), npm name (`@pylotlight/inkfish`), GitHub repo, release asset pattern (`Inkfish-<version>-mac-arm64.zip`, from electron-builder's `artifactName` in the root `package.json`), `.app` name, supported platforms and messages, the rotating tips, and `uninstall` (data paths, bundle id `com.pylotlight.inkfish`, process name, keychain item).

The README's Uninstall table mirrors `uninstall.userData` / `keychain` in `app.config.mjs`; update both when the app starts writing somewhere new (paths come from `app.getPath(...)` uses in `src/main`, the cask's `zap` stanza, and `safeStorage`). Never add the notes folder: that's the user's data, not app data.

## Development

```bash
bun run test:cli                                  # from the repo root (or: bun test ./test here)
bun packages/cli/bin/inkfish.mjs --help
```

Simulate a download on any OS (no launch outside macOS):

```bash
INKFISH_CLI_ASSET_URL=http://127.0.0.1:8765/app.zip INKFISH_CLI_SHA256=<sha256> \
INKFISH_CLI_VERSION=0.2.10 bun packages/cli/bin/inkfish.mjs --no-launch
```

Stamp it the way the release job does (writes `release.json`, sets the version; undo afterwards):

```bash
bun packages/cli/scripts/prepare-publish.mjs --version 0.2.10
cd packages/cli; and bunx npm pack --dry-run; and git checkout package.json; and rm release.json
```

`ci.yml`'s `cli` job runs the tests, smokes the bin, and does that stamp + `npm pack --dry-run` against the latest release on every push and PR (it isn't path-filtered).

## Publishing

The `npm` job in `.github/workflows/release.yml` publishes this package after the GitHub release and the cask bump succeed. It runs on `ubuntu-latest` and uses npm trusted publishing (OIDC), so there's no `NPM_TOKEN`. It sets the package version to the tag's version (npm version == app version), writes `release.json` with the zip's digest (cross-checked by downloading the zip), and runs `npm publish --provenance --access public`. A prerelease tag (`v1.2.3-beta.1`) publishes under the `next` dist-tag.

Until the repo variable `NPM_PUBLISH` is `true`, every release runs a dry run instead (stamp + `npm publish --dry-run`, no auth needed) and warns, so the job is exercised without publishing anything.

One-time setup:

1. **First publish by hand.** A trusted publisher can only be added to a package that already exists. The `@pylotlight` scope belongs to the `pylotlight` npm account.
   ```fish
   bunx npm login                                   # as pylotlight
   cd packages/cli
   bun scripts/prepare-publish.mjs --version 0.2.10 --verify-download
   bunx npm publish --access public                 # no --provenance from a laptop
   git checkout package.json; rm release.json       # leave the repo at 0.0.0-dev
   ```
2. **Add the trusted publisher** on npmjs.com → `@pylotlight/inkfish` → Settings → Trusted publishing → GitHub Actions: organization or user `PylotLight`, repository `Inkfish`, workflow filename `release.yml`, no environment. Tick **Allow npm publish** (configurations created after Sep 3 2026 only allow `npm stage publish` by default). Or from the CLI (npm 11.15+, 2FA on): `bunx npm@latest trust github @pylotlight/inkfish --repo PylotLight/Inkfish --file release.yml --allow-publish`. A new configuration expires unless it completes a publish within 2 days, so do this shortly before the next release.
3. **Turn the job on:** set the repo variable `NPM_PUBLISH=true` (Settings → Secrets and variables → Actions → Variables, or `gh variable set NPM_PUBLISH --body true -R PylotLight/Inkfish`).
4. Optional, after the first CI publish works: package Settings → Publishing access → "Require two-factor authentication and disallow tokens".
