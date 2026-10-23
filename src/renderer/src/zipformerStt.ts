import type { WebProgress } from './webStt'

const CACHE = 'inkfish-zipformer-wasm-909bffc-v1'
type Heard = { text: string; runtime: string }
type WorkerReply =
  | { id: number; ok: true; text?: string; runtime?: string }
  | { id: number; ok: false; error: string }
  | { progress: WebProgress }
type WorkerResult = Exclude<WorkerReply, { progress: WebProgress }>

let active: ZipformerClient | null = null

class ZipformerClient {
  private worker: Worker
  private next = 1
  private pending = new Map<number, { resolve: (r: WorkerResult) => void; reject: (e: Error) => void }>()
  private onProgress: (p: WebProgress) => void
  constructor(progress: (p: WebProgress) => void) {
    this.onProgress = progress
    // Keep this statically analyzable so Vite bundles the worker with the app.
    // The worker intentionally stays classic because the upstream Emscripten
    // glue is loaded with importScripts().
    this.worker = new Worker(new URL('./zipformerStt.worker.ts', import.meta.url), { type: 'classic' })
    this.worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      const data = event.data
      if ('progress' in data) {
        this.onProgress(data.progress)
        return
      }
      const p = this.pending.get(data.id)
      if (!p) return
      this.pending.delete(data.id)
      if (data.ok) p.resolve(data)
      else p.reject(new Error(data.error))
    }
    this.worker.onerror = (event) => this.failAll(new Error(event.message || 'Zipformer worker failed'))
  }
  private request(message: object, transfer: Transferable[] = []): Promise<WorkerResult> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...message, id }, transfer)
    })
  }
  async load(): Promise<void> {
    const result = await this.request({ type: 'load' })
    if (!result.ok) throw new Error(result.error)
  }
  async transcribe(pcm: Float32Array): Promise<Heard> {
    const copy = pcm.slice()
    const result = await this.request({ type: 'transcribe', pcm: copy.buffer }, [copy.buffer])
    if (!result.ok) throw new Error(result.error)
    return { text: result.text ?? '', runtime: result.runtime ?? 'WASM · Zipformer Small LibriSpeech' }
  }
  dispose(): void {
    this.worker.postMessage({ type: 'dispose' })
    this.worker.terminate()
    this.failAll(new Error('Zipformer worker disposed'))
    if (active === this) active = null
  }
  private failAll(error: Error): void {
    for (const p of this.pending.values()) p.reject(error)
    this.pending.clear()
  }
}

/** WebEngine-compatible adapter for wundr-ai/zipformer-small-librispeech-en-wasm. */
export const ZIPFORMER_ENGINE = {
  id: 'web-zipformer-small',
  name: 'Zipformer Small · Web',
  subtitle: 'sherpa-onnx WASM · LibriSpeech English',
  family: 'sherpa-onnx',
  size: '~39.9 MB',
  languages: 'English',
  caches: [CACHE],
  load: async (_gpu: { ok: boolean; label: string }, onProgress: (p: WebProgress) => void) => {
    active?.dispose()
    const client = new ZipformerClient(onProgress)
    active = client
    try {
      await client.load()
    } catch (e) {
      client.dispose()
      throw e
    }
    return (pcm: Float32Array) => client.transcribe(pcm)
  }
}

export function disposeZipformer(): void {
  active?.dispose()
}
