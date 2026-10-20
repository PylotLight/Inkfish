# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.15] - 2026-10-20

### Added

- **(daily)** Clean daily notes — friendly title, empty start, compact '- HH:MM' entries, _italic_ fix, prev/next day (#89) ([91bb131](https://github.com/PylotLight/Inkfish/commit/91bb131448e661bbaf50e0e579df12fdf98522e1))
- **(release)** Prerelease test builds for desktop + android (--pre, beta updates toggle) (#88) ([f932066](https://github.com/PylotLight/Inkfish/commit/f93206698f6d7460b28f871af42dffade08b8425))
- **(journal)** Daily section on home + journal timeline (desktop + android) (#90) ([99fd5e3](https://github.com/PylotLight/Inkfish/commit/99fd5e3cb5e1c042dca431f3374b66ef55411970))

### Fixed

- **(sync)** Keep sidebar sync popover inside the sidebar/window (collision-aware placement, wrap long lines) (#87) ([280e6db](https://github.com/PylotLight/Inkfish/commit/280e6dbeb0b852e66613bc29a0442a8d1bc6e1a0))

### Performance

- **(android)** Instant startup + o(1) note open (saved index, no startup vault walks, fix dropped folders) (#86) ([16bd8fa](https://github.com/PylotLight/Inkfish/commit/16bd8fab68908835d5ae2157d69d6c1b039efe74))

## [0.2.14] - 2026-10-19

### Added

- **(sync)** Live progress + run history on phone and mac (header %, drawer bar, details sheet, popover, tray) (#84) ([d1b1bfb](https://github.com/PylotLight/Inkfish/commit/d1b1bfb835fc7b1d0771a6f38b509e5fa2dd6d13))
- **(sync)** Resilient + resumable sync (retry/backoff, chunked resume, expect checks, mac lock, fsync) + fault-injection tests (#85) ([27b7f7b](https://github.com/PylotLight/Inkfish/commit/27b7f7b5904c63aa840c2dc02b6c783ea70fd03a))

### Fixed

- **(sync)** Stop the push loop (mac case-insensitive paths), repair sync, live refresh, collapse history (#82) ([006ef3d](https://github.com/PylotLight/Inkfish/commit/006ef3dcc92fefef27210788123beb41cca7bd44))

### Performance

- **(sync)** ~5-90x faster syncs (one concurrent walk, streamed transfers, no re-reads) + bench (#83) ([2946656](https://github.com/PylotLight/Inkfish/commit/2946656bffbb2093e1ea7a0e0fa6ae91dba6e407))

## [0.2.13] - 2026-10-19

### Added

- **(release)** Per-app releases + sync protocol handshake (#81) ([d4de2c4](https://github.com/PylotLight/Inkfish/commit/d4de2c4080dfd1d2714a37a7d6e3c75a613c7e84))

### Fixed

- **(ci)** Android-release skips setup-android on hosted runners, drop removed 'tools' package (#80) ([75fc5d9](https://github.com/PylotLight/Inkfish/commit/75fc5d95da285ccb188829516da0af46590f8f7f))

## [0.2.12] - 2026-10-19

### Added

- **(sync)** Live sync badge in sidebar footer + tray tooltip (#78) ([2f8eece](https://github.com/PylotLight/Inkfish/commit/2f8eece9b845f09740c7910e02fa7711a0a9312f))
- **(android)** Sync indicator in header + drawer (#79) ([0687026](https://github.com/PylotLight/Inkfish/commit/06870269d655f54420b2ac50d29cad4092f73be4))

### Fixed

- V0.2.11 review fixes (#75) ([11d13ad](https://github.com/PylotLight/Inkfish/commit/11d13ad5a4874aaaee0482c98493a9e42a05016b))
- Title sync perf + review leftovers (#77) ([03a5f49](https://github.com/PylotLight/Inkfish/commit/03a5f493d6ab6414a952565f880d2e5d1f350fe7))
- **(android)** Editor saves keep front matter and never clobber or drop sync changes (#74) ([1c744ce](https://github.com/PylotLight/Inkfish/commit/1c744ce15bf16a567f701718bcf1171787800349))
- **(android)** Renames sync as moves, real images, front matter titles/tags, rename relinks (#76) ([96f87be](https://github.com/PylotLight/Inkfish/commit/96f87be4ec7421bc4830c7d44fb07e488b521ff2))

## [0.2.11] - 2026-10-19

### Added

- **(notes)** File name follows the note title + inline-editable header title (#72) ([40480e9](https://github.com/PylotLight/Inkfish/commit/40480e9438cd1b9926175e389fc3750bf43fbd42))
- **(sidebar)** Hover rename/delete actions, inline rename, smart delete with glance + undo (#70) ([fd7f2a9](https://github.com/PylotLight/Inkfish/commit/fd7f2a919b425d4a82b48a67cd59cab559914ec1))
- **(cli)** Bunx/npx launcher @pylotlight/inkfish + gated npm publish in release, user-facing README + DEVELOPING.md (#73) ([acb7cda](https://github.com/PylotLight/Inkfish/commit/acb7cdaf2157a07e31aad77c6ea5a9db05ad00df))

### Fixed

- **(images)** Block images render below revealed source, click selects without revealing (#69) ([a92cae4](https://github.com/PylotLight/Inkfish/commit/a92cae4d294bb817db00f94c468976b1c898db2e))
- **(images)** Don't reveal ref source when the caret only landed on it from paste/resize (#71) ([546f1d9](https://github.com/PylotLight/Inkfish/commit/546f1d9cc33fbbcaa53d127bbef8c3b3fb665be6))

## [0.2.10] - 2026-10-16

### Added

- **(editor)** Copy embedded images (right-click menu + click-select ⌘C) (#67) ([e1d0e69](https://github.com/PylotLight/Inkfish/commit/e1d0e6958f6ce4289b7211bb3afd30eaa82905ab))
- **(notes)** Drag & drop in sidebar, Move to… folder picker, header breadcrumb + tag chips (#68) ([15d2bb9](https://github.com/PylotLight/Inkfish/commit/15d2bb93975cfd6577b89bec2c0041bea94b69a0))

## [0.2.9] - 2026-10-16

### Added

- **(meetings)** Pick system audio by app (Teams only, not your music) (#63) ([67d6328](https://github.com/PylotLight/Inkfish/commit/67d6328df0cf1ddf5bfa5bedcc6562c9fdb7f103))
- **(sidebar)** Obsidian-style titlebar toggle, icon ribbon when collapsed, polished file tree (#65) ([b5a3ca0](https://github.com/PylotLight/Inkfish/commit/b5a3ca09741e913c0e57a4e82a5dc1d584582ff1))
- **(sidebar)** Obsidian-style footer vault bar (vault chip + equal Settings/Quit icons) (#66) ([8e947af](https://github.com/PylotLight/Inkfish/commit/8e947afb9ff1b50009939bd1b9f16cc15e75097f))

### Fixed

- **(editor)** Keep image source hidden while resizing (#64) ([a4f14c1](https://github.com/PylotLight/Inkfish/commit/a4f14c1f20d8008c511e5c6a1ee437ebfa011d84))

## [0.2.8] - 2026-10-16

### Added

- **(editor)** Resize + drag-to-move inline images (Obsidian ![alt|300](src) widths) (#61) ([8c813ad](https://github.com/PylotLight/Inkfish/commit/8c813add7ee547d294d0a963e718bd8ed14a238f))

### Fixed

- **(ai)** Readable provider errors (not kErrorUnknown) + OpenAI Responses API support (#62) ([2244b04](https://github.com/PylotLight/Inkfish/commit/2244b040d978a58ed21e2be0f9b46e270674feb3))

## [0.2.7] - 2026-10-16

### Added

- **(mini)** Easier to find — pop-out buttons, tab tear-off, one-time tuck hint (#57) ([8b5a5f5](https://github.com/PylotLight/Inkfish/commit/8b5a5f5bb67af2c189e8e58c5235db3a8edd8a4a))
- **(ai)** Native Electron 45 AI (Prompt API) + Raw/Processed view and Process selection (#60) ([5216f26](https://github.com/PylotLight/Inkfish/commit/5216f2688704f74bd84af29d7bd8beea8f802326))

### Fixed

- **(editor)** Notes use the full pane width by default (#56) ([8b29119](https://github.com/PylotLight/Inkfish/commit/8b29119e3b710826d41326702242e389b1499f63))
- **(editor)** Obsidian-style autosave, never drop unsaved text on tab switch/new note (#58) ([bad691e](https://github.com/PylotLight/Inkfish/commit/bad691e6841ecc7bcb4e962a54b345599547c2c8))
- **(layout)** Full-pane notes, working sidebar collapse, drop Capture button (#59) ([23044ec](https://github.com/PylotLight/Inkfish/commit/23044ec0c343a39cb29efd732700f577ae6d30b9))

## [0.2.6] - 2026-10-16

### Added

- Pop notes out to a floating mini window (ported from Surffish) (#45) ([3c73cda](https://github.com/PylotLight/Inkfish/commit/3c73cda53ffa317cee03a5d2e61ad7a199daf4b8))
- Menu bar mode (tray icon toggle, click action, menu-bar-only / hide Dock) (#47) ([7b5d2d4](https://github.com/PylotLight/Inkfish/commit/7b5d2d4cfe83a9330159942a0c7c9bd78802e09e))
- Separate dev profile so dev runs beside the release app (#50) ([fe76cdc](https://github.com/PylotLight/Inkfish/commit/fe76cdcee202086129d59970abea074a6674e235))
- **(window)** Remember main window size/position (from Surffish) (#49) ([26a53ad](https://github.com/PylotLight/Inkfish/commit/26a53ad8bdd8f16b77c72263a75e4de69d9d55e3))
- Secret logo easter egg (triple-click the Inkfish logo) (#52) ([6806ebe](https://github.com/PylotLight/Inkfish/commit/6806ebe9af47ec93ad351f6c5d1a930dc4afdef5))
- **(updates)** Release notifications + About & updates (from Surffish) (#51) ([45392e1](https://github.com/PylotLight/Inkfish/commit/45392e1b09431292af5f572588e271fade1469e2))
- ⌘K command palette + ⌘O note switcher (from Surffish) (#53) ([e505418](https://github.com/PylotLight/Inkfish/commit/e505418ced514a0080e631f7ff822f222f162d51))

### Fixed

- **(editor)** Mount CodeMirror when the note loads after launch; Obsidian-style reading layout (#40) ([c858b11](https://github.com/PylotLight/Inkfish/commit/c858b110be4f10730e7bb21900b5721ecf34583f))
- **(editor)** Render pasted/dropped images inline instead of a bare "!" (#42) ([90217c8](https://github.com/PylotLight/Inkfish/commit/90217c84edae277ea60422cdf89e8be4a516c7f5))
- **(stability)** Crash guard + ordered shutdown (from Surffish) (#48) ([92e26ab](https://github.com/PylotLight/Inkfish/commit/92e26ab4a61579111f55dba2990de26fe2fafd5f))

## [0.2.5] - 2026-10-09

### Added

- In-note find, inbox delete, today entry point, inbox + capture cleanup ([1ed3edc](https://github.com/PylotLight/Inkfish/commit/1ed3edc5f2d9684cdd43d057fb0a1427ce815bb5))
- Today section on home dashboard with quick-append ([b50876a](https://github.com/PylotLight/Inkfish/commit/b50876aa5ec332fd13fa783a4732037bc9bed8a0))
- Single continuous live-preview editor, no blocks, no raw mode ([9b35b38](https://github.com/PylotLight/Inkfish/commit/9b35b3851f18dbaa32cf2244006d11dd03d761d6))

### Fixed

- Opaque popup/modal backgrounds so text can't bleed through ([e7d4d49](https://github.com/PylotLight/Inkfish/commit/e7d4d49a68d2c3982a901e6def7bf7abd4203003))
- Revert capture restyle, keep original + hairline border ([9fcf119](https://github.com/PylotLight/Inkfish/commit/9fcf1198cb4a8728f05e776703d6cae241be3718))
- Redux live captions resilience, visibility, warm-up ([033f5f7](https://github.com/PylotLight/Inkfish/commit/033f5f765969768f765b05dd529b6105ca9355b0))
- Live view selection-safe blocks, dblclick/Enter/gutter to edit ([854d1ad](https://github.com/PylotLight/Inkfish/commit/854d1ad2758a6ccc9093bee12c173167bb43f70a))
- Rendered bullets/tasks, tighter headings aligned to gutter ([7b274ac](https://github.com/PylotLight/Inkfish/commit/7b274acdac6f13f4a4ba2d6e25465cc784bc52db))
- Near-body heading scale so gutter numbers sit with text ([6efeb8b](https://github.com/PylotLight/Inkfish/commit/6efeb8bc67b7040685a075a0b009dbdfca86ce2f))
- Body-size bold headings so every line aligns with gutter ([dae5c1a](https://github.com/PylotLight/Inkfish/commit/dae5c1a974f0368d620e365c0160c67e99e17b5a))
- Gutter numbers track content half-leading via --ed-fs ([2d4d2c2](https://github.com/PylotLight/Inkfish/commit/2d4d2c2d8fad8d419a354aa8d64214f42540ab3d))

### Performance

- **(android)** Speed up sidebar and vault refresh ([3dc5134](https://github.com/PylotLight/Inkfish/commit/3dc513407a1e79d3d6ba7a475c69ab0b0146ea9e))

## [0.2.4] - 2026-10-08

### Added

- **(ui)** Show app version in sidebar footer, like Blobfish (#39) ([b805b6b](https://github.com/PylotLight/Inkfish/commit/b805b6b9b762097ba1a75f29373f2e15bd560de8))

### Documentation

- Add Inkfish README screenshot ([d519c21](https://github.com/PylotLight/Inkfish/commit/d519c2112e85890a7390e559e7bd5ac7cda35447))

### Other

- Clarify folder tree hierarchy; show nested child dirs on Android ([613c8c2](https://github.com/PylotLight/Inkfish/commit/613c8c2e7beeaefad6d21c7e22e93332f8a95cff))
- Ignore cluster-fetched Inkfish.apk ([19a7ede](https://github.com/PylotLight/Inkfish/commit/19a7ede21f422c278b2bf02a7986d099bd9d84bf))
- Cluster APK: stamp version/versionCode from root package.json ([8ae0b33](https://github.com/PylotLight/Inkfish/commit/8ae0b33747f5c5e880df90f69266dbe24525a708))
- Cluster APK: absolute app.json path for version stamping ([cd626f6](https://github.com/PylotLight/Inkfish/commit/cd626f64b386ee1c77db20cd009a352945c655e9))
- Fetch cluster APK into android/build/output via helper pod ([b776dc5](https://github.com/PylotLight/Inkfish/commit/b776dc5cdc65632e3235c1df6984f003a40d617e))
- Heal case-duplicate folders; watch vault for out-of-app changes ([7fdbf3e](https://github.com/PylotLight/Inkfish/commit/7fdbf3ec0be9b28b162f4b80fe8497470526dba9))
- Cluster APK drops straight into android/build/output via hostPath ([fcd295a](https://github.com/PylotLight/Inkfish/commit/fcd295aa1355509168f120f844ae1943629951cc))
- Sync history log on both apps; harden apply against mid-sync races ([ced8c83](https://github.com/PylotLight/Inkfish/commit/ced8c83a63e7b548d2546192fc5db67d22221f52))
- Android sidebar: filename titles, faster folders, file/folder CRUD (#37) ([cab314f](https://github.com/PylotLight/Inkfish/commit/cab314f9ba463607ddf7acc2b29aa557b1b6b0db))
- Local builds always regenerate native project (fresh launcher icon) (#38) ([0527026](https://github.com/PylotLight/Inkfish/commit/052702600b7bd701563767e3af7fd963ed89f12d))

## [0.2.3] - 2026-10-08

### Added

- **(sync)** Ask before applying a big deletion (keep, delete everywhere, or pause) (#36) ([338b716](https://github.com/PylotLight/Inkfish/commit/338b716c6ee34595e4910f9155c7ddb9bf385092))

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

[0.2.15]: https://github.com/PylotLight/Inkfish/compare/v0.2.14...v0.2.15
[0.2.14]: https://github.com/PylotLight/Inkfish/compare/v0.2.13...v0.2.14
[0.2.13]: https://github.com/PylotLight/Inkfish/compare/v0.2.12...v0.2.13
[0.2.12]: https://github.com/PylotLight/Inkfish/compare/v0.2.11...v0.2.12
[0.2.11]: https://github.com/PylotLight/Inkfish/compare/v0.2.10...v0.2.11
[0.2.10]: https://github.com/PylotLight/Inkfish/compare/v0.2.9...v0.2.10
[0.2.9]: https://github.com/PylotLight/Inkfish/compare/v0.2.8...v0.2.9
[0.2.8]: https://github.com/PylotLight/Inkfish/compare/v0.2.7...v0.2.8
[0.2.7]: https://github.com/PylotLight/Inkfish/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/PylotLight/Inkfish/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/PylotLight/Inkfish/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/PylotLight/Inkfish/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/PylotLight/Inkfish/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/PylotLight/Inkfish/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/PylotLight/Inkfish/compare/v0.2.0...v0.2.1
[android-v0.2.1]: https://github.com/PylotLight/Inkfish/compare/android-v0.2.0...android-v0.2.1
[android-v0.2.0]: https://github.com/PylotLight/Inkfish/compare/v0.1.0...android-v0.2.0
[0.1.0]: https://github.com/PylotLight/Inkfish/releases/tag/v0.1.0

<!-- generated by git-cliff -->
