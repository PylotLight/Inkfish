#!/usr/bin/env bash
# Newest Xcode on the box: Swift 6.2 + macOS 26 SDK enables the SpeechAnalyzer engine
# (older SDKs build a stub), FluidAudio needs Swift 6. Hosted images ship several
# /Applications/Xcode_*.app and allow passwordless sudo; a self-hosted Mac usually has one
# Xcode.app and no sudo, so fall back to whatever xcode-select already points at.
set -euo pipefail
newest="$(ls -d /Applications/Xcode_*.app 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$newest" ] && sudo -n true 2>/dev/null; then
  sudo xcode-select -s "$newest"
else
  echo "keeping $(xcode-select -p 2>/dev/null || echo 'no xcode-select path')"
fi
xcrun swift --version
