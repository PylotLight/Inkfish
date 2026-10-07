import { describe, expect, test } from 'bun:test'
import { parseHelperJson } from './stt'

describe('parseHelperJson', () => {
  test('plain reply', () => {
    expect(parseHelperJson<{ text: string }>('{"text":"hi"}\n')?.text).toBe('hi')
  })
  test('log lines before the reply', () => {
    const out =
      'Compiling model…\n[FluidAudio] loaded encoder\n{"engine":"parakeet-v2","text":"The little girl","ms":12}\n'
    expect(parseHelperJson<{ text: string }>(out)?.text).toBe('The little girl')
  })
  test('log text glued onto the reply line', () => {
    const out = 'warmup done {"engine":"parakeet-v2","text":"a b c"} trailing'
    expect(parseHelperJson<{ text: string }>(out)?.text).toBe('a b c')
  })
  test('engine list', () => {
    expect(parseHelperJson<unknown[]>('noise\n[{"id":"x"}]')).toEqual([{ id: 'x' }])
  })
  test('plain text is not JSON', () => {
    expect(parseHelperJson('just words')).toBeUndefined()
  })
})
