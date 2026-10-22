import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL } from '../shared/ai-api'
import { applySettingsPatch, parseStoredAi } from './ai-store'

describe('ai-provider.json', () => {
  test('v0.2.x file (single model + key) migrates; key ciphertext kept', () => {
    const s = parseStoredAi({
      enabled: true,
      kind: 'openai',
      baseUrl: 'http://nas:4000/v1',
      model: 'gpt-6.1-sol',
      keyEnc: 'Y2lwaGVy'
    })
    expect(s).toMatchObject({
      enabled: true,
      model: 'gpt-6.1-sol',
      models: [{ id: 'gpt-6.1-sol' }],
      keyEnc: 'Y2lwaGVy'
    })
  })

  test('garbage file → defaults, no key', () => {
    const s = parseStoredAi('nope')
    expect(s.keyEnc).toBeUndefined()
    expect(s.model).toBe(DEFAULT_MODEL.openai)
  })

  test('a patch never touches the key and keeps unrelated fields', () => {
    const cur = parseStoredAi({ model: 'a', models: [{ id: 'a' }, { id: 'b' }], keyEnc: 'k' })
    const next = applySettingsPatch(cur, { model: 'b', keyEnc: 'evil' })
    expect(next.keyEnc).toBe('k')
    expect(next.model).toBe('b')
    expect(next.models.map((m) => m.id)).toEqual(['a', 'b'])
  })

  test('switching provider stashes the list and restores it on the way back', () => {
    const openai = parseStoredAi({
      kind: 'openai',
      model: 'b',
      models: [{ id: 'a', contextWindow: 9 }, { id: 'b' }],
      actionModels: { tidy: 'a' }
    })
    const toAnthropic = applySettingsPatch(openai, { kind: 'anthropic', baseUrl: 'https://api.anthropic.com' })
    expect(toAnthropic.model).toBe(DEFAULT_MODEL.anthropic)
    expect(toAnthropic.models).toEqual([{ id: DEFAULT_MODEL.anthropic }])
    expect(toAnthropic.actionModels).toEqual({})
    const edited = applySettingsPatch(toAnthropic, { models: [{ id: 'claude-x' }], model: 'claude-x' })
    const back = applySettingsPatch(edited, { kind: 'openai', baseUrl: 'https://api.openai.com/v1' })
    expect(back.model).toBe('b')
    expect(back.models).toEqual([{ id: 'a', contextWindow: 9 }, { id: 'b' }])
    expect(back.actionModels).toEqual({ tidy: 'a' })
    // …and the anthropic list was stashed in turn.
    expect(applySettingsPatch(back, { kind: 'anthropic' }).models).toEqual([{ id: 'claude-x' }])
    // The stash survives a save/load round trip.
    expect(parseStoredAi(JSON.parse(JSON.stringify(back))).byKind?.anthropic?.model).toBe('claude-x')
  })
})
