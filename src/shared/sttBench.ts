/**
 * Speech-to-text benchmark: word error rate against a known transcript, plus
 * speed as a multiple of real time. Shared by Settings › Voice Engine and
 * `bun run bench:stt`.
 *
 * Two modes:
 *  - Quick: one 79 s clip of clean read English — the same yardstick every run.
 *  - Deep: ~5 min across harder clips — Australian-accented business English
 *    (earnings calls: numbers, names, jargon, disfluent speech) and the harder
 *    LibriSpeech "other" set (13 different speakers) — scored per clip.
 */

export interface BenchClip {
  id: string
  /** File under src/renderer/src/assets/bench/. */
  file: string
  /** Short label for tables. */
  label: string
  /** Accent / style shown beside the score. */
  kind: string
  seconds: number
  source: string
  text: string
}

/** Bundled clip: src/renderer/src/assets/bench/librispeech-1272.wav */
export const BENCH_CLIP: BenchClip = {
  id: 'quick',
  label: 'Clean read',
  kind: 'US read speech',
  file: 'librispeech-1272.wav',
  seconds: 79.42,
  source:
    'LibriSpeech dev-clean (CC BY 4.0, openslr.org/12), speaker 1272, utterances: 1272-135031-0003, 1272-135031-0004, 1272-135031-0005, 1272-135031-0006, 1272-135031-0017, 1272-135031-0020, 1272-141231-0003, 1272-141231-0005, 1272-141231-0007, 1272-141231-0011, 1272-141231-0018, 1272-141231-0019, 1272-141231-0021, 1272-141231-0029',
  text: "the little girl had been asleep but she heard the raps and opened the door the king has fled in disgrace and your friends are asking for you i begged ruggedo long ago to send him away but he would not do so i also offered to help your brother to escape but he would not go however if we look sharp we may be able to discover one of these secret ways i don't believe ann knew any magic or she'd have worked it before his instant of panic was followed by a small sharp blow high on his chest a minute is not a very large measure of time and his body needed every fraction of it only his heart and lungs worked on at a strong measured rate the other voice snapped with a harsh urgency clearly used to command a red haired mountain of a man with an apparently inexhaustible store of energy there could be little art in this last and final round of fencing every man who entered the twenties had his own training tricks he thought it was a last burst of energy he knew how close they both were to exhaustion"
}

/** Deep benchmark: harder, longer, more varied — Australian English first. */
export const DEEP_CLIPS: BenchClip[] = [
  {
    id: 'aus-pilbara',
    file: 'aus-pilbara.flac',
    label: 'Aussie call 1',
    kind: 'Australian · mining ops',
    seconds: 60.12,
    source:
      'Earnings-22 (Rev.com, CC BY-SA 4.0, huggingface.co/datasets/distil-whisper/earnings22), file 4482983 (Pilbara Minerals), segments without [inaudible]',
    text: "Thanks Ken, and good morning, everyone. So basically a little bit about the operation. A quick touch on on the reserve update that we did during the quarter, and then to finish, I'll provide some environment for the projects, uh space expansion plans, which we've got coming up. starting to ramp those up, both simultaneously. Uh, so growth quarter, but we have definitely had some growing pains and convention. That being said, the cause is fairly solid production, um, and 84,000 tons at the low end of their guidance. Recovery: 62% average across uh, both operations. From a mining perspective. and mining contractors, as seen. Moving from mining and stepping into each of the processing plants. So with Pilgan processing um, for the quarter, uh, average of 65%, the same recovery."
  },
  {
    id: 'aus-syrah',
    file: 'aus-syrah.flac',
    label: 'Aussie call 2',
    kind: 'Australian · markets, numbers',
    seconds: 66.32,
    source:
      'Earnings-22 (Rev.com, CC BY-SA 4.0, huggingface.co/datasets/distil-whisper/earnings22), file 4482976 (Syrah Resources), segments without [inaudible]',
    text: "Thank you Sean and good morning everyone. Slide six shows our primary lending indicator. Global electric vehicle sales. Very positive momentum continued in EV sales and penetration in the fourth quarter. Globally, these sales are more than 850,000 units in December 2021 alone, a staggering outcome when compared to four year results at just over two million units only two years ago. EV sales and factory demand growth are obviously causing a strong momentum to flow through the demand for an Earth material. And Q4 representing an almost 50% increase on the fourth quarter on the prior year. The trend on this front has been very strong over the past 18 months, and our interaction with Spherical Graphite Processes in China demonstrated very robust demand. And that's highlighted on slide seven, the upstream natural graphite funds market and the strong demand conditions coincide with supply disruption amongst China's domestic producers."
  },
  {
    id: 'aus-goldroad',
    file: 'aus-goldroad.flac',
    label: 'Aussie call 3',
    kind: 'Australian · finance, two speakers',
    seconds: 59.98,
    source:
      'Earnings-22 (Rev.com, CC BY-SA 4.0, huggingface.co/datasets/distil-whisper/earnings22), file 4482968 (Gold Road Resources), segments without [inaudible]',
    text: "Uh, we remain debts free, and cash and equivalents lifted 135.5 million. In October we paid a fully franked dividend for the six months, uh, so the 30th of June, 2021. The cashflow waterfall summarizes the movements of cash equivalents, over the quarter. I'll now here go, uh, to Andrew, uh, to talk through the exploration update. Thanks, Duncan. Uh, the Discovery team continue to focus their efforts on systematic and targeted exploration over the priority prospects in the Southern project area of the Yamana project. However, early results received to date have been encouraging. A budget of $30 million has been allocated to the Discovery project for 2022, which is slightly less than the final 2021 budget stands. There is currently an RT rig on site, as I speak, and a diamond rig will be remobilizing shortly. A further two aircore rigs are expected soon. Today, we announce a 70% increase in our 100% owned Yamana resources."
  },
  {
    id: 'ls-other',
    file: 'librispeech-other.flac',
    label: 'Hard read',
    kind: '13 speakers, LibriSpeech other',
    seconds: 101.55,
    source:
      'LibriSpeech test-other (CC BY 4.0, openslr.org/12), utterances: 3005-163389-0000, 6432-63722-0000, 7018-75788-0000, 8280-266249-0000, 2033-164915-0001, 3528-168656-0001, 2414-128292-0006, 4294-14317-0000, 8188-274364-0001, 367-293981-0001, 5484-24317-0002, 3080-5040-0000, 4198-12281-0003',
    text: "they swarmed up in front of sherburn's palings as thick as they could jam together and you couldn't hear yourself think for the noise but scuse me didn't yo figger on doin some detectin an give up fishin then i took up a great stone from among the trees and coming up to him smote him therewith on the head with all my might and crushed in his skull as he lay dead drunk old mister dinsmore had accepted a pressing invitation from his granddaughter and her husband to join the party and with the addition of servants it was a large one then she threw herself upon him and he gathered her to his bosom and the twain fell down in a fainting fit it was her pleasure and her vanity to drag in these names on every pretext now do i hear six old fools legs rattling behind one another as i thought that this was due to some fault in the earth i wanted to make these first experiments before i undertook my perseus in the government of ireland his administration had been equally promotive of his master's interest and that of the subjects committed to his care i say so continued don quixote because i hate taking away anyone's good name she would appear herself at dessert and the banquet must therefore begin at an unusually early hour would it would leave me and then i could believe i shall not always have occasion for it by the virtue of god why do not you sing panniers farewell vintage is done"
  }
]

export type BenchMode = 'quick' | 'deep'

export const BENCH_MODES: Record<BenchMode, { label: string; clips: BenchClip[] }> = {
  quick: { label: 'Quick', clips: [BENCH_CLIP] },
  deep: { label: 'Deep', clips: DEEP_CLIPS }
}

export const modeSeconds = (m: BenchMode): number => BENCH_MODES[m].clips.reduce((a, c) => a + c.seconds, 0)

const SPELLINGS: Record<string, string> = {
  mr: 'mister',
  mrs: 'missus',
  dr: 'doctor',
  st: 'saint',
  ok: 'okay',
  percent: 'percent',
  aircore: 'air core',
  cashflow: 'cash flow',
  recognise: 'recognize',
  colour: 'color',
  grey: 'gray',
  favour: 'favor'
}

/** Hesitations: dropped from both sides so "uh"/"um" never count as errors. */
const FILLERS = new Set(['uh', 'um', 'umm', 'er', 'erm', 'ah', 'eh', 'hmm', 'mm', 'mhm', 'uhm'])

const ONES =
  'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(
    ' '
  )
const TENS = ' ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ')

function under1000(n: number): string[] {
  const out: string[] = []
  if (n >= 100) {
    out.push(ONES[Math.floor(n / 100)]!, 'hundred')
    n %= 100
    if (!n) return out
  }
  if (n < 20) out.push(ONES[n]!)
  else {
    out.push(TENS[Math.floor(n / 10)]!)
    if (n % 10) out.push(ONES[n % 10]!)
  }
  return out
}

/** Integer to words ("84000" → eighty four thousand); years read as pairs ("2021" → twenty twenty one). */
export function numberWords(digits: string): string[] {
  const n = Number(digits)
  if (!Number.isFinite(n) || digits.length > 12) return digits.split('').map((d) => ONES[Number(d)]!)
  if (n >= 1100 && n < 2100 && digits.length === 4 && n % 100 !== 0 && !(n >= 2000 && n < 2010)) {
    const hi = under1000(Math.floor(n / 100))
    const lo = n % 100
    return [...hi, ...(lo < 10 ? ['oh', ONES[lo]!] : under1000(lo))]
  }
  if (n === 0) return ['zero']
  const out: string[] = []
  const scales: [number, string][] = [
    [1e9, 'billion'],
    [1e6, 'million'],
    [1e3, 'thousand']
  ]
  let r = n
  for (const [v, w] of scales) {
    if (r >= v) {
      out.push(...under1000(Math.floor(r / v)), w)
      r %= v
    }
  }
  if (r) out.push(...under1000(r))
  return out
}

/** Spell out numbers, money and percentages so "$30 million" and "thirty million dollars" score the same. */
function spellNumbers(s: string): string {
  return s
    .replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\$\s?(\d+(?:\.\d+)?)\s*(million|billion|thousand|m|bn|k)?\b/gi, (_, num: string, scale?: string) => {
      const sc = scale ? ({ m: 'million', bn: 'billion', k: 'thousand' }[scale.toLowerCase()] ?? scale) : ''
      return ` ${num} ${sc} dollars `
    })
    .replace(/(\d+(?:\.\d+)?)\s?%/g, ' $1 percent ')
    .replace(/(\d+)(st|nd|rd|th)\b/gi, ' $1 ')
    .replace(/\d+(?:\.\d+)?/g, (m) => {
      const [int, frac] = m.split('.')
      const words = numberWords(int!)
      if (frac) words.push('point', ...frac.split('').map((d) => ONES[Number(d)]!))
      return ` ${words.join(' ')} `
    })
}

/** Lowercase words, numbers spelled out, punctuation dropped, hyphens split, fillers and common spellings folded. */
export function normalizeWords(s: string): string[] {
  return spellNumbers(s.toLowerCase().replace(/[\u2018\u2019]/g, "'"))
    .replace(/[-\u2013\u2014/]/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''))
    .filter((w) => w && !FILLERS.has(w))
    .flatMap((w) => (SPELLINGS[w] ?? w).split(' '))
}

export interface WerResult {
  /** 0..1+ (can exceed 1 with many insertions). */
  wer: number
  words: number
  errors: number
  /** Breakdown: wrong word, missed word, extra word. */
  subs: number
  dels: number
  ins: number
  /** Up to 8 most frequent substitutions, "heard → said". */
  confusions: string[]
}

/** Word error rate: (substitutions + deletions + insertions) / reference words, with the breakdown. */
export function wordErrorRate(reference: string, hypothesis: string): WerResult {
  const ref = normalizeWords(reference)
  const hyp = normalizeWords(hypothesis)
  const R = ref.length
  const H = hyp.length
  // Full table for the backtrace (benchmark clips are a few hundred words).
  const d: Uint32Array[] = Array.from({ length: R + 1 }, () => new Uint32Array(H + 1))
  for (let j = 0; j <= H; j++) d[0]![j] = j
  for (let i = 1; i <= R; i++) {
    const row = d[i]!
    const up = d[i - 1]!
    row[0] = i
    for (let j = 1; j <= H; j++) {
      row[j] = Math.min(up[j - 1]! + (ref[i - 1] === hyp[j - 1] ? 0 : 1), up[j]! + 1, row[j - 1]! + 1)
    }
  }
  let subs = 0
  let dels = 0
  let ins = 0
  const conf = new Map<string, number>()
  let i = R
  let j = H
  // Prefer matches, then missed/extra words, then substitutions, for a readable alignment.
  while (i > 0 || j > 0) {
    const cur = d[i]![j]!
    if (i > 0 && j > 0 && ref[i - 1] === hyp[j - 1] && cur === d[i - 1]![j - 1]!) {
      i--
      j--
    } else if (i > 0 && cur === d[i - 1]![j]! + 1) {
      dels++
      i--
    } else if (j > 0 && cur === d[i]![j - 1]! + 1) {
      ins++
      j--
    } else {
      subs++
      const k = `${hyp[j - 1]} → ${ref[i - 1]}`
      conf.set(k, (conf.get(k) ?? 0) + 1)
      i--
      j--
    }
  }
  const errors = d[R]![H]!
  const confusions = [...conf.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k)
  return { wer: R ? errors / R : H ? 1 : 0, words: R, errors, subs, dels, ins, confusions }
}

/** Corpus-level WER over several clips: total errors / total reference words. */
export function corpusWer(results: Pick<WerResult, 'errors' | 'words'>[]): number {
  const words = results.reduce((a, r) => a + r.words, 0)
  return words ? results.reduce((a, r) => a + r.errors, 0) / words : 0
}

/** Seconds of audio transcribed per second of wall time. */
export function speedFactor(audioSeconds: number, ms: number): number {
  return ms > 0 ? audioSeconds / (ms / 1000) : 0
}

export const fmtWer = (wer: number): string => `${(wer * 100).toFixed(wer < 0.1 ? 1 : 0)}%`
export const fmtMsShort = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`
export const fmtSpeed = (x: number): string => `${x >= 10 ? Math.round(x) : x.toFixed(1)}× real time`
