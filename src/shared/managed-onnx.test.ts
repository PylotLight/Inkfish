import { describe, expect, test } from 'bun:test'
import { splitLfm3ThinkingText } from './managed-onnx'

describe('LFM3 ONNX thinking output', () => {
  test('treats generation as a thinking block until the closing marker', () => {
    expect(splitLfm3ThinkingText('Let me check the dates. </think>Thursday is correct.<|im_end|>', 'on')).toEqual({
      thinking: 'Let me check the dates. ',
      content: 'Thursday is correct.'
    })
  })

  test('handles explicit thinking markers and removes other special tokens', () => {
    expect(
      splitLfm3ThinkingText('<think>Compare the two dates.</think>The deadline is Thursday.<|endoftext|>', 'on')
    ).toEqual({ thinking: 'Compare the two dates.', content: 'The deadline is Thursday.' })
  })

  test('routes unmarked output to the answer when thinking is disabled', () => {
    expect(splitLfm3ThinkingText('The answer is 42.<|im_end|>', 'off')).toEqual({
      thinking: '',
      content: 'The answer is 42.'
    })
  })
})
