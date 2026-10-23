import { loadAudioPrefs } from './audio'
import type { WebProgress } from './webStt'

interface Heard {
  text: string
  runtime: string
}
type Loaded = (pcm: Float32Array) => Promise<Heard>
type Reply = { seq: number; progress?: WebProgress; result?: Heard; error?: string }
type Pending = { resolve: (x: Heard) => void; reject: (e: Error) => void; progress?: (p: WebProgress) => void }

/** Experimental full-utterance harness; not live microphone/streaming transcription. */
export const MOONSHINE_TINY_ENGINE = {
  id: 'web-moonshine-streaming-tiny-int8-experimental',
  name: 'Moonshine Tiny INT8 · Experimental Web',
  subtitle: 'Experimental optimized ONNX · WASM CPU · known empty-output smoke failure; export investigation',
  family: 'moonshine',
  size: '~79.8 MB',
  languages: 'English',
  caches: ['inkfish-moonshine-tiny-int8-v1'],
  load: async (_gpu: unknown, onProgress: (p: WebProgress) => void): Promise<Loaded> => {
    const client = new TinyClient()
    try {
      await client.prepare(loadAudioPrefs().modelMirror, onProgress)
    } catch (error) {
      client.dispose()
      throw error
    }
    return (pcm) => client.transcribe(pcm)
  }
}

export function disposeMoonshineTiny(): void {
  TinyClient.disposeAll()
}

export class TinyClient {
  private static clients = new Set<TinyClient>()
  private readonly worker = new Worker(new URL('./moonshineTinyStt.worker.ts', import.meta.url), { type: 'module' })
  private seq = 0
  private stopped = false
  private pending = new Map<number, Pending>()
  constructor() {
    TinyClient.clients.add(this)
    this.worker.onmessage = (e: MessageEvent<Reply>) => {
      const m = e.data,
        p = this.pending.get(m.seq)
      if (!p) return
      if (m.progress) {
        p.progress?.(m.progress)
        return
      }
      this.pending.delete(m.seq)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.result ?? { text: '', runtime: 'WASM int8' })
    }
    this.worker.onerror = (e) => this.dispose(e.message || 'Moonshine Tiny worker failed')
    this.worker.onmessageerror = () => this.dispose('Moonshine Tiny worker returned unreadable data')
  }
  private request(message: object, progress?: (p: WebProgress) => void): Promise<Heard> {
    if (this.stopped) return Promise.reject(new Error('Moonshine Tiny worker stopped'))
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, progress })
      try {
        this.worker.postMessage({ ...message, seq })
      } catch (e) {
        this.pending.delete(seq)
        reject(e)
      }
    })
  }
  async prepare(mirror: string | undefined, progress: (p: WebProgress) => void): Promise<void> {
    await this.request({ action: 'prepare', mirror }, progress)
  }
  transcribe(pcm: Float32Array): Promise<Heard> {
    return this.request({ action: 'transcribe', pcm })
  }
  dispose(reason = 'Moonshine Tiny unloaded'): void {
    if (this.stopped) return
    this.stopped = true
    TinyClient.clients.delete(this)
    this.worker.terminate()
    for (const p of this.pending.values()) p.reject(new Error(reason))
    this.pending.clear()
  }
  static disposeAll(): void {
    for (const c of [...TinyClient.clients]) c.dispose()
  }
}
