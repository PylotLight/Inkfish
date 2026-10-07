# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.1.0]: https://github.com/PylotLight/Inkfish/releases/tag/v0.1.0

<!-- generated by git-cliff -->
