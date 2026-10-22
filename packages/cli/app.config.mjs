// Everything app-specific lives here. lib/ is generic (ported as-is from Surffish's packages/cli):
// to reuse this launcher for another app, copy packages/cli, edit this object, the package.json
// name/bin, and the README. Nothing in lib/ is Inkfish-specific (types.mjs only uses it in examples).

/** @type {import('./lib/types.mjs').AppConfig} */
export default {
  // Shown in messages and the progress UI.
  displayName: 'Inkfish',
  // The command name (package.json "bin") and the cache folder: ~/.cache/<id>/<version>.
  id: 'inkfish',
  // npm package name, used in help text ("npx @pylotlight/inkfish@0.2.10").
  packageName: '@pylotlight/inkfish',
  // GitHub owner/repo that publishes releases tagged v<version>.
  repo: 'PylotLight/Inkfish',
  // Env var prefix for overrides: INKFISH_CLI_ASSET_URL, INKFISH_CLI_SHA256, INKFISH_CLI_CACHE_DIR.
  envPrefix: 'INKFISH_CLI',
  // Release asset name for a version. Must match what release.yml uploads (electron-builder
  // artifactName "${productName}-${version}-${os}-${arch}.${ext}", mac zip target, arm64 only).
  assetName: (version) => `Inkfish-${version}-mac-arm64.zip`,
  // The .app inside the zip (opened with `open`).
  appBundle: 'Inkfish.app',
  // Approximate download size, only for the "first run" line before the server reports a size.
  approxSizeMB: 141,
  // `${process.platform}-${process.arch}` keys that have a release build.
  supported: ['darwin-arm64'],
  // Friendly messages for everything else. `default` covers any key not listed.
  unsupported: {
    'darwin-x64': 'Inkfish only ships for Apple silicon (M-series) Macs. Intel Macs are not supported yet.',
    'win32-x64': 'There is no Windows build of Inkfish yet.',
    'win32-arm64': 'There is no Windows build of Inkfish yet.',
    linux:
      'There is no Linux build of Inkfish. It runs from source for development:\n' +
      'https://github.com/PylotLight/Inkfish/blob/main/DEVELOPING.md',
    default: 'Inkfish only ships for macOS on Apple silicon for now.'
  },
  // Printed after launching from a fresh download.
  firstRunNote:
    'Inkfish is unsigned and not notarized. If macOS says it is damaged, see\n' +
    'https://github.com/PylotLight/Inkfish#install',
  // --uninstall: what the app itself writes outside the launcher cache. Listed (and with --all
  // deleted) only when it exists. Paths come from src/main (userData = Application Support/Inkfish
  // via build.productName, safeStorage for the AI key + paired-phone keys) plus what macOS keeps per
  // bundle id (same list as the cask's zap stanza, plus Electron's cache/log dirs).
  uninstall: {
    // `pgrep -x` name of the main process; --uninstall refuses while it's running.
    processName: 'Inkfish',
    // package.json build.appId
    bundleId: 'com.pylotlight.inkfish',
    userData: [
      {
        path: '~/Library/Application Support/Inkfish',
        what: 'config, note index, inbox staging, trash, AI + sync settings, window state'
      },
      { path: '~/Library/Caches/Inkfish', what: 'Electron caches' },
      { path: '~/Library/Caches/com.pylotlight.inkfish', what: 'macOS cache' },
      { path: '~/Library/HTTPStorages/com.pylotlight.inkfish', what: 'macOS network storage' },
      { path: '~/Library/Preferences/com.pylotlight.inkfish.plist', what: 'macOS preferences' },
      { path: '~/Library/Saved Application State/com.pylotlight.inkfish.savedState', what: 'window restore state' },
      { path: '~/Library/Logs/Inkfish', what: 'logs' }
    ],
    // For the prompts: "Inkfish's own data is still here (…)". Notes are never part of it.
    dataSummary: 'settings, note index, inbox captures, trash, AI and sync keys',
    // Electron safeStorage key (encrypts the saved AI API key and paired-phone sync keys).
    keychain: [{ service: 'Inkfish Safe Storage', what: 'safeStorage key' }],
    notes: [
      'Your notes are NOT touched: they live in your notes folder (~/Inkfish by default, or wherever',
      'you picked in Settings). Delete that yourself if you really want them gone.',
      'Downloaded transcription models live in ~/Library/Application Support/FluidAudio/Models (shared',
      'with other FluidAudio apps), so they are left alone; remove them in Settings first if you want.',
      'Dev builds use their own profiles (~/Library/Application Support/Inkfish Dev, "Inkfish <name>"); those are not touched.',
      'Installed with Homebrew too? brew uninstall --cask inkfish'
    ]
  },
  // Rotated under the progress bar while downloading, between the "what's happening" lines.
  tips: [
    'Inkfish lives in the menu bar: ⌥Space from anywhere captures a thought (change it in Settings → Shortcuts)',
    'Everything lands in the inbox first, then AI files it into the right project note',
    'Notes are plain markdown in a folder you own (~/Inkfish by default)',
    "Voice notes transcribe on-device with Apple's speech engine or Parakeet models",
    'Pair the Android app with a QR code (Settings → Sync) to sync notes over your LAN, no server',
    'Bring your own AI: Anthropic or any OpenAI-compatible server (Ollama, LM Studio, LiteLLM)'
  ]
}
