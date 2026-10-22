# @pylotlight/inkfish

Run [Inkfish](https://github.com/PylotLight/Inkfish), the menu-bar quick-capture notes app that files your captures into project notes, without installing it:

```bash
bunx @pylotlight/inkfish
npx @pylotlight/inkfish
```

The first run downloads the Inkfish release zip from GitHub Releases, verifies its SHA-256, unpacks it into `~/.cache/inkfish/<version>` and opens it. Every run after that opens the cached copy immediately, with no network access.

Requires macOS 12+ on Apple silicon (M-series), and Bun or Node.js 18.17+. On other platforms the launcher prints what is and isn't supported and exits.

## What a first run looks like

```text
◆ Inkfish v0.2.10 · first launch of this version, downloading once (141.0 MB)
  ███████████████████░░░░░░░░░░░  64%  90.2 MB / 141.0 MB  11.8 MB/s  ETA 4s
  › Cached in ~/.cache/inkfish so the next launch is instant
```

The last line rotates every 2 seconds between what the launcher is doing and a few Inkfish tips. When the download finishes:

```text
  ✓ downloaded 141.0 MB in 12s (11.8 MB/s)
  ✓ verified sha256 9bf9c59fc00e…438c59 (matches the npm package (recorded at publish))
  ✓ unpacked with ditto to ~/.cache/inkfish/0.2.10
  → launching Inkfish v0.2.10
  remove it later with bunx @pylotlight/inkfish --uninstall
```

Piped output, `CI=true` or `TERM=dumb` switch to plain log lines without escape codes, and `NO_COLOR` drops the colour. Ctrl+C during the download stops cleanly and deletes the partial file.

## Usage

```text
bunx @pylotlight/inkfish [options] [app args]
bunx @pylotlight/inkfish@0.2.10      run a specific release
inkfish [options]                    after bun add -g @pylotlight/inkfish (or npm i -g)

--latest        run the newest GitHub release instead of this package's version
--path          print the cached .app path for the resolved version and exit
--clear-cache   delete every cached download
--uninstall     delete the cached downloads, print what else is left and how to remove it
--purge         same as --uninstall --all: also delete Inkfish's own data (asks first)
-y, --yes       with --uninstall --all: don't ask
--no-launch     download, verify and unpack, but don't open the app
-v, --version   print the launcher version and the Inkfish version it runs
-h, --help      help
```

`npx` works anywhere `bunx` does. Anything else is passed to Inkfish. Put `--` in front of an argument the launcher would otherwise take, such as `-- --version`.

| Environment             | Effect                                                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `XDG_CACHE_HOME`        | cache base directory (default `~/.cache`)                                                                                         |
| `INKFISH_CLI_CACHE_DIR` | exact cache directory                                                                                                             |
| `GITHUB_TOKEN`          | used for GitHub API calls, which only `--latest` or a version without a recorded checksum need (60 unauthenticated calls an hour) |
| `NO_COLOR`, `CI`        | no colour / plain output                                                                                                          |

## How it verifies the download

The npm version always equals the Inkfish version it launches. When the release workflow publishes the package, it writes `release.json` into it with the zip's SHA-256 (GitHub's asset digest, cross-checked by downloading the zip once). The package is published with npm provenance, so that checksum is tied to the workflow run that produced it. The launcher hashes the zip as it streams and refuses to unpack anything that doesn't match.

`--latest`, or a release without a recorded checksum, uses the GitHub releases API asset `digest` instead (or a `SHA256SUMS` asset if a release has one). With no checksum at all, it stops.

## Unsigned app

Inkfish isn't signed or notarized yet. Files downloaded by Bun or Node don't get macOS's `com.apple.quarantine` flag, so Gatekeeper's "damaged" dialog doesn't appear. If something did add the flag, the launcher removes it from the cached app and says so.

## Proxies

Under Bun, downloads can't go through a `socks5://` `HTTPS_PROXY`, because Bun's fetch only supports http(s) proxies. Use npx, or unset it.

## Uninstall

```bash
bunx @pylotlight/inkfish --uninstall          # or npx
```

This deletes the launcher's download cache (`~/.cache/inkfish`, or `$XDG_CACHE_HOME/inkfish` / `$INKFISH_CLI_CACHE_DIR`), which holds the app itself, and then prints what's still on disk with the commands to remove it. Quit Inkfish first: it refuses to run while the app is open.

What Inkfish itself leaves behind, all in your home folder:

| Path                                                                  | What                                                                       |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `~/Library/Application Support/Inkfish`                               | config, note index, inbox staging, trash, AI + sync settings, window state |
| `~/Library/Caches/Inkfish`, `~/Library/Caches/com.pylotlight.inkfish` | caches                                                                     |
| `~/Library/HTTPStorages/com.pylotlight.inkfish`                       | macOS network storage                                                      |
| `~/Library/Preferences/com.pylotlight.inkfish.plist`                  | macOS preferences                                                          |
| `~/Library/Saved Application State/com.pylotlight.inkfish.savedState` | window restore state                                                       |
| `~/Library/Logs/Inkfish`                                              | logs                                                                       |
| keychain item `Inkfish Safe Storage`                                  | the key that encrypts your saved AI API key and paired-phone sync keys     |

To delete those too:

```bash
bunx @pylotlight/inkfish --uninstall --all    # asks y/N first; add --yes to skip that
bunx @pylotlight/inkfish --purge --yes        # same thing, shorter
```

It only removes those exact paths (plus `defaults delete com.pylotlight.inkfish` and the keychain item), never anything else. Note that Application Support holds inbox captures that haven't been filed into a note yet and Inkfish's Trash (deleted notes you could still restore): file or restore anything you want to keep first.

The cache removal only deletes what the launcher put there (version folders and partial downloads). If `INKFISH_CLI_CACHE_DIR` points at a folder with other things in it, those are left alone.

Left for you:

- **Your notes.** They live in your notes folder (`~/Inkfish` by default, or wherever you picked) as plain markdown, and the launcher never touches them.
- Downloaded transcription models in `~/Library/Application Support/FluidAudio/Models` (shared with other FluidAudio apps). Remove them from Settings → Voice Engine first if you want them gone.
- bun and npm cache the launcher package itself (a few KB): `bun pm cache rm` (clears bun's whole package cache), or `rm -rf ~/.npm/_npx` for npx. `bun remove -g @pylotlight/inkfish` if you installed it globally.
- A Homebrew install is separate: `brew uninstall --cask inkfish`.

---

Working on the launcher itself? See [DEVELOPING.md](https://github.com/PylotLight/Inkfish/blob/main/packages/cli/DEVELOPING.md).
