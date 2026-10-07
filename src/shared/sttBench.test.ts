import { expect, test } from 'bun:test'
import { normalizeWords, speedFactor, wordErrorRate } from './sttBench'

test('normalizes punctuation, case and spellings', () => {
  expect(normalizeWords("Mr. Quilter's  well-known, colour!")).toEqual(['mister', "quilter's", 'well', 'known', 'color'])
})

test('word error rate counts subs, insertions and deletions', () => {
  expect(wordErrorRate('the cat sat on the mat', 'The cat sat on the mat.').wer).toBe(0)
  expect(wordErrorRate('the cat sat on the mat', 'the bat sat on mat').errors).toBe(2)
  expect(wordErrorRate('a b', 'a b c d').wer).toBe(1)
})

test('speed factor', () => {
  expect(speedFactor(60, 2000)).toBe(30)
})
