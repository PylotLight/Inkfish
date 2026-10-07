# Cluster build pipeline (shuttle-build namespace)

EAS-free, k8s-native signed release builds. One-time setup, then one command per APK.

## One-time setup

```bash
# 1. keystore (runs once; skips if the PVC already has one)
kubectl -n shuttle-build apply -f android/build/keystore-init-job.yaml
kubectl -n shuttle-build wait --for=condition=complete job/inkfish-keystore-init --timeout=300s

# 2. mirror it into the Secret the build consumes
POD=$(kubectl -n shuttle-build get pod -l job-name=inkfish-keystore-init -o jsonpath='{.items[0].metadata.name}')
kubectl -n shuttle-build cp "$POD:/cache/keystore/inkfish.keystore" /tmp/inkfish.keystore
kubectl -n shuttle-build cp "$POD:/cache/keystore/creds.env" /tmp/creds.env
source /tmp/creds.env
kubectl -n shuttle-build create secret generic inkfish-android-keystore \
  --from-file=inkfish.keystore=/tmp/inkfish.keystore \
  --from-literal=store-password="$STORE_PASSWORD" \
  --from-literal=key-password="$KEY_PASSWORD" \
  --from-literal=key-alias="$KEY_ALIAS"
shred -u /tmp/inkfish.keystore /tmp/creds.env
unset STORE_PASSWORD KEY_PASSWORD KEY_ALIAS
```

## Every build

```bash
kubectl -n shuttle-build delete job inkfish-apk-build --ignore-not-found
kubectl -n shuttle-build apply -f android/build/build-job.yaml
kubectl -n shuttle-build wait --for=condition=complete job/inkfish-apk-build --timeout=3600s
POD=$(kubectl -n shuttle-build get pod -l job-name=inkfish-apk-build -o jsonpath='{.items[0].metadata.name}')
kubectl -n shuttle-build cp "$POD:/cache/output/app-release.apk" ./Inkfish.apk
```

The job clones the `android-client` branch, so **push the branch before building**.
Gradle/npm caches persist on the `shuttle-build-cache` PVC — first build is
slow (~10–20 min), later ones reuse the cache.

## What the job does

1. `git clone --branch android-client --depth 1`
2. `npm ci` (cached on PVC)
3. `npx expo prebuild --platform android --clean` (generates `android/android/`, gitignored)
4. `build/inject-signing.sh` — release `signingConfigs` from the Secret env
5. `./gradlew :app:assembleRelease` + `apksigner verify`
