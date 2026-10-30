const { describe, expect, test } = require('bun:test')
const { ensureGooglePlayServicesQuery } = require('../plugins/google-play-services-query')

describe('Google Play Services package visibility', () => {
  test('adds only the Google Play Services package query and preserves existing queries', () => {
    const androidManifest = {
      manifest: {
        queries: [
          {
            intent: [
              {
                action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
                data: [{ $: { 'android:scheme': 'https' } }]
              }
            ]
          }
        ]
      }
    }

    ensureGooglePlayServicesQuery(androidManifest)

    expect(androidManifest.manifest.queries).toHaveLength(1)
    expect(androidManifest.manifest.queries[0].package).toEqual([{ $: { 'android:name': 'com.google.android.gms' } }])
    expect(androidManifest.manifest.queries[0].intent).toBeDefined()
  })

  test('is idempotent and does not add duplicate package queries', () => {
    const androidManifest = {
      manifest: {
        queries: [{ package: [{ $: { 'android:name': 'com.google.android.gms' } }] }]
      }
    }

    ensureGooglePlayServicesQuery(androidManifest)
    ensureGooglePlayServicesQuery(androidManifest)

    expect(androidManifest.manifest.queries).toHaveLength(1)
  })

  test('merges multiple pre-existing blocks and avoids duplicating an existing package query', () => {
    const androidManifest = {
      manifest: {
        queries: [
          { intent: [{ action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }] }] },
          { package: [{ $: { 'android:name': 'com.google.android.gms' } }] },
          { provider: [{ $: { 'android:authorities': 'example.provider' } }] }
        ]
      }
    }

    ensureGooglePlayServicesQuery(androidManifest)

    expect(androidManifest.manifest.queries).toHaveLength(1)
    expect(androidManifest.manifest.queries[0].package).toHaveLength(1)
    expect(androidManifest.manifest.queries[0].intent).toHaveLength(1)
    expect(androidManifest.manifest.queries[0].provider).toHaveLength(1)
  })

  test('fails clearly when the Android manifest root is missing', () => {
    expect(() => ensureGooglePlayServicesQuery({})).toThrow('Android manifest is missing its manifest root')
  })
})
