import type { SttResult } from '../../shared/types'
import { loadAudioPrefs } from './audio'

/**
 * Experimental selected-file Qwen3-ASR 0.6B. No live/streaming recognition.
 * The bridge and model artifacts are version-pinned remote URLs; bridge uses
 * its own Cache Storage namespace. Model/projector total about 1.02 GB.
 */
export const QWEN_ASR_ENGINE = {
  id: 'web-qwen3-asr-06b',
  name: 'Qwen3-ASR 0.6B · Experimental',
  subtitle: 'llama-web-bridge v0.1.44 · WebGPU/WASM worker · selected WAV only',
  family: 'qwen',
  size: '~1.02 GB model + projector',
  languages: 'Multilingual (30 languages; experimental)',
  caches: ['inkfish-qwen3-asr-bridge-v1']
}

export interface QwenProgress {
  loaded: number
  total?: number
  file?: string
  phase: 'downloading' | 'loading'
}
type Heard = { text: string; runtime: string }
type Load = (progress: (p: QwenProgress) => void) => Promise<(pcm: Float32Array) => Promise<Heard>>

const MODEL_REVISION = '928ab958557df9aa2ef1c93e0e83c7ad0933fae2'
const MODEL = `https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/${MODEL_REVISION}/Qwen3-ASR-0.6B-Q8_0.gguf`
const PROJECTOR = `https://huggingface.co/ggml-org/Qwen3-ASR-0.6B-GGUF/resolve/${MODEL_REVISION}/mmproj-Qwen3-ASR-0.6B-Q8_0.gguf`

export class QwenAsrClient {
  private worker: Worker
  private seq = 0
  private stopped = false
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; progress?: (p: QwenProgress) => void }
  >()
  constructor() {
    this.worker = new Worker(new URL('./qwenAsr.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (e: MessageEvent<any>) => {
      const m = e.data,
        p = this.pending.get(m.seq)
      if (!p) return
      if (m.progress) {
        p.progress?.(m.progress)
        return
      }
      this.pending.delete(m.seq)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result)
    }
    this.worker.onerror = (e) => this.dispose(e.message || 'Qwen ASR worker failed')
    this.worker.onmessageerror = () => this.dispose('Qwen ASR worker returned unreadable data')
  }
  private request(action: string, fields: object = {}, progress?: (p: QwenProgress) => void): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Qwen ASR worker stopped; prepare again'))
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, progress })
      try {
        this.worker.postMessage({ action, seq, ...fields })
      } catch (e) {
        this.pending.delete(seq)
        reject(e)
      }
    })
  }
  async prepare(onProgress: (p: QwenProgress) => void): Promise<void> {
    const assets = new URL('qwen-runtime/', document.baseURI).href
    const mirror = loadAudioPrefs().modelMirror
    await this.request('prepare', { assets, model: MODEL, projector: PROJECTOR, mirror }, onProgress)
  }
  transcribe(pcm: Float32Array): Promise<Heard> {
    return this.request('transcribe', { pcm })
  }
  dispose(reason = 'Qwen ASR unloaded'): void {
    if (this.stopped) return
    this.stopped = true
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
}

let client: QwenAsrClient | null = null
/** WebEngine-compatible load contract; caller retains disposer via disposeQwenAsr(). */
export const loadQwenAsr: Load = async (progress) => {
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')
    throw new Error('Qwen ASR requires WebAssembly and module workers')
  const c = new QwenAsrClient()
  client = c
  try {
    await c.prepare(progress)
  } catch (e) {
    c.dispose()
    if (client === c) client = null
    throw e
  }
  return async (pcm) => {
    const chunks = splitQwenWindows(pcm, 16_000, 30)
    const texts: string[] = []
    let runtime = 'WebGPU/WASM bridge'
    for (const part of chunks) {
      const r = await c.transcribe(part)
      if (r.text.trim()) texts.push(r.text.trim())
      runtime = r.runtime
    }
    return { text: texts.join(' '), runtime }
  }
}
export function disposeQwenAsr(): void {
  client?.dispose()
  client = null
}
export async function transcribeQwenAsr(pcm: Float32Array): Promise<SttResult> {
  if (!client) throw new Error('Prepare the Qwen3-ASR engine before transcription')
  const start = performance.now(),
    pieces: string[] = []
  let runtime = 'WebGPU/WASM bridge'
  for (const p of splitQwenWindows(pcm, 16_000, 30)) {
    const r = await client.transcribe(p)
    if (r.text.trim()) pieces.push(r.text.trim())
    runtime = r.runtime
  }
  const text = pieces.join(' ').replace(/\s+/g, ' ').trim()
  return {
    text,
    segments: text ? [{ start: 0, end: pcm.length / 16_000, text }] : [],
    provider: QWEN_ASR_ENGINE.id,
    engine: QWEN_ASR_ENGINE.name,
    runtime,
    ms: Math.round(performance.now() - start)
  }
}

/** Cut at the quietest point within the last 4 seconds of each <=30s window. */
export function splitQwenWindows(pcm: Float32Array, rate: number, maxSeconds: number): Float32Array[] {
  const max = Math.floor(rate * maxSeconds),
    search = rate * 4,
    hop = Math.max(1, Math.floor(rate * 0.05)),
    out: Float32Array[] = []
  for (let start = 0; start < pcm.length;) {
    let end = Math.min(start + max, pcm.length)
    if (end < pcm.length) {
      const lo = Math.max(start + 1, end - search)
      let best = end,
        energy = Infinity
      for (let i = lo; i < end; i += hop) {
        let e = 0
        const n = Math.min(i + hop, end)
        for (let j = i; j < n; j++) {
          const sample = pcm[j] ?? 0
          e += sample * sample
        }
        e /= n - i
        if (e < energy) {
          energy = e
          best = i
        }
      }
      if (best > start + rate) end = best
    }
    out.push(pcm.slice(start, end))
    start = end
  }
  return out
}
