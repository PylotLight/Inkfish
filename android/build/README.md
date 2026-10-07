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

The job clones the `android-client` branch, so **push the branch before building**.
Gradle/npm caches persist on the `shuttle-build-cache` PVC — first build is
slow (~10–20 min), later ones reuse the cache.

## What the job does

1. `git clone --branch android-client --depth 1`
2. `npm ci` (cached on PVC)
3. `npx expo prebuild --platform android --clean` (generates `android/android/`, gitignored)
4. `build/inject-signing.sh` — release `signingConfigs` from the Secret env
5. `./gradlew :app:assembleRelease` + `apksigner verify`
