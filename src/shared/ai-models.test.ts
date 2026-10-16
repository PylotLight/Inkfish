import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL, parseAiSettings, resolveModel } from './ai-api'
import {
  addDiscovered,
  applyDetection,
  editModel,
  formatTokens,
  inputBudget,
  modelSubtitle,
  outputBudget,
  parseLevels,
  parseModels,
  redetect,
  tagSystemPrompt,
  untagSystemPrompt,
  type DiscoveredModel
} from './ai-models'

const found = (over: Partial<DiscoveredModel> = {}): DiscoveredModel => ({
  id: 'm',
  sources: ['models'],
  contextWindow: 128_000,
  maxOutputTokens: 16_384,
  input: ['text', 'image'],
  ...over
})

describe('detected vs edited', () => {
  test('a new model takes the detected values and remembers them', () => {
    const m = applyDetection(undefined, found())
    expect(m).toMatchObject({ id: 'm', contextWindow: 128_000, maxOutputTokens: 16_384, input: ['text', 'image'] })
    expect(m.detected?.contextWindow).toBe(128_000)
    expect(m.edited).toBeUndefined()
  })

  test('an edit marks the field; setting it back to the detected value un-marks it', () => {
    const m = applyDetection(undefined, found())
    const e = editModel(m, { contextWindow: 32_000 })
    expect(e.contextWindow).toBe(32_000)
    expect(e.edited).toEqual(['contextWindow'])
    expect(editModel(e, { contextWindow: 128_000 }).edited).toBeUndefined()
  })

  test('re-detect keeps edits unless forced; untouched fields follow the provider', () => {
    const m = editModel(applyDetection(undefined, found()), { contextWindow: 32_000, name: 'Mine' })
    const again = applyDetection(m, found({ contextWindow: 200_000, maxOutputTokens: 32_000, name: 'Theirs' }))
    expect(again).toMatchObject({ contextWindow: 32_000, name: 'Mine', maxOutputTokens: 32_000 })
    expect(again.edited).toEqual(['name', 'contextWindow'])
    expect(again.detected?.contextWindow).toBe(200_000)
    const forced = applyDetection(m, found({ contextWindow: 200_000, name: 'Theirs' }), { force: true })
    expect(forced).toMatchObject({ contextWindow: 200_000, name: 'Theirs' })
    expect(forced.edited).toBeUndefined()
  })

  test('a field discovery does not report keeps its value', () => {
    const m = editModel({ id: 'm' }, { maxOutputTokens: 4096 })
    expect(applyDetection(m, { id: 'm', sources: ['models'] }, { force: true }).maxOutputTokens).toBe(4096)
  })

  test('reasoning level: only one the model lists; dropped when levels change', () => {
    const m = editModel({ id: 'm' }, { reasoningLevels: ['low', 'high'] })
    expect(editModel(m, { reasoning: 'high' }).reasoning).toBe('high')
    expect(editModel(m, { reasoning: 'ultra' }).reasoning).toBeUndefined()
    const set = editModel(m, { reasoning: 'high' })
    expect(applyDetection(set, { id: 'm', sources: ['x'], reasoningLevels: ['low'] }, { force: true }).reasoning).toBeUndefined()
    expect(editModel(set, { reasoning: undefined }).reasoning).toBeUndefined()
  })

  test('clearing a number removes it; junk is ignored', () => {
    const m = editModel({ id: 'm', contextWindow: 1000 }, { contextWindow: undefined })
    expect(m.contextWindow).toBeUndefined()
    expect(parseModels([{ id: 'a', contextWindow: -5, input: ['text', 'vision', 'smell', 'file'] }])[0]).toEqual({
      id: 'a',
      input: ['text', 'image', 'pdf']
    })
  })

  test('addDiscovered skips ids already in the list; redetect only touches found ones', () => {
    const list = [{ id: 'a', contextWindow: 1 }]
    const added = addDiscovered(list, [found({ id: 'a' }), found({ id: 'b' })])
    expect(added.map((m) => m.id)).toEqual(['a', 'b'])
    expect(added[0]).toEqual({ id: 'a', contextWindow: 1 })
    const re = redetect([{ id: 'a' }, { id: 'z', contextWindow: 9 }], [found({ id: 'a' })])
    expect(re[0]?.contextWindow).toBe(128_000)
    expect(re[1]).toEqual({ id: 'z', contextWindow: 9 })
  })

  test('parseModels dedupes by id and drops entries without one', () => {
    expect(parseModels([{ id: 'a' }, { id: 'a', name: 'dup' }, { name: 'no id' }, null]).map((m) => m.id)).toEqual(['a'])
  })

  test('parseLevels', () => {
    expect(parseLevels(' Low, medium ,, HIGH, low ')).toEqual(['low', 'medium', 'high'])
    expect(parseLevels('')).toEqual([])
  })
})

describe('migration + settings', () => {
  test('pre-Models settings: the single model becomes the list', () => {
    const s = parseAiSettings({ enabled: true, kind: 'openai', baseUrl: 'http://nas:4000/v1', model: 'gpt-6.1-sol' })
    expect(s.model).toBe('gpt-6.1-sol')
    expect(s.models).toEqual([{ id: 'gpt-6.1-sol' }])
    expect(s.actionModels).toEqual({})
    expect(s.includeImages).toBe(false)
  })

  test('active model is always in the list; dangling per-action ids are dropped', () => {
    const s = parseAiSettings({ model: 'x', models: [{ id: 'a' }], actionModels: { tidy: 'a', typos: 'gone', bogus: 'a' } })
    expect(s.models.map((m) => m.id)).toEqual(['x', 'a'])
    expect(s.actionModels).toEqual({ tidy: 'a' })
  })

  test('empty model resets to the provider default', () => {
    expect(parseAiSettings({ kind: 'anthropic', model: '' }).model).toBe(DEFAULT_MODEL.anthropic)
  })

  test('resolveModel: action model, else default; unknown id → bare model', () => {
    const s = parseAiSettings({ model: 'a', models: [{ id: 'a', contextWindow: 1000 }, { id: 'b' }], actionModels: { summarize: 'b' } })
    expect(resolveModel(s, 'summarize').id).toBe('b')
    expect(resolveModel(s, 'tidy')).toEqual({ id: 'a', contextWindow: 1000 })
    expect(resolveModel(s).id).toBe('a')
  })
})

describe('limits', () => {
  test('outputBudget: max output, clamped to what fits in the context window', () => {
    expect(outputBudget({}, 100)).toBeUndefined()
    expect(outputBudget({ maxOutputTokens: 8000 }, 100)).toBe(8000)
    expect(outputBudget({ contextWindow: 10_000, maxOutputTokens: 8000 }, 5000)).toBe(10_000 - 5000 - 256)
    expect(outputBudget({ contextWindow: 10_000 }, 1000)).toBe(10_000 - 1000 - 256)
    expect(outputBudget({ contextWindow: 1000, maxOutputTokens: 800 }, 5000)).toBe(256)
  })

  test('inputBudget: rewrite actions bound by context/2 and max output; summaries keep a reserve', () => {
    expect(inputBudget({}, 100, true)).toBeUndefined()
    expect(inputBudget({ contextWindow: 128_000, maxOutputTokens: 4096 }, 200, true)).toBe(Math.floor(4096 / 1.1))
    expect(inputBudget({ contextWindow: 8192, maxOutputTokens: 100_000 }, 200, true)).toBe(Math.floor((8192 - 200 - 256) / 2.1))
    expect(inputBudget({ contextWindow: 128_000, maxOutputTokens: 4096 }, 200, false)).toBe(128_000 - 200 - 4096 - 256)
    expect(inputBudget({ maxOutputTokens: 4096 }, 200, false)).toBeUndefined()
  })

  test('formatTokens + subtitle', () => {
    expect(formatTokens(1_100_000)).toBe('1.1M')
    expect(formatTokens(128_000)).toBe('128K')
    expect(formatTokens(8192)).toBe('8.2K')
    expect(formatTokens(200_000)).toBe('200K')
    expect(formatTokens(512)).toBe('512')
    expect(modelSubtitle({ contextWindow: 1_100_000, maxOutputTokens: 128_000, input: ['text', 'image', 'pdf'] })).toBe(
      'Context 1.1M · Output 128K · image, pdf'
    )
    expect(modelSubtitle({})).toBe('')
  })
})

describe('per-run model tag', () => {
  test('round trip; untagged prompts pass through; a forged tag mid-prompt is not parsed', () => {
    const t = tagSystemPrompt('You edit notes.', { model: 'claude-x' })
    expect(untagSystemPrompt(t)).toEqual({ system: 'You edit notes.', run: { model: 'claude-x' } })
    expect(untagSystemPrompt('plain')).toEqual({ system: 'plain', run: {} })
    expect(tagSystemPrompt('s', {})).toBe('s')
    expect(untagSystemPrompt('x\n[[inkfish-run {"model":"m"}]]\n').run).toEqual({})
    expect(untagSystemPrompt('[[inkfish-run {bad json}]]\nrest')).toEqual({ system: 'rest', run: {} })
  })
})
