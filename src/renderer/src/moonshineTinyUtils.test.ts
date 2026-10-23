import { describe, expect, test } from 'bun:test'
import { decodeMoonshineTinyIds, padMoonshineTinyAudio, quietCutsMoonshineTiny } from './moonshineTinyUtils'

describe('Moonshine Tiny preprocessing', () => {
  test('pads raw 16kHz PCM to a multiple of 80 without changing existing samples', () => {
    const input = Float32Array.from([0.2, -0.1, 0.4])
    const output = padMoonshineTinyAudio(input)
    expect(output.length).toBe(80)
    expect([...output.slice(0, 3)]).toEqual([...input])
    expect(output[3]).toBe(0)
    expect(padMoonshineTinyAudio(new Float32Array(80)).length).toBe(80)
  })
  test('uses 5-second maximum windows and retains every sample', () => {
    const pcm = new Float32Array(12 * 16000).fill(0.1)
    const windows = quietCutsMoonshineTiny(pcm, 16000, 5)
    expect(windows.length).toBeGreaterThanOrEqual(3)
    expect(windows.every((w) => w.length <= 5 * 16000)).toBe(true)
    expect(windows.reduce((n, w) => n + w.length, 0)).toBe(pcm.length)
    expect(quietCutsMoonshineTiny(new Float32Array(), 16000)).toEqual([])
  })

  test('decodes word boundaries and adjacent UTF-8 byte fallback tokens while skipping special tokens', () => {
    const tokenizer = {
      model: { vocab: { '▁hello': 3, '▁caf': 4, '<0xC3>': 5, '<0xA9>': 6, '</s>': 2 } },
      added_tokens: [{ id: 2, content: '</s>', special: true }]
    }
    expect(decodeMoonshineTinyIds(tokenizer, [3, 4, 5, 6, 2])).toBe('hello café')
  })
})
