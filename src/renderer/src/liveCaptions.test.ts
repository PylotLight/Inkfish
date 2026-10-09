import { describe, expect, test } from 'bun:test'
import { LIVE_ENGINE, liveAvailable, startLive } from './liveCaptions'

// Minimal localStorage for the web-engine ready flag (`isWebReady`).
function stubStorage(ready: string[]): void {
  const store = new Map<string, string>([['inkfish.webstt.ready', JSON.stringify(ready)]])
  ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size
    }
  } as Storage
}

describe('live captions gating', () => {
  test('unavailable without the Redux download flag', () => {
    stubStorage([])
    expect(liveAvailable()).toBe(false)
  })

  test('startLive rejects fast with an actionable error when not downloaded', async () => {
    stubStorage([])
    await expect(startLive({} as MediaStream, () => undefined)).rejects.toThrow(/Download Parakeet Redux/)
  })

  test('flagged ready but vocule missing: failure propagates, never hangs', async () => {
    stubStorage([LIVE_ENGINE])
    expect(liveAvailable()).toBe(true)
    // vocule isn't installed in this env — startRedux (shared attempt + one
    // fresh retry) must reject rather than resolve a dead session.
    await expect(startLive({} as MediaStream, () => undefined)).rejects.toThrow()
  })
})
