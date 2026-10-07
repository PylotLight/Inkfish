/**
 * Speech-to-text benchmark: word error rate against a known transcript, plus
 * speed as a multiple of real time. Shared by Settings › Voice Engine and
 * `bun run bench:stt`.
 */

/** Bundled clip: src/renderer/src/assets/bench/librispeech-1272.wav */
export const BENCH_CLIP = {
  file: 'librispeech-1272.wav',
  seconds: 79.42,
  source: "LibriSpeech dev-clean (CC BY 4.0, openslr.org/12), speaker 1272, utterances: 1272-135031-0003, 1272-135031-0004, 1272-135031-0005, 1272-135031-0006, 1272-135031-0017, 1272-135031-0020, 1272-141231-0003, 1272-141231-0005, 1272-141231-0007, 1272-141231-0011, 1272-141231-0018, 1272-141231-0019, 1272-141231-0021, 1272-141231-0029",
  text: "the little girl had been asleep but she heard the raps and opened the door the king has fled in disgrace and your friends are asking for you i begged ruggedo long ago to send him away but he would not do so i also offered to help your brother to escape but he would not go however if we look sharp we may be able to discover one of these secret ways i don't believe ann knew any magic or she'd have worked it before his instant of panic was followed by a small sharp blow high on his chest a minute is not a very large measure of time and his body needed every fraction of it only his heart and lungs worked on at a strong measured rate the other voice snapped with a harsh urgency clearly used to command a red haired mountain of a man with an apparently inexhaustible store of energy there could be little art in this last and final round of fencing every man who entered the twenties had his own training tricks he thought it was a last burst of energy he knew how close they both were to exhaustion"
}

const SPELLINGS: Record<string, string> = {
  mr: 'mister',
  mrs: 'missus',
  dr: 'doctor',
  st: 'saint',
  ok: 'okay',
  recognise: 'recognize',
  colour: 'color',
  grey: 'gray',
  favour: 'favor'
}

/** Lowercase words, punctuation dropped, hyphens split, common spellings folded. */
export function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[-\u2013\u2014/]/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter(Boolean)
    .map((w) => SPELLINGS[w] ?? w)
}

export interface WerResult {
  /** 0..1+ (can exceed 1 with many insertions). */
  wer: number
  words: number
  errors: number
}

/** Word error rate: (substitutions + deletions + insertions) / reference words. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeWords(reference)
  const hyp = normalizeWords(hypothesis)
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j)
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i]
    for (let j = 1; j <= hyp.length; j++) {
      const sub = (prev[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1)
      cur[j] = Math.min(sub, (prev[j] as number) + 1, (cur[j - 1] as number) + 1)
    }
    prev = cur
  }
  const errors = prev[hyp.length] as number
  return { wer: ref.length ? errors / ref.length : hyp.length ? 1 : 0, words: ref.length, errors }
}

/** Seconds of audio transcribed per second of wall time. */
export function speedFactor(audioSeconds: number, ms: number): number {
  return ms > 0 ? audioSeconds / (ms / 1000) : 0
}

export const fmtWer = (wer: number): string => `${(wer * 100).toFixed(wer < 0.1 ? 1 : 0)}%`
export const fmtSpeed = (x: number): string => `${x >= 10 ? Math.round(x) : x.toFixed(1)}× real time`
