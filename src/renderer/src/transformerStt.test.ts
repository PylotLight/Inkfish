import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { TransformerClient } from './transformerStt'

type Posted = Record<string, any>
class FakeWorker {
  static instances: FakeWorker[] = []
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  posted: Posted[] = []
  terminateCount = 0
  throwOnPost: unknown = null
  constructor(_url: URL, _options?: WorkerOptions) {
    FakeWorker.instances.push(this)
  }
  postMessage(message: any): void {
    if (this.throwOnPost) throw this.throwOnPost
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
  Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: originalWorker })
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage)
  else delete (globalThis as any).localStorage
})

const clientWithWorker = () => {
  const client = new TransformerClient()
  return { client, worker: FakeWorker.instances.at(-1)! }
}

describe('TransformerClient', () => {
  test('prepare carries modelMirror from localStorage and progress does not resolve the request', async () => {
    const { client, worker } = clientWithWorker()
    let settled = false
    const progressCalls: unknown[] = []
    const progress = (value: unknown) => progressCalls.push(value)
    const prepared = client.prepare('model-x', progress).then(() => {
      settled = true
    })
    const req = worker.posted[0]!
    expect(req).toMatchObject({ action: 'prepare', id: 'model-x', mirror: 'https://mirror.example' })
    worker.reply({ seq: req.seq, progress: { status: 'downloading', loaded: 1, total: 2 } })
    await Promise.resolve()
    expect(progressCalls).toHaveLength(1)
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

  test('routes concurrent replies by sequence number', async () => {
    const { client, worker } = clientWithWorker()
    const a = client.transcribe(new Float32Array([1]))
    const b = client.transcribe(new Float32Array([2]))
    worker.reply({ seq: worker.posted[1]!.seq, result: { text: 'second', runtime: 'b' } })
    worker.reply({ seq: worker.posted[0]!.seq, result: { text: 'first', runtime: 'a' } })
    await expect(Promise.all([a, b])).resolves.toEqual([
      { text: 'first', runtime: 'a' },
      { text: 'second', runtime: 'b' }
    ])
    client.dispose()
  })

  test('rejects an error reply', async () => {
    const { client, worker } = clientWithWorker()
    const promise = client.transcribe(new Float32Array())
    worker.reply({ seq: worker.posted[0]!.seq, error: 'model failed' })
    await expect(promise).rejects.toThrow('model failed')
    client.dispose()
  })

  test('dispose terminates and rejects pending and future calls', async () => {
    const { client, worker } = clientWithWorker()
    const pending = client.transcribe(new Float32Array())
    client.dispose('unloaded')
    expect(worker.terminateCount).toBe(1)
    await expect(pending).rejects.toThrow('unloaded')
    await expect(client.transcribe(new Float32Array())).rejects.toThrow('STT worker was stopped')
    client.dispose()
    expect(worker.terminateCount).toBe(1)
  })

  test('worker onerror terminates and rejects pending work', async () => {
    const { client, worker } = clientWithWorker()
    const pending = client.transcribe(new Float32Array())
    worker.onerror?.({ message: 'worker crashed' } as ErrorEvent)
    expect(worker.terminateCount).toBe(1)
    await expect(pending).rejects.toThrow('worker crashed')
    await expect(client.transcribe(new Float32Array())).rejects.toThrow('STT worker was stopped')
  })

  test('rejects when postMessage throws', async () => {
    const { client, worker } = clientWithWorker()
    const failure = new Error('clone failed')
    worker.throwOnPost = failure
    await expect(client.transcribe(new Float32Array())).rejects.toBe(failure)
    expect(worker.posted).toHaveLength(0)
    client.dispose()
  })
})
