/** Quantized ONNX weights only; tokenizer/config downloads add a little overhead. */
export const TRANSFORMER_ENGINES = [
  {
    id: 'web-wav2vec2-base-960h',
    name: 'Wav2Vec2 Base 960h · Web',
    subtitle: 'Experimental English CTC baseline · q8 CPU · no punctuation restoration',
    family: 'wav2vec2',
    size: '~95 MB',
    model: 'onnx-community/wav2vec2-base-960h-ONNX',
    kind: 'ctc',
    frameSize: 1
  },
  {
    id: 'web-moonshine-v2-small',
    name: 'Moonshine v2 Small · Web',
    subtitle: 'Experimental community ONNX export · q8 CPU · full-utterance, not live streaming',
    family: 'moonshine',
    size: '~158 MB',
    model: 'Workmind/moonshine-streaming-small-ONNX',
    kind: 'moonshine',
    frameSize: 80
  },
  {
    id: 'web-moonshine-tiny',
    name: 'Moonshine Tiny · Web',
    subtitle: 'Original Moonshine (not v2) · q8 CPU · smallest comparison',
    family: 'moonshine',
    size: '~28 MB',
    model: 'onnx-community/moonshine-tiny-ONNX',
    kind: 'moonshine',
    frameSize: 1
  },
  {
    id: 'web-moonshine-base',
    name: 'Moonshine Base · Web',
    subtitle: 'Original Moonshine (not v2) · q8 CPU',
    family: 'moonshine',
    size: '~63 MB',
    model: 'onnx-community/moonshine-base-ONNX',
    kind: 'moonshine',
    frameSize: 1
  },
  {
    id: 'web-whisper-tiny-en',
    name: 'Whisper Tiny.en · Web',
    subtitle: 'Whisper · q8 CPU · small English baseline',
    family: 'whisper',
    size: '~41 MB',
    model: 'onnx-community/whisper-tiny.en',
    kind: 'whisper',
    frameSize: 1
  },
  {
    id: 'web-whisper-base-en',
    name: 'Whisper Base.en · Web',
    subtitle: 'Whisper · q8 CPU · English baseline',
    family: 'whisper',
    size: '~77 MB',
    model: 'onnx-community/whisper-base.en',
    kind: 'whisper',
    frameSize: 1
  },
  {
    id: 'web-distil-whisper-small-en',
    name: 'Distil-Whisper Small.en · Web',
    subtitle: 'Distilled Whisper · q8 CPU · under-200 MB accuracy candidate',
    family: 'whisper',
    size: '~172 MB',
    model: 'distil-whisper/distil-small.en',
    kind: 'whisper',
    frameSize: 1
  }
] as const

export type TransformerEngine = (typeof TRANSFORMER_ENGINES)[number]
export const transformerCache = (id: string): string => `inkfish-stt-${id}-v1`

/** Moonshine v2's frontend cannot reshape a partial 5 ms frame. */
export function padAudio(pcm: Float32Array, frameSize: number): Float32Array {
  const n = Math.ceil(pcm.length / frameSize) * frameSize
  if (n === pcm.length) return pcm
  const padded = new Float32Array(n)
  padded.set(pcm)
  return padded
}

/** Keep Moonshine's full-utterance decoder bounded on long recordings. */
export function speechWindows(pcm: Float32Array, rate = 16_000, maxS = 20): Float32Array[] {
  const max = Math.floor(maxS * rate)
  if (pcm.length <= max) return [pcm]
  const hop = Math.max(1, Math.floor(rate * 0.05))
  const windows: Float32Array[] = []
  let start = 0
  while (pcm.length - start > max) {
    const end = start + max
    let best = end
    let quietest = Infinity
    for (let i = Math.max(start + hop, end - 4 * rate); i + hop <= end; i += hop) {
      let energy = 0
      for (let j = i; j < i + hop; j++) energy += pcm[j]! * pcm[j]!
      if (energy < quietest) {
        quietest = energy
        best = i + Math.floor(hop / 2)
      }
    }
    windows.push(pcm.subarray(start, best))
    start = best
  }
  windows.push(pcm.subarray(start))
  return windows
}

export interface TransformerProgress {
  loaded: number
  total?: number
  file?: string
  phase: 'downloading' | 'loading'
}

/** Progress callbacks are per file, including config/tokenizer files. */
export class DownloadTotals {
  private files = new Map<string, { loaded: number; total: number }>()

  update(p: { status: string; file?: string; loaded?: number; total?: number }): TransformerProgress | undefined {
    if (p.status !== 'progress' || !p.file) return undefined
    const previous = this.files.get(p.file)
    this.files.set(p.file, {
      loaded: Math.max(previous?.loaded ?? 0, p.loaded ?? 0),
      total: Math.max(previous?.total ?? 0, p.total ?? 0)
    })
    let loaded = 0
    let total = 0
    for (const value of this.files.values()) {
      loaded += value.loaded
      total += Math.max(value.loaded, value.total)
    }
    return { loaded, total: total || undefined, file: p.file, phase: 'downloading' }
  }
}

export type TransformerRequest =
  | { seq: number; action: 'prepare'; id: string; mirror: string }
  | { seq: number; action: 'transcribe'; pcm: Float32Array }

export type TransformerReply =
  | { seq: number; progress: TransformerProgress }
  | { seq: number; result: { text: string; runtime: string } }
  | { seq: number; error: string }
