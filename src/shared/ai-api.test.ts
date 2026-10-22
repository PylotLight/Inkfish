import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_AI_SETTINGS,
  estimateTokens,
  isAppOrigin,
  isConnected,
  isLoopbackUrl,
  messageText,
  parseAiSettings,
  scrubSecret
} from './ai-api'

describe('AI provider settings', () => {
  test('defaults: off, OpenAI-compatible', () => {
    expect(parseAiSettings(undefined)).toEqual(DEFAULT_AI_SETTINGS)
    expect(DEFAULT_AI_SETTINGS.enabled).toBe(false)
  })
  test('invalid fields fall back, trailing slash trimmed, empty resets to the default', () => {
    const s = parseAiSettings({ kind: 'nope', baseUrl: 'ftp://x', model: 7 })
    expect(s.kind).toBe('openai')
    expect(s.baseUrl).toBe(DEFAULT_AI_SETTINGS.baseUrl)
    expect(parseAiSettings({ baseUrl: 'http://127.0.0.1:11434/v1/' }).baseUrl).toBe('http://127.0.0.1:11434/v1')
    expect(parseAiSettings({ kind: 'anthropic', baseUrl: '', model: '' })).toMatchObject({
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-haiku-4-5'
    })
  })
  test('connected only when enabled AND (key or loopback server)', () => {
    const on = { ...DEFAULT_AI_SETTINGS, enabled: true }
    expect(isConnected(DEFAULT_AI_SETTINGS, true)).toBe(false)
    expect(isConnected(on, false)).toBe(false)
    expect(isConnected(on, true)).toBe(true)
    expect(isConnected({ ...on, baseUrl: 'http://localhost:1234/v1' }, false)).toBe(true)
    expect(isLoopbackUrl('https://api.openai.com/v1')).toBe(false)
  })
})

describe('Prompt API origin gate', () => {
  test("Inkfish's own pages only", () => {
    expect(isAppOrigin('file://')).toBe(true)
    expect(isAppOrigin('http://localhost:5173')).toBe(true)
    expect(isAppOrigin('http://127.0.0.1:5173/')).toBe(true)
    expect(isAppOrigin('null')).toBe(false)
    expect(isAppOrigin('https://evil.example')).toBe(false)
    expect(isAppOrigin('http://localhost.evil.example')).toBe(false)
  })
})

describe('helpers', () => {
  test('messageText keeps text parts only', () => {
    expect(
      messageText({
        role: 'user',
        content: [
          { type: 'text', value: 'a' },
          { type: 'image', value: 'x' },
          { type: 'text', value: 'b' }
        ]
      })
    ).toBe('ab')
  })
  test('estimateTokens ≈ chars/4', () => {
    expect(estimateTokens([{ role: 'user', content: '12345678' }])).toBe(2)
  })
  test('scrubSecret hides the key', () => {
    expect(scrubSecret('bad key sk-abcdef123 rejected', 'sk-abcdef123')).toBe('bad key *** rejected')
  })
})
