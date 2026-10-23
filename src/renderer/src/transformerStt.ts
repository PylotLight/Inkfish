import { loadAudioPrefs } from './audio'
import type { TransformerProgress, TransformerReply, TransformerRequest } from './transformerSttModels'

type Heard = { text: string; runtime: string }
type Request = TransformerRequest extends infer T ? (T extends { seq: number } ? Omit<T, 'seq'> : never) : never

/** One worker per loaded model; terminate on reset/delete, including in-flight work. */
export class TransformerClient {
  private worker: Worker
  private seq = 0
  private stopped = false
  private pending = new Map<
    number,
    {
      resolve: (result: Heard) => void
      reject: (error: Error) => void
      progress?: (p: TransformerProgress) => void
    }
  >()

  constructor() {
    this.worker = new Worker(new URL('./transformerStt.worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<TransformerReply>) => {
      const m = event.data
      const pending = this.pending.get(m.seq)
      if (!pending) return
      if ('progress' in m) {
        pending.progress?.(m.progress)
        return
      }
      this.pending.delete(m.seq)
      if ('error' in m) pending.reject(new Error(m.error))
      else pending.resolve(m.result)
    }
    this.worker.onerror = (event) => this.dispose(event.message || 'STT worker failed to start')
    this.worker.onmessageerror = () => this.dispose('STT worker returned an unreadable message')
  }

  private request(message: Request, progress?: (p: TransformerProgress) => void): Promise<Heard> {
    if (this.stopped) return Promise.reject(new Error('STT worker was stopped; prepare the model again'))
    const seq = ++this.seq
    return new Promise((resolve, reject) => {
      this.pending.set(seq, { resolve, reject, progress })
      try {
        // Clone PCM rather than detaching caller-owned benchmark audio.
        this.worker.postMessage({ ...message, seq })
      } catch (error) {
        this.pending.delete(seq)
        reject(error)
      }
    })
  }

  async prepare(id: string, progress: (p: TransformerProgress) => void): Promise<void> {
    await this.request({ action: 'prepare', id, mirror: loadAudioPrefs().modelMirror }, progress)
  }

  transcribe(pcm: Float32Array): Promise<Heard> {
    return this.request({ action: 'transcribe', pcm })
  }

  dispose(reason = 'STT model unloaded'): void {
    if (this.stopped) return
    this.stopped = true
    this.worker.terminate()
    for (const pending of this.pending.values()) pending.reject(new Error(reason))
    this.pending.clear()
  }
}
