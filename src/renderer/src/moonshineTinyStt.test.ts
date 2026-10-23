import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { MOONSHINE_TINY_ENGINE, TinyClient } from './moonshineTinyStt'

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
        key === 'inkfish.audio' ? JSON.stringify({ modelMirror: 'https://mirror.example' }) : null,
      setItem() {},
      removeItem() {},
      clear() {}
    }
  })
})
afterEach(() => {
  TinyClient.disposeAll()
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker })
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete (globalThis as any).localStorage
})
const clientWithWorker = () => {
  const client = new TinyClient()
  return { client, worker: FakeWorker.instances.at(-1)! }
}

describe('TinyClient', () => {
  test('prepare propagates mirror and progress without settling until completion', async () => {
    const { client, worker } = clientWithWorker()
    let settled = false
    const progressCalls: unknown[] = []
    const prepared = client
      .prepare('https://model-mirror.example', (p) => progressCalls.push(p))
      .then(() => {
        settled = true
      })
    const req = worker.posted[0]!
    expect(req).toMatchObject({ action: 'prepare', mirror: 'https://model-mirror.example' })
    worker.reply({ seq: req.seq, progress: { status: 'downloading', loaded: 1, total: 2 } })
    await Promise.resolve()
    expect(progressCalls).toEqual([{ status: 'downloading', loaded: 1, total: 2 }])
    expect(settled).toBe(false)
    worker.reply({ seq: req.seq, result: { text: '', runtime: '1ms' } })
    await prepared
    expect(settled).toBe(true)
    client.dispose()
  })

  test('transcribe posts PCM without detaching caller-owned memory', async () => {
    const { client, worker } = clientWithWorker()
    const pcm = new Float32Array([0.25, -0.5])
    const promise = client.transcribe(pcm)
    expect(worker.posted[0]).toMatchObject({ action: 'transcribe', pcm })
    expect([...pcm]).toEqual([0.25, -0.5])
    worker.reply({ seq: worker.posted[0]!.seq, result: { text: 'hello', runtime: '2ms' } })
    await expect(promise).resolves.toEqual({ text: 'hello', runtime: '2ms' })
    client.dispose()
  })

  for (const [event, expected] of [
    ['error', 'worker crashed'],
    ['messageerror', 'Moonshine Tiny worker returned unreadable data']
  ] as const) {
    test(`${event} rejects pending work`, async () => {
      const { client, worker } = clientWithWorker()
      const pending = client.transcribe(new Float32Array())
      if (event === 'error') worker.onerror?.({ message: expected } as ErrorEvent)
      else worker.onmessageerror?.()
      expect(worker.terminateCount).toBe(1)
      await expect(pending).rejects.toThrow(expected)
      await expect(client.transcribe(new Float32Array())).rejects.toThrow('Moonshine Tiny worker stopped')
    })
  }

  test('dispose is idempotent and rejects pending work', async () => {
    const { client, worker } = clientWithWorker()
    const pending = client.transcribe(new Float32Array())
    client.dispose('unloaded')
    client.dispose('again')
    expect(worker.terminateCount).toBe(1)
    await expect(pending).rejects.toThrow('unloaded')
  })

  test('disposeAll terminates every client', () => {
    const one = clientWithWorker()
    const two = clientWithWorker()
    TinyClient.disposeAll()
    expect(one.worker.terminateCount).toBe(1)
    expect(two.worker.terminateCount).toBe(1)
  })

  test('engine load disposes worker when prepare fails', async () => {
    const loading = MOONSHINE_TINY_ENGINE.load(undefined, () => {})
    const worker = FakeWorker.instances[0]!
    worker.reply({ seq: worker.posted[0]!.seq, error: 'prepare failed' })
    await expect(loading).rejects.toThrow('prepare failed')
    expect(worker.terminateCount).toBe(1)
  })

  test('engine load returns a closure that transcribes through its prepared client', async () => {
    const loading = MOONSHINE_TINY_ENGINE.load(undefined, () => {})
    const worker = FakeWorker.instances[0]!
    worker.reply({ seq: worker.posted[0]!.seq, result: { text: '', runtime: 'ready' } })
    const transcribe = await loading
    const pcm = new Float32Array([1, 2])
    const result = transcribe(pcm)
    const req = worker.posted[1]!
    expect(req).toMatchObject({ action: 'transcribe', pcm })
    expect([...pcm]).toEqual([1, 2])
    worker.reply({ seq: req.seq, result: { text: 'from closure', runtime: '3ms' } })
    await expect(result).resolves.toEqual({ text: 'from closure', runtime: '3ms' })
    TinyClient.disposeAll()
    expect(worker.terminateCount).toBe(1)
  })
})
