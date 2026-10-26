import benchUrl from '../../assets/bench/librispeech-1272.wav?url'
import ausPilbaraUrl from '../../assets/bench/aus-pilbara.flac?url'
import ausSyrahUrl from '../../assets/bench/aus-syrah.flac?url'
import ausGoldroadUrl from '../../assets/bench/aus-goldroad.flac?url'
import lsOtherUrl from '../../assets/bench/librispeech-other.flac?url'
import type { BenchMode } from '../../../../shared/sttBench'
import type { DownloadProgress, SttEngine } from '../../../../shared/types'
import { isWebEngine } from '../../webStt'

/** Benchmark breakdown shown under a finished run. */
export type RunDetail = {
  /** Per-clip WER (Deep). */
  clips: { label: string; wer: number }[]
  subs: number
  dels: number
  ins: number
  warmMs: number
  loadMs?: number
  /** A few example substitutions ("a → of"). */
  examples: string[]
}

export type Run =
  | { state: 'running' }
  | { state: 'done'; text: string; ms: number; runtime?: string; wer?: number; speed?: number; detail?: RunDetail }
  | { state: 'error'; text: string }

export const CLIP_SECONDS = 6
export const SCORES_KEY = 'inkfish.sttScores'
export const HIDDEN_KEY = 'inkfish.sttHidden'

export const CLIP_URLS: Record<string, string> = {
  quick: benchUrl,
  'aus-pilbara': ausPilbaraUrl,
  'aus-syrah': ausSyrahUrl,
  'aus-goldroad': ausGoldroadUrl,
  'ls-other': lsOtherUrl
}

/** Last benchmark result per engine and mode, kept so the list stays comparable. */
export type Score = {
  wer: number
  /** Seconds of audio per second of decoding (model load excluded). */
  speed: number
  at: number
  /** Cold first run: model load, Core ML / WebGPU compile, first decode. */
  warmMs?: number
  /** Model load per run (native engines load in a fresh helper each run). */
  loadMs?: number
  subs?: number
  dels?: number
  ins?: number
  /** Per-clip WER (Deep). */
  clips?: Record<string, { wer: number; errors: number; words: number }>
}
export const scoresKey = (m: BenchMode): string => (m === 'quick' ? SCORES_KEY : `${SCORES_KEY}.${m}`)
export function loadScores(m: BenchMode = 'quick'): Record<string, Score> {
  try {
    const all = JSON.parse(localStorage.getItem(scoresKey(m)) || '{}') as Record<string, Score>
    // Scores over 100% came from a parsing bug (raw JSON scored as the
    // transcript) or a wedged run, not the model — drop them so a rerun replaces them.
    return Object.fromEntries(Object.entries(all).filter(([, v]) => v && v.wer <= 1))
  } catch {
    return {}
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, name: string, onTimeout?: () => void): Promise<T> {
  let t = 0
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      t = window.setTimeout(() => {
        onTimeout?.()
        reject(new Error(`${name} timed out after ${Math.round(ms / 1000)} s — skipped`))
      }, ms)
    })
  ]).finally(() => window.clearTimeout(t))
}

export function loadHidden(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]') as string[])
  } catch {
    return new Set()
  }
}

/** Duration of a 16 kHz mono 16-bit wav from toWav(). */
export const wavSeconds = (wav: Blob): number => Math.max(0, wav.size - 44) / 32000

export type Clip = { dataUrl: string; wav: Blob; label: string; seconds: number; reference?: string }

export const MIRRORS = [
  { url: '', label: 'Hugging Face' },
  { url: 'https://hf-mirror.com', label: 'hf-mirror.com' }
]

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(n / 1e6))} MB`
}

/** Size to compare on: measured on disk when downloaded, else the published estimate. */
export const sizeLabel = (e: SttEngine): string => (e.bytes ? fmtBytes(e.bytes) : e.size ? e.size : '—')

/** First size in a published label ("~464 MB", "~1.2 GB GPU · 650 MB CPU") in bytes. */
export function estimateBytes(size?: string): number | undefined {
  const m = /([\d.]+)\s*(GB|MB)/i.exec(size ?? '')
  if (!m) return undefined
  return parseFloat(m[1]!) * (m[2]!.toUpperCase() === 'GB' ? 1e9 : 1e6)
}

export function phaseLabel(p: DownloadProgress, e?: SttEngine): string {
  const pct = `${Math.round(p.fraction * 100)}%`
  if (p.state === 'paused') return `Paused · ${pct}`
  if (p.state === 'retrying') return `Connection dropped — retrying (attempt ${p.attempt + 1} of 4)…`
  if (p.state === 'error') return p.blocked ? "Couldn't reach the model host" : 'Download failed'
  if (p.phase === 'listing') return 'Finding files…'
  if (p.phase === 'compiling') {
    return isWebEngine(p.id) ? 'Loading model…' : `Preparing on the GPU · ${pct}`
  }
  // Real byte counts when the downloader gives them, else an estimate from the model's size.
  let amount = ''
  if (p.bytes !== undefined && p.totalBytes) amount = ` · ${fmtBytes(p.bytes)} of ${fmtBytes(p.totalBytes)}`
  else if (p.bytes !== undefined) amount = ` · ${fmtBytes(p.bytes)} downloaded`
  else {
    const est = estimateBytes(e?.size)
    if (est && p.fraction > 0) amount = ` · ~${fmtBytes(p.fraction * est)} of ${fmtBytes(est)}`
  }
  const files = p.total > 1 ? ` · file ${Math.min(p.files + 1, p.total)} of ${p.total}` : ''
  const unknown = p.bytes !== undefined && !p.totalBytes
  return `${unknown ? 'Downloading' : pct}${amount}${files}`
}
