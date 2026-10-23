import { describe, expect, test } from 'bun:test'
import { WEB_ENGINES, webEngines } from './webStt'

const candidates = ['web-wav2vec2-base-960h', 'web-moonshine-streaming-tiny-int8-experimental', 'web-qwen3-asr-06b']

describe('web STT testing candidates', () => {
  test('registers all three additional candidates with separate loaders and caches', () => {
    const engines = candidates.map((id) => WEB_ENGINES.find((engine) => engine.id === id)!)
    for (const engine of engines) {
      expect(engine).toBeDefined()
      expect(typeof engine.load).toBe('function')
      expect(`${engine.name} ${engine.subtitle}`.toLowerCase()).toContain('experimental')
      expect(engine.caches.length).toBeGreaterThan(0)
    }
    const caches = engines.flatMap((engine) => engine.caches)
    expect(new Set(caches).size).toBe(caches.length)
  })

  test('keeps every engine ID unique and exposes all candidates in Settings metadata', () => {
    const ids = WEB_ENGINES.map((engine) => engine.id)
    expect(new Set(ids).size).toBe(ids.length)
    const settingsIds = webEngines().map((engine) => engine.id)
    for (const id of candidates) expect(settingsIds).toContain(id)
  })
})
