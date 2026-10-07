#!/usr/bin/env bash
# Injects release signing into the expo-prebuild android/ project.
# Runs INSIDE the cluster build job (and works locally after prebuild too).
#
# Env required:
#   KEYSTORE_FILE   absolute path to the .keystore (secret volume mount)
#   STORE_PASSWORD  keystore password
#   KEY_PASSWORD    key password
#   KEY_ALIAS       key alias (default: inkfish)
set -euo pipefail

ALIAS="${KEY_ALIAS:-inkfish}"
: "${KEYSTORE_FILE:?set KEYSTORE_FILE}"
: "${STORE_PASSWORD:?set STORE_PASSWORD}"
: "${KEY_PASSWORD:?set KEY_PASSWORD}"

APP_GRADLE="android/app/build.gradle"
[ -f "$APP_GRADLE" ] || { echo "run from the expo project root (expecting $APP_GRADLE)"; exit 1; }

# 1. signingConfigs.release block (idempotent — replace if we injected before).
python3 - "$APP_GRADLE" <<'EOF'
import re, sys
p = sys.argv[1]
src = open(p).read()
block = """    signingConfigs {
        release {
            storeFile file(System.getenv("KEYSTORE_FILE"))
            storePassword System.getenv("STORE_PASSWORD")
            keyAlias System.getenv("KEY_ALIAS") ?: "inkfish"
            keyPassword System.getenv("KEY_PASSWORD")
        }
    }
"""
if 'signingConfigs {\n        release {' in src:
    src = re.sub(r'    signingConfigs \{\n        release \{.*?\n        \}\n    \}\n', block, src, flags=re.S)
else:
    src = src.replace('    buildTypes {', block + '    buildTypes {', 1)
open(p, 'w').write(src)
EOF

# 2. release buildType uses it (idempotent).
python3 - "$APP_GRADLE" <<'EOF'
import re, sys
p = sys.argv[1]
src = open(p).read()
src = re.sub(r'(release\s*\{[^}]*?)signingConfig signingConfigs\.debug',
             r'\1signingConfig signingConfigs.release', src)
if 'signingConfigs.release' not in src:
    src = re.sub(r'(release\s*\{)',
                 r'\1\n            signingConfig signingConfigs.release', src, count=1)
open(p, 'w').write(src)
EOF

echo "signing injected (alias=$ALIAS, keystore=$KEYSTORE_FILE)"
grep -n "signingConfig" "$APP_GRADLE" | head -5
