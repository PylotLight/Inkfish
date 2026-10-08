# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.2] - 2026-10-08

### Added

- Restore from trash on Mac and Android (Settings › Trash) (#35) ([3647ed5](https://github.com/PylotLight/Inkfish/commit/3647ed5c55f9585f13cac6d1a0cca000703a9b8b))

## [0.2.1] - 2026-10-08

### Fixed

- **(main)** Don't bundle @noble/ciphers so electron-vite's ESM __dirname shim lands at top level (#34) ([4d3ae34](https://github.com/PylotLight/Inkfish/commit/4d3ae34693bafc5b454c51ca6e6e27bcbf5b31f4))

## [android-v0.2.1] - 2026-10-08

### Added

- **(sync)** LAN pairing + sync between Mac and Android (#33) ([1fcd623](https://github.com/PylotLight/Inkfish/commit/1fcd62397965e88b9b8e4bb4b07593d8e3f48dbe))

## [android-v0.2.0] - 2026-10-07

### Added

- **(home)** Full-width card-light redesign, drop duplicate capture/meeting buttons, sparing accent (#1) ([e359691](https://github.com/PylotLight/Inkfish/commit/e35969147c0ef43a42befb02328da158fc9a8273))
- **(capture)** Borderless single-surface composer, icon toolbar, sparing accent (#2) ([8282359](https://github.com/PylotLight/Inkfish/commit/82823591fa9e2408135b612ecd6996f71a2183a3))
- **(settings)** Audio devices + tests; heavier toast frost (#5) ([f4b484b](https://github.com/PylotLight/Inkfish/commit/f4b484b2cc459b3687c212bf565eb26badb92b37))
- **(stt)** In-app engine picker + compare — Apple Speech, SpeechAnalyzer, Parakeet v3/Redux/Ultra/v2 (#6) ([25d60de](https://github.com/PylotLight/Inkfish/commit/25d60deb50f3066fd902310173e12aa97b15f08f))
- Settings sidebar + Voice Engine page with FluidVoice model lineup; drop whisper-cpp (#7) ([10c2c0f](https://github.com/PylotLight/Inkfish/commit/10c2c0f6a249da2f15e74ae668a93333c998dd6d))
- In-app Web voice engines (Redux, Parakeet v2, Moonshine, Whisper) + Moonshine live captions (#8) ([341193b](https://github.com/PylotLight/Inkfish/commit/341193b7625be78389740e7d8773e44987ae322c))
- Redux live transcription + meeting capture (mic + Mac audio, Me/Them) (#10) ([b7255fd](https://github.com/PylotLight/Inkfish/commit/b7255fd93a036f20073b85f4c753a1ab673f0623))

### Fixed

- **(voice)** Mac mic permission + bundled Apple Speech STT (inkfish-stt) (#3) ([5da975a](https://github.com/PylotLight/Inkfish/commit/5da975aa9b0a9250ce5f9dae98be860cc7fd166e))
- **(voice)** Build Apple Speech engine automatically; tidy capture toast (#4) ([d6833aa](https://github.com/PylotLight/Inkfish/commit/d6833aa0be29bc819aca23651b88bfe5a8afe127))

### Other

- Auto bun install when bun.lock is newer than node_modules (#9) ([305bb7b](https://github.com/PylotLight/Inkfish/commit/305bb7b6d0ac3a2e9214670b56fc1fc917484b90))
- Drop Whisper web engines, show actual runtime per transcription, warm engines (#11) ([5e1588f](https://github.com/PylotLight/Inkfish/commit/5e1588f859d9dcdd77464bbeef30184f0fbf7ee3))
- Auto-scroll live captions instead of clipping with ellipsis (#12) ([37cf9ed](https://github.com/PylotLight/Inkfish/commit/37cf9ede7276b7f2f6255e0f1037909b45671120))
- Live two-speaker capture saved as filed meeting notes; sidebar footer + search tidy (#13) ([e8b8cb5](https://github.com/PylotLight/Inkfish/commit/e8b8cb51011d061fa29a1a3aa22521e764f737ba))
- Keep display video track alive so system audio keeps flowing; CATap loopback; per-channel level meters + reasons (#14) ([f3a470c](https://github.com/PylotLight/Inkfish/commit/f3a470c769a207114f7132e3062d58f152725a5a))
- Audio-only system capture via Core Audio tap; fix stt helper product path (#15) ([09822e6](https://github.com/PylotLight/Inkfish/commit/09822e6caa1621aafd05926cebbe9ef537e45eef))
- Drop Intel: arm64-only builds, cask and release pipeline (#17) ([a335797](https://github.com/PylotLight/Inkfish/commit/a335797927e73b15fad00a7f56c19c547e7512e4))
- Bundle Libron (OFL) as an optional text font (#18) ([b64c032](https://github.com/PylotLight/Inkfish/commit/b64c0324c6a56eb84174b9f33e6141e781e36273))
- Voice Engine: one-click benchmark with accuracy (WER) and speed per model; bench:stt script (#19) ([5893841](https://github.com/PylotLight/Inkfish/commit/58938411b2a225522658a9151a6a378969a709c7))
- Voice Engine: download progress, pause/resume/retry, mirror; in-app comparison table with size, errors, speed (#20) ([515f21f](https://github.com/PylotLight/Inkfish/commit/515f21fd33402a73d0fc6492283490c8e4cb7daa))
- Fill the window and reflow by width (sections side by side, two-column model list) (#21) ([15a6001](https://github.com/PylotLight/Inkfish/commit/15a6001c31b4115b4139a027bdeb677905d254ef))
- Voice Engine: fix JSON-as-transcript benchmark scores, real Moonshine/Redux/Parakeet Web download progress, bench warm-up + per-engine timeout, chunk Redux Web (#23) ([3792eac](https://github.com/PylotLight/Inkfish/commit/3792eac3e11053a8bb3877265f3be9849d6f68e1))
- Voice Engine: real download progress for every model — % plus MB, per-phase bars, Web byte counts (#24) ([34c61b1](https://github.com/PylotLight/Inkfish/commit/34c61b1a6a9bf4ff3295fe2dd6ceb7738f1fb4ac))
- Apple Foundation Models note cleanup + Settings › Apple Intelligence (#22) ([9bf2ca9](https://github.com/PylotLight/Inkfish/commit/9bf2ca92bb950885752c40893e5738db662ed9f2))
- Voice Engine: Quick/Deep benchmark (Aussie earnings calls + hard read), warm-up/load/size + error breakdown, hide models, Redux on GPU, remove Moonshine (#25) ([71d38ff](https://github.com/PylotLight/Inkfish/commit/71d38ffa7a1d1ba0be1ddada43a466de76cc94a4))
- Skip FluidAudio's ANE warm-up compile on download (stuck at 'Optimising for the Neural Engine · 0%'); fetch raw files + vocab, load encoder on GPU; transcribe loads from disk only (#26) ([99aa456](https://github.com/PylotLight/Inkfish/commit/99aa4561032671fc85607e50ecee9932caa82e4b))
- Share-target capture + cluster signed-release pipeline ([85e98be](https://github.com/PylotLight/Inkfish/commit/85e98bee25eaf46d8e487aade59f3862768758cf))
- Android build: permanent shared android-release-keystore Secret ([b91de30](https://github.com/PylotLight/Inkfish/commit/b91de30852d153f941c3090fdb5ee1e6d4fa6bb4))
- Android build: keystore must be JKS, fail loud on keytool errors ([9e52860](https://github.com/PylotLight/Inkfish/commit/9e52860b4feae60e0051a9ea0eec0cc9d5cda1c6))
- Ignore local APK output dir ([1b1a4d9](https://github.com/PylotLight/Inkfish/commit/1b1a4d9b251d75fb55fa0c74761f7b09098b80dd))
- Replace expo-av with expo-audio (fix startup crash) ([8abbe68](https://github.com/PylotLight/Inkfish/commit/8abbe688635656bf8e92c636644f5f91466d556c))
- App icon from existing logo assets ([332278a](https://github.com/PylotLight/Inkfish/commit/332278abcf21378b86ddfe2cd98d70fd1eb38ab6))
- Add missing expo-asset peer dep (expo-doctor 21/21) ([7e6ddf0](https://github.com/PylotLight/Inkfish/commit/7e6ddf09a9532329155135861f6c835d1068fa8a))
- Add index.js entry that registers root component (fix startup crash) ([9240ef8](https://github.com/PylotLight/Inkfish/commit/9240ef88ba703e6c8669ac1b8c4edabcbb8753fa))
- Obsidian-clean UI + Mac glass chrome ([48d58b5](https://github.com/PylotLight/Inkfish/commit/48d58b5c486ecaf41cc732fa96fdd36bb181a670))
- Dynamic themes + real safe-area insets ([6a11f13](https://github.com/PylotLight/Inkfish/commit/6a11f13dd73d54b4c604ec5f42b784735b1ac5e1))
- File drawer replaces Notes tab ([d461b37](https://github.com/PylotLight/Inkfish/commit/d461b3774a3ef9f0a81358048472cda9e0473744))
- Merge pull request #27 from PylotLight/android-client ([0314872](https://github.com/PylotLight/Inkfish/commit/0314872e23646e7af061478bd5b88847d605d952))
- Obsidian-style UI pass — Home page, Lucide icons, capture sheet, autosave editor, local-day daily log (#28) ([459e130](https://github.com/PylotLight/Inkfish/commit/459e1303ed692715083101cbf1b69562d39048d7))
- Sync design: Mac ↔ Android P2P, LAN only v1 (#30) ([7ca9d08](https://github.com/PylotLight/Inkfish/commit/7ca9d089598fee2d4839db6f965b0ba03bd96ff2))
- Sync core: pure-TS manifest planning, diff3, note/daily merge, sha256 (shared by Mac + Android) (#31) ([aee33f4](https://github.com/PylotLight/Inkfish/commit/aee33f48467e76cd6f208818e3844dd61420e94f))
- In-app updates from GitHub Releases + CI release workflow (#32) ([807dab1](https://github.com/PylotLight/Inkfish/commit/807dab1203e91d9e5815ce6dedc1c9dffe08aa98))

## [0.1.0] - 2026-10-07

### Added

- Kitchen demo — tray, mac glass, agent mode, starter template ([0802458](https://github.com/PylotLight/Inkfish/commit/080245881760ce25bcb0329da13bde70d031e37a))
- P0 inbox-to-project MVP — tray popover, vault, sqlite FTS, AI router, glass 3-pane ([8b3fdfd](https://github.com/PylotLight/Inkfish/commit/8b3fdfd44342bbe3670436d8c9f61686bc5bd3bd))
- Vault-first onboarding — location picked before any setup ([f7190d7](https://github.com/PylotLight/Inkfish/commit/f7190d7d6dc2273a32907734f45a4d33b72f789a))
- Notes-home/app-data split, combined composer, perf + motion pass ([1af34e5](https://github.com/PylotLight/Inkfish/commit/1af34e598286ef27d4cf14a0943402bd58716b14))
- Sidebar+stage layout, settings with themes/accents, read-first editor ([49f0e65](https://github.com/PylotLight/Inkfish/commit/49f0e65666a2d0c0a345f7b0a9b907cd9b214fe8))
- Home dashboard, folder tree, Blobfish-style settings page + quit ([1a49a9a](https://github.com/PylotLight/Inkfish/commit/1a49a9a783d8b346b9b049aef8c4aa71a90c03ad))
- Obsidian tree with files, CRUD + 7d trash, tray popover, asset protocol, metadata ([ac0401f](https://github.com/PylotLight/Inkfish/commit/ac0401f1fc1169845405bfa50ccb5e00b7db56ae))
- Native-only STT (python removed), daily notes + tray shortcuts + profiles, editor folding + collapsible code, vault/app-data separation ([a89ea33](https://github.com/PylotLight/Inkfish/commit/a89ea330bf5111a621a70daccb9b3a18c15bc4c3))
- Vault holds finalised outputs only, no app dirs ([b86d9bc](https://github.com/PylotLight/Inkfish/commit/b86d9bc3bdb3d456c74c8befbadd4e95b2bf1b4c))
- Replace all app logos with Inkfish squid logo ([f4ae0da](https://github.com/PylotLight/Inkfish/commit/f4ae0da05ed12b0704bd12e9f897e2096ca45d44))

### Changed

- Remove Ollama — Apple Intelligence -> rules only ([6f06a48](https://github.com/PylotLight/Inkfish/commit/6f06a4876ee9cfd39ce90de12db633f1d1487086))

### Documentation

- Getting-started, architecture, vibrancy/tray, troubleshooting guides ([82ac197](https://github.com/PylotLight/Inkfish/commit/82ac197180f90e3665b829f4c7afbb8a27e91b68))
- Non-Python STT options research, decision deferred ([38bf6db](https://github.com/PylotLight/Inkfish/commit/38bf6db3eb9eb54ce74d811a1f042b5c00d29071))

### Fixed

- Ensure electron binary via postinstall (bun skips electron postinstall) ([66bfe1d](https://github.com/PylotLight/Inkfish/commit/66bfe1d50353a4df1fb7002905b8e1b4fbbe808f))
- Real window vibrancy, tray menu on click, app/dock hide, mock-style glass UI ([2ff6b3b](https://github.com/PylotLight/Inkfish/commit/2ff6b3b6c4c95b95c59d69f80c2d9147395d8f26))
- Dev wrapper drains terminal reply bytes on exit (no more prompt garbage) ([6db5ca0](https://github.com/PylotLight/Inkfish/commit/6db5ca095c4242b5611f5f356701969b08343609))
- Lock app shell to viewport, scroll only the view pane ([50fa111](https://github.com/PylotLight/Inkfish/commit/50fa1114da61dc62dfcbe8d2d372f13411b2d5ff))
- Search flex blowup, filename titles + overrides, tree collapse, editor diagnostics ([ba359da](https://github.com/PylotLight/Inkfish/commit/ba359dae74ee95353c35c8d4f8844bfa1a18a612))
- Fix editor spacing, tabs, borders, sidebar ([795d96c](https://github.com/PylotLight/Inkfish/commit/795d96c37cc201aeef5bc75245a5fd91232e669b))

### Other

- Pure bun + electron + react + vite + ts ([6fe44ab](https://github.com/PylotLight/Inkfish/commit/6fe44ab36ea92416c707c8097f2b11bd9dca758d))
- Visible caret + autofocus; settings: Obsidian-style font group (families, size slider, Ctrl+scroll quick zoom) ([8556500](https://github.com/PylotLight/Inkfish/commit/8556500e667c9439a03b499a54081b3894cd3bbe))
- Tabs + live view: multi-file tab strip with pinning/persistence; Live click-to-edit replaces read/edit/split, Raw keeps source ([7469282](https://github.com/PylotLight/Inkfish/commit/7469282f31f73ae98b9639003a6f57099487836c))
- Sidebar cleanup: stroke icons replace emoji, slim file rows (parent + time), hide zero-count kinds, prompt-based new folder, slimmer footer ([134a98d](https://github.com/PylotLight/Inkfish/commit/134a98df616a7a2432e236db138360e5451a6efc))
- Sidebar brand: app icon next to title (same pattern as Blobfish) ([fc528b6](https://github.com/PylotLight/Inkfish/commit/fc528b6bafd55dc4229a004b54778f2a37469aaa))
- Sidebar Obsidian pass: bare text tree rows, chevron-only folders, indent guides, top icon toolbar, single-line kind chips ([d162537](https://github.com/PylotLight/Inkfish/commit/d162537fceb4133c00031dfa3f5976f3360a1738))
- Bigger icon, aligned line numbers, font dropdowns, code highlight + copy ([bdbd1bb](https://github.com/PylotLight/Inkfish/commit/bdbd1bb5159460a2934ac173c6d0f62846649bde))

[0.2.2]: https://github.com/PylotLight/Inkfish/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PylotLight/Inkfish/compare/v0.2.0...v0.2.1
[android-v0.2.1]: https://github.com/PylotLight/Inkfish/compare/android-v0.2.0...android-v0.2.1
[android-v0.2.0]: https://github.com/PylotLight/Inkfish/compare/v0.1.0...android-v0.2.0
[0.1.0]: https://github.com/PylotLight/Inkfish/releases/tag/v0.1.0

<!-- generated by git-cliff -->
