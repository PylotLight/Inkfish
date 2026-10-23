import { describe, expect, test } from 'bun:test'
import { migrateEngineId, pickAutoEngine } from './stt'

describe('migrateEngineId', () => {
  test('keeps auto and the engines still offered', () => {
    for (const id of ['', 'parakeet-redux', 'web-parakeet-redux', 'apple-analyzer', 'override'])
      expect(migrateEngineId(id, true)).toBe(id)
  })

  test('moves removed engines to Redux: native on the Mac, Web elsewhere', () => {
    for (const id of ['apple-speech', 'parakeet-v3', 'cohere-transcribe', 'web-whisper-base-en', 'web-qwen3-asr-06b']) {
      expect(migrateEngineId(id, true)).toBe('parakeet-redux')
      expect(migrateEngineId(id, false)).toBe('web-parakeet-redux')
    }
  })
})

describe('pickAutoEngine', () => {
  test('prefers ready native Redux, then SpeechAnalyzer', () => {
    const e = (id: string, ready = true): { id: string; ready: boolean } => ({ id, ready })
    expect(pickAutoEngine([e('apple-analyzer'), e('parakeet-redux')])?.id).toBe('parakeet-redux')
    expect(pickAutoEngine([e('apple-analyzer'), e('parakeet-redux', false)])?.id).toBe('apple-analyzer')
    expect(pickAutoEngine([e('parakeet-v3')])).toBeUndefined()
  })
})
