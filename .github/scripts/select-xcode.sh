#!/usr/bin/env bash
# Newest stable Xcode on the box: the xcode-27 image provides Swift 6.2+ and the macOS 27 SDK.
# Ignore beta/RC apps so an installed prerelease cannot silently replace the image's stable Xcode.
# Hosted images allow passwordless sudo; a self-hosted Mac usually has one Xcode.app and no sudo,
# so fall back to whatever xcode-select already points at.
set -euo pipefail
newest="$(ls -d /Applications/Xcode_*.app 2>/dev/null | grep -Ev '(Beta|RC|Release_Candidate)' | sort -V | tail -1 || true)"
if [ -n "$newest" ] && sudo -n true 2>/dev/null; then
  sudo xcode-select -s "$newest"
else
  echo "keeping $(xcode-select -p 2>/dev/null || echo 'no xcode-select path')"
fi
echo "selected developer directory: $(xcode-select -p 2>/dev/null || echo 'no xcode-select path')"
xcrun swift --version
