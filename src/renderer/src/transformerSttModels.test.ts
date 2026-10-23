import { describe, expect, test } from 'bun:test'
import { DownloadTotals, padAudio, speechWindows, TRANSFORMER_ENGINES, transformerCache } from './transformerSttModels'

describe('transformer STT models', () => {
  test('defines six uniquely identified web engines under 200 MB', () => {
    expect(TRANSFORMER_ENGINES).toHaveLength(6)
    const ids = TRANSFORMER_ENGINES.map(({ id }) => id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids.every((id) => id.startsWith('web-'))).toBe(true)
    for (const engine of TRANSFORMER_ENGINES) {
      const sizeMb = Number(engine.size.match(/\d+/)?.[0])
      expect(Number.isFinite(sizeMb)).toBe(true)
      expect(sizeMb).toBeLessThan(200)
    }
  })

  test('distinguishes original Moonshine models from v2 and labels the v2 export experimental', () => {
    const v2 = TRANSFORMER_ENGINES.find(({ id }) => id === 'web-moonshine-v2-small')!
    const originals = TRANSFORMER_ENGINES.filter(({ id }) => id === 'web-moonshine-tiny' || id === 'web-moonshine-base')
    expect(v2.name).toContain('v2')
    expect(v2.subtitle).toContain('Experimental')
    for (const engine of originals) {
      expect(engine.subtitle).toContain('Original Moonshine (not v2)')
      expect(engine.name).not.toContain('v2')
    }
  })

  test('generates a unique cache key per model', () => {
    const caches = TRANSFORMER_ENGINES.map(({ id }) => transformerCache(id))
    expect(new Set(caches).size).toBe(TRANSFORMER_ENGINES.length)
    expect(caches).toEqual(TRANSFORMER_ENGINES.map(({ id }) => `inkfish-stt-${id}-v1`))
  })
})

describe('audio helpers', () => {
  test('padAudio preserves aligned arrays by identity', () => {
    const pcm = new Float32Array([0.1, -0.2, 0.3, -0.4])
    expect(padAudio(pcm, 2)).toBe(pcm)
  })

  test('padAudio zero-pads a partial frame without changing the source', () => {
    const pcm = new Float32Array([0.25, -0.5, 0.75])
    const padded = padAudio(pcm, 4)
    expect(padded).not.toBe(pcm)
    expect([...padded]).toEqual([0.25, -0.5, 0.75, 0])
    expect([...pcm]).toEqual([0.25, -0.5, 0.75])
  })

  test('speechWindows reconstructs every input sample exactly and respects maximum duration', () => {
    const rate = 100
    const pcm = Float32Array.from({ length: 1_037 }, (_, i) => Math.sin(i / 9))
    const windows = speechWindows(pcm, rate, 2)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every((window) => window.length <= 2 * rate)).toBe(true)
    const reconstructed = Float32Array.from(windows.flatMap((window) => [...window]))
    expect([...reconstructed]).toEqual([...pcm])
  })

  test('speechWindows cuts at a quiet boundary when one is available', () => {
    const rate = 100
    const pcm = new Float32Array(450)
    pcm.fill(1)
    // Quietest 50 ms candidate in the final four seconds before the nominal 200-sample limit.
    pcm.fill(0, 180, 230)
    const windows = speechWindows(pcm, rate, 2)
    expect(windows[0]!.length).toBeGreaterThanOrEqual(180)
    expect(windows[0]!.length).toBeLessThanOrEqual(230)
    expect([...windows.flatMap((window) => [...window])]).toEqual([...pcm])
  })
})

describe('download progress totals', () => {
  test('accumulates across files monotonically and ignores non-progress events', () => {
    const totals = new DownloadTotals()
    expect(totals.update({ status: 'initiate', file: 'a', loaded: 0, total: 100 })).toBeUndefined()
    expect(totals.update({ status: 'progress', loaded: 999, total: 999 })).toBeUndefined()

    expect(totals.update({ status: 'progress', file: 'a', loaded: 40, total: 100 })).toMatchObject({
      loaded: 40,
      total: 100,
      file: 'a'
    })
    expect(totals.update({ status: 'progress', file: 'b', loaded: 10, total: 50 })).toMatchObject({
      loaded: 50,
      total: 150,
      file: 'b'
    })
    expect(totals.update({ status: 'progress', file: 'a', loaded: 20, total: 80 })).toMatchObject({
      loaded: 50,
      total: 150,
      file: 'a'
    })
    expect(totals.update({ status: 'progress', file: 'b', loaded: 35, total: 50 })).toMatchObject({
      loaded: 75,
      total: 150,
      file: 'b'
    })
    expect(totals.update({ status: 'done', file: 'b', loaded: 50, total: 50 })).toBeUndefined()
  })
})
