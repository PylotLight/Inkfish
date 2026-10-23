import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { QwenAsrClient, splitQwenWindows } from './qwenAsr'

type Posted = Record<string, any>
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  posted: Posted[] = []
  terminateCount = 0
  constructor(_url: URL, _options?: WorkerOptions) {
    FakeWorker.instances.push(this)
  }
  postMessage(message: any): void {
    this.posted.push(message)
  }
  terminate(): void {
    this.terminateCount++
  }
  reply(data: any): void {
    this.onmessage?.({ data } as MessageEvent)
  }
}
const originalWorker = globalThis.Worker
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
beforeEach(() => {
  FakeWorker.instances = []
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: FakeWorker as unknown as typeof Worker
  })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) =>
        key === 'inkfish.audio' ? JSON.stringify({ modelMirror: 'https://mirror.example/' }) : null
    }
  })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'https://app.example/' } })
})
afterEach(() => {
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker })
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete (globalThis as any).localStorage
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else delete (globalThis as any).document
})
const clientWithWorker = () => {
  const client = new QwenAsrClient()
  return { client, worker: FakeWorker.instances.at(-1)! }
}

describe('QwenAsrClient lifecycle', () => {
  test('prepare includes mirror and reports progress without settling before result', async () => {
    const { client, worker } = clientWithWorker()
    const progress: unknown[] = []
    let settled = false
    const prepared = client
      .prepare((p) => progress.push(p))
      .then(() => {
        settled = true
      })
    const request = worker.posted[0]!
    expect(request).toMatchObject({ action: 'prepare', mirror: 'https://mirror.example/' })
    worker.reply({ seq: request.seq, progress: { loaded: 1, phase: 'downloading' } })
    await Promise.resolve()
    expect(progress).toHaveLength(1)
    expect(settled).toBe(false)
    worker.reply({ seq: request.seq, result: true })
    await prepared
    client.dispose()
  })
  test('routes replies by sequence and dispose rejects pending exactly once', async () => {
    const { client, worker } = clientWithWorker()
    const first = client.transcribe(new Float32Array([1]))
    const second = client.transcribe(new Float32Array([2]))
    worker.reply({ seq: worker.posted[1]!.seq, result: { text: 'second', runtime: 'b' } })
    worker.reply({ seq: worker.posted[0]!.seq, result: { text: 'first', runtime: 'a' } })
    await expect(Promise.all([first, second])).resolves.toEqual([
      { text: 'first', runtime: 'a' },
      { text: 'second', runtime: 'b' }
    ])
    const pending = client.transcribe(new Float32Array([3]))
    client.dispose('unloaded')
    client.dispose()
    expect(worker.terminateCount).toBe(1)
    await expect(pending).rejects.toThrow('unloaded')
    await expect(client.transcribe(new Float32Array())).rejects.toThrow('stopped')
  })
  test('worker failure rejects all pending requests', async () => {
    const { client, worker } = clientWithWorker()
    const pending = client.prepare(() => {})
    worker.onerror?.({ message: 'crashed' } as ErrorEvent)
    await expect(pending).rejects.toThrow('crashed')
    expect(worker.terminateCount).toBe(1)
  })
})

describe('Qwen ASR windowing', () => {
  test('keeps a short input intact', () => {
    const pcm = Float32Array.from({ length: 8000 }, (_, i) => i / 8000)
    const parts = splitQwenWindows(pcm, 16_000, 30)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toEqual(pcm)
  })

  test('keeps every sample and caps long input at 30 seconds', () => {
    const pcm = new Float32Array(16_000 * 65).fill(0.1)
    const parts = splitQwenWindows(pcm, 16_000, 30)
    expect(parts.length).toBeGreaterThanOrEqual(3)
    expect(parts.every((p) => p.length <= 16_000 * 30)).toBe(true)
    expect(parts.reduce((sum, p) => sum + p.length, 0)).toBe(pcm.length)
  })
})
