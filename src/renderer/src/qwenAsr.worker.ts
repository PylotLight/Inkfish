/// <reference lib="webworker" />

const CACHE_NAME = 'inkfish-qwen3-asr-bridge-v1'
const PROJECTOR_CACHE_NAME = 'inkfish-qwen3-asr-projector-v1'
const MAX_SECONDS = 30
const MODEL_BYTES = 804_749_248
const PROJECTOR_BYTES = 214_392_480
let bridge: any = null
let ready = false
let runtimeLabel = 'llama-web-bridge v0.1.44'

const send = (seq: number, value: object): void => postMessage({ seq, ...value })
const normalizedError = (e: unknown): string => (e instanceof Error ? e.message : String(e))
let queue = Promise.resolve()

function mirroredUrl(source: string, mirror: string): string {
  if (!mirror) return source
  const root = new URL(mirror)
  if (root.protocol !== 'https:') throw new Error('Model mirror must use HTTPS')
  const original = new URL(source)
  return new URL(original.pathname.replace(/^\/+/, ''), root.href.endsWith('/') ? root : `${root.href}/`).href
}

async function cachedProjector(url: string, seq: number, total: number): Promise<string> {
  const key = new Request(url, { method: 'GET' })
  const cache = typeof caches !== 'undefined' ? await caches.open(PROJECTOR_CACHE_NAME) : null
  let response = await cache?.match(key)
  if (!response) {
    response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`Projector download failed: ${response.status} ${response.statusText}`)
    const reader = response.body?.getReader()
    if (!reader) {
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength !== PROJECTOR_BYTES) throw new Error('Incomplete Qwen audio projector download')
      send(seq, {
        progress: { loaded: MODEL_BYTES + bytes.byteLength, total, file: 'Audio projector', phase: 'downloading' }
      })
      response = new Response(bytes)
    } else {
      const parts: Uint8Array[] = []
      let loaded = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        parts.push(value)
        loaded += value.byteLength
        send(seq, {
          progress: {
            loaded: MODEL_BYTES + loaded,
            total,
            file: 'Audio projector',
            phase: 'downloading'
          }
        })
      }
      const bytes = new Uint8Array(loaded)
      let offset = 0
      for (const part of parts) {
        bytes.set(part, offset)
        offset += part.byteLength
      }
      if (loaded !== PROJECTOR_BYTES) throw new Error('Incomplete Qwen audio projector download')
      response = new Response(bytes)
    }
    if (cache) await cache.put(key, response.clone())
  } else {
    send(seq, { progress: { loaded: total, total, file: 'Cached audio projector', phase: 'downloading' } })
  }
  return URL.createObjectURL(await response.blob())
}

function pcmToWav(pcm: Float32Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.length * 2),
    v = new DataView(out.buffer)
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, 16000, true)
  v.setUint32(28, 32000, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const x = Math.max(-1, Math.min(1, pcm[i] ?? 0))
    v.setInt16(44 + 2 * i, x < 0 ? Math.round(x * 32768) : Math.round(x * 32767), true)
  }
  return out
}

async function handle(event: MessageEvent<any>): Promise<void> {
  const { action, seq } = event.data
  try {
    if (action === 'prepare') {
      const { assets, model, projector, mirror } = event.data
      // Runtime module is vendored into the app and served same-origin (CSP safe).
      const moduleUrl = new URL('llama_webgpu_bridge.js', assets).href
      const { LlamaWebGpuBridge } = await import(/* @vite-ignore */ moduleUrl)
      bridge = new LlamaWebGpuBridge({
        coreModuleUrl: new URL('llama_webgpu_core.js', assets).href,
        coreModuleUrlMem64: new URL('llama_webgpu_core_mem64.js', assets).href,
        wasmUrl: new URL('llama_webgpu_core.wasm', assets).href,
        wasmUrlMem64: new URL('llama_webgpu_core_mem64.wasm', assets).href,
        workerUrl: new URL('llama_webgpu_bridge_worker.js', assets).href,
        cacheName: CACHE_NAME,
        preferMemory64: true,
        disableWorker: true,
        threads: 1,
        threadPoolSize: 1,
        allowAutoRemoteFetchBackend: false
      })
      const total = MODEL_BYTES + PROJECTOR_BYTES
      const modelUrl = mirroredUrl(model, mirror)
      const projectorUrl = mirroredUrl(projector, mirror)
      await bridge.loadModelFromUrl(modelUrl, {
        nCtx: 4096,
        progressCallback: (p: any) =>
          send(seq, { progress: { loaded: p.loaded, total, file: 'Qwen3-ASR Q8_0 model', phase: 'downloading' } })
      })
      send(seq, { progress: { loaded: MODEL_BYTES, total, file: 'Loading audio projector', phase: 'loading' } })
      const blobUrl = await cachedProjector(projectorUrl, seq, total)
      try {
        await bridge.loadMultimodalProjector(blobUrl)
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
      if (!bridge.supportsAudio())
        throw new Error('Loaded projector does not report audio support; stopping rather than falling back')
      // Explicit direct mode runs bridge inference on this worker, not an internal worker.
      runtimeLabel = `Qwen3-ASR Q8_0 · ${bridge.isGpuActive() ? `WebGPU (${bridge.getBackendName()})` : `WASM CPU (${bridge.getBackendName()})`} · worker`
      ready = true
      send(seq, { progress: { loaded: total, total, phase: 'loading' } })
      send(seq, { result: true })
    } else if (action === 'transcribe') {
      if (!ready || !bridge) throw new Error('Qwen ASR bridge is not loaded')
      const pcm: Float32Array = event.data.pcm
      if (!(pcm instanceof Float32Array) || !pcm.length) throw new Error('Expected non-empty 16 kHz mono Float32 PCM')
      if (pcm.length > MAX_SECONDS * 16000) throw new Error('Internal ASR window exceeds 30-second validated limit')
      const audio = pcmToWav(pcm)
      const text = await bridge.createCompletion('Transcribe this audio accurately.', {
        parts: [{ type: 'audio', bytes: audio }],
        nPredict: Math.min(768, Math.max(128, Math.ceil((pcm.length / 16000) * 20))),
        temp: 0,
        topK: 1,
        penalty: 1,
        mediaMaxPredict: 768
      })
      send(seq, {
        result: {
          text: String(text)
            .replace(/^\s*language\s+\w+\s*<\|?asr_text\|?>\s*/i, '')
            .replace(/<\|[^|]+\|>/g, '')
            .trim(),
          runtime: runtimeLabel
        }
      })
    } else throw new Error(`Unknown Qwen ASR worker action: ${action}`)
  } catch (e) {
    send(seq, { error: normalizedError(e) })
  }
}

self.onmessage = (event: MessageEvent<any>) => {
  queue = queue.then(
    () => handle(event),
    () => handle(event)
  )
}

export {}
