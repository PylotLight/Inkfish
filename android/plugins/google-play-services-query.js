const GOOGLE_PLAY_SERVICES_PACKAGE = 'com.google.android.gms'

function ensureGooglePlayServicesQuery(androidManifest) {
  const manifest = androidManifest?.manifest
  if (!manifest) {
    throw new Error('Android manifest is missing its manifest root')
  }

  const blocks = manifest.queries == null ? [] : Array.isArray(manifest.queries) ? manifest.queries : [manifest.queries]
  const existingPackages = blocks.flatMap((block) =>
    Array.isArray(block.package) ? block.package : block.package ? [block.package] : []
  )
  const merged = blocks[0] ?? {}

  for (const block of blocks.slice(1)) {
    for (const [key, value] of Object.entries(block)) {
      if (key === '$') {
        merged.$ = { ...merged.$, ...value }
        continue
      }
      const existing = merged[key] == null ? [] : Array.isArray(merged[key]) ? merged[key] : [merged[key]]
      const additions = Array.isArray(value) ? value : [value]
      merged[key] = [...existing, ...additions]
    }
  }

  const packages = Array.isArray(merged.package) ? merged.package : merged.package ? [merged.package] : []
  if (!existingPackages.some((entry) => entry.$?.['android:name'] === GOOGLE_PLAY_SERVICES_PACKAGE)) {
    packages.push({ $: { 'android:name': GOOGLE_PLAY_SERVICES_PACKAGE } })
  }
  merged.package = packages
  manifest.queries = [merged]
  return androidManifest
}

module.exports = { ensureGooglePlayServicesQuery }
