#!/usr/bin/env bash
# Self-hosted runners: if INKFISH_CI_CACHE is set (repo variable or runner env) or a writable
# /cache is mounted (e.g. a PVC on the k3s runner pod), keep bun / npm / Electron download
# caches there across ephemeral pods and skip the actions/cache round trip.
# Hosted runners have neither, so this is a no-op there.
set -euo pipefail
dir="${INKFISH_CI_CACHE:-}"
if [ -z "$dir" ] && [ -d /cache ] && [ -w /cache ]; then dir=/cache/inkfish; fi
if [ -n "$dir" ] && mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then
  echo "using persistent cache at $dir"
  {
    echo "CI_PERSISTENT_CACHE=1"
    echo "BUN_INSTALL_CACHE_DIR=$dir/bun-install-cache"
    echo "npm_config_cache=$dir/npm"
    echo "ELECTRON_CACHE=$dir/electron"
    echo "ELECTRON_BUILDER_CACHE=$dir/electron-builder"
  } >> "$GITHUB_ENV"
else
  echo "no persistent cache mounted, using actions/cache"
fi
