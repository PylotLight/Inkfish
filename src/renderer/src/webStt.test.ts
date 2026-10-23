import { describe, expect, test } from 'bun:test'
import { WEB_ENGINES, isLegacyWebCache, splitAtQuiet, webEngines } from './webStt'

describe('web STT engines', () => {
  test('only Parakeet Redux · Web is left', () => {
    expect(WEB_ENGINES.map((e) => e.id)).toEqual(['web-parakeet-redux'])
    expect(webEngines().map((e) => e.name)).toEqual(['Parakeet Redux · Web'])
  })

  test('legacy cleanup never matches the Redux bucket', () => {
    for (const c of WEB_ENGINES.flatMap((e) => e.caches)) expect(isLegacyWebCache(c)).toBe(false)
    expect(isLegacyWebCache('inkfish-stt-web-whisper-base-en-v1')).toBe(true)
    expect(isLegacyWebCache('inkfish-zipformer-wasm-909bffc-v1')).toBe(true)
    expect(isLegacyWebCache('moonshine-models-v1')).toBe(true)
  })
})

describe('splitAtQuiet', () => {
  test('reconstructs every input sample exactly and respects maximum duration', () => {
    const rate = 100
    const pcm = Float32Array.from({ length: 1_037 }, (_, i) => Math.sin(i / 9))
    const windows = splitAtQuiet(pcm, rate, 2)
    expect(windows.length).toBeGreaterThan(1)
    expect(windows.every((w) => w.length <= 2 * rate)).toBe(true)
    expect([...windows.flatMap((w) => [...w])]).toEqual([...pcm])
  })

  test('cuts at a quiet boundary when one is available', () => {
    const rate = 100
    const pcm = new Float32Array(450)
    pcm.fill(1)
    pcm.fill(0, 180, 230)
    const windows = splitAtQuiet(pcm, rate, 2)
    expect(windows[0]!.length).toBeGreaterThanOrEqual(180)
    expect(windows[0]!.length).toBeLessThanOrEqual(230)
    expect([...windows.flatMap((w) => [...w])]).toEqual([...pcm])
  })

  test('short clips stay whole', () => {
    const pcm = new Float32Array(16_000)
    expect(splitAtQuiet(pcm)).toEqual([pcm])
  })
})
