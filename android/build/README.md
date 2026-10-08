# Cluster build pipeline (shuttle-build namespace)

EAS-free, k8s-native signed release builds. One-time setup, then one command per APK.

## One-time setup

```bash
# 1. keystore (runs once; skips if the PVC already has one)
kubectl -n shuttle-build apply -f android/build/keystore-init-job.yaml
kubectl -n shuttle-build wait --for=condition=complete job/inkfish-keystore-init --timeout=300s

# 2. mirror it into the PERMANENT shared Secret (values copied
#    base64-to-base64 — key material never leaves the cluster):
kubectl -n shuttle-build get secret inkfish-android-keystore -o json | python3 -c "
import json,sys
d = json.load(sys.stdin)
data = d['data']; data['keystore'] = data.pop('inkfish.keystore')
print(json.dumps({'apiVersion':'v1','kind':'Secret','type':'Opaque',
  'metadata':{'name':'android-release-keystore','namespace':'shuttle-build',
    'annotations':{'inkfish.dev/permanent':'true'}},
  'data':data}))" | kubectl apply -f -
kubectl -n shuttle-build delete secret inkfish-android-keystore
unset STORE_PASSWORD KEY_PASSWORD KEY_ALIAS
```

Permanent infra: `android-release-keystore` (keys: `keystore`,
`store-password`, `key-password`, `key-alias`) is shared by all Android
release builds. **Never delete or rotate it** — store upgrades require the
same signing key. Future apps reuse this keystore with a new alias
(`keytool -genkeypair -alias <app> …`). A backup copy also sits on the
`shuttle-build-cache` PVC at `/cache/keystore/`.

## Every build

```bash
kubectl -n shuttle-build delete job inkfish-apk-build --ignore-not-found
kubectl -n shuttle-build apply -f android/build/build-job.yaml
kubectl -n shuttle-build wait --for=condition=complete job/inkfish-apk-build --timeout=3600s
POD=$(kubectl -n shuttle-build get pod -l job-name=inkfish-apk-build -o jsonpath='{.items[0].metadata.name}')
kubectl -n shuttle-build cp "$POD:/cache/output/app-release.apk" ./Inkfish.apk
```

The job clones `main` (override with the `BRANCH` env in the Job), so **push before building**.
Gradle/npm caches persist on the `shuttle-build-cache` PVC — first build is
slow (~10–20 min), later ones reuse the cache.

## What the job does

1. `git clone --branch $BRANCH --depth 1` (default `main`)
2. Stamp `expo.version` + `android.versionCode` from the root `package.json`
   version (same `MAJOR·10000+MINOR·100+PATCH` rule as the GitHub release
   workflow; override with a `VERSION=X.Y.Z` env) — so cluster builds
   install as upgrades, and the in-app updater sees the right version
3. `npm ci` (cached on PVC)
4. `npx expo prebuild --platform android --clean` (generates `android/android/`, gitignored)
5. `build/inject-signing.sh` — release `signingConfigs` from the Secret env
6. `./gradlew :app:assembleRelease` + `apksigner verify` + `aapt2 dump badging` (logs the stamped versionCode)

## GitHub releases + in-app updates

`.github/workflows/android-release.yml` builds the same signed APK on GitHub
Actions and publishes it as a release (`android-vX.Y.Z`, never "latest", so
the Mac cask is untouched). The app checks those releases (Settings ›
Updates, plus an auto-check on launch) and installs over itself — same key,
data kept.

One-time: copy the cluster keystore into repo secrets (values never printed):

```bash
R=PylotLight/Inkfish
kubectl -n shuttle-build get secret android-release-keystore -o jsonpath='{.data.keystore}' \
  | gh secret set ANDROID_KEYSTORE_BASE64 -R $R
for k in store-password key-password key-alias; do
  name=ANDROID_$(echo $k | tr a-z- A-Z_)
  kubectl -n shuttle-build get secret android-release-keystore -o jsonpath="{.data.$k}" | base64 -d \
    | gh secret set "$name" -R $R
done
```

Release: `git tag android-v0.2.0 && git push origin android-v0.2.0` (or Actions
› android-release › Run workflow). versionCode = MAJOR·10000 + MINOR·100 + PATCH.

**First install of the updater:** builds before 0.2.0 don't have it, so install
that one APK manually; every later version arrives in-app.
