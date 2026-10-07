import { expect, test } from 'bun:test'
import { corpusWer, DEEP_CLIPS, normalizeWords, speedFactor, wordErrorRate } from './sttBench'

test('normalizes punctuation, case and spellings', () => {
  expect(normalizeWords("Mr. Quilter's  well-known, colour!")).toEqual([
    'mister',
    "quilter's",
    'well',
    'known',
    'color'
  ])
})

test('word error rate counts subs, insertions and deletions', () => {
  expect(wordErrorRate('the cat sat on the mat', 'The cat sat on the mat.').wer).toBe(0)
  expect(wordErrorRate('the cat sat on the mat', 'the bat sat on mat').errors).toBe(2)
  expect(wordErrorRate('a b', 'a b c d').wer).toBe(1)
})

test('speed factor', () => {
  expect(speedFactor(60, 2000)).toBe(30)
})

test('breakdown splits subs, deletions and insertions', () => {
  const r = wordErrorRate('the cat sat on the mat', 'the bat sat on mat today')
  expect([r.subs, r.dels, r.ins]).toEqual([1, 1, 1])
  expect(r.confusions).toEqual(['bat → cat'])
})

test('numbers, money, percent and fillers normalise', () => {
  expect(normalizeWords('Uh, 84,000 tons at 62%')).toEqual([
    'eighty',
    'four',
    'thousand',
    'tons',
    'at',
    'sixty',
    'two',
    'percent'
  ])
  expect(normalizeWords('$30 million in 2021')).toEqual([
    'thirty',
    'million',
    'dollars',
    'in',
    'twenty',
    'twenty',
    'one'
  ])
  expect(wordErrorRate('lifted 135.5 million', 'lifted one hundred thirty five point five million').wer).toBe(0)
})

test('deep clips have references and sane lengths', () => {
  for (const c of DEEP_CLIPS) {
    expect(normalizeWords(c.text).length).toBeGreaterThan(100)
    expect(c.seconds).toBeGreaterThan(50)
  }
  expect(
    corpusWer([
      { errors: 1, words: 10 },
      { errors: 3, words: 10 }
    ])
  ).toBe(0.2)
})
