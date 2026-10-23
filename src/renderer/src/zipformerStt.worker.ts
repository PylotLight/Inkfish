/// <reference lib="webworker" />
const CACHE = 'inkfish-zipformer-wasm-909bffc-v1'
const BASE =
  'https://huggingface.co/wundr-ai/zipformer-small-librispeech-en-wasm/resolve/909bffc2f4de5447907a9fd25161dd1170324f1d/'
const FILES = [
  'sherpa-onnx-asr.js',
  'sherpa-onnx-wasm-main-asr-small.js',
  'sherpa-onnx-wasm-main-asr-small.wasm',
  'sherpa-onnx-wasm-main-asr-small.data'
]
const EXPECTED = 39_732_297
let recognizer: any = null
let moduleReady: Promise<void> | null = null
let disposed = false
let lastRuntime = 'WASM · sherpa-onnx Zipformer Small LibriSpeech (int8)'

async function cachedDownload(file: string): Promise<void> {
  const cache = await caches.open(CACHE)
  const url = BASE + file
  const cached = await cache.match(url)
  if (cached) return
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}) for ${file}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const priorBytes = await downloadedBytes(cache)
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.length
    postMessage({
      progress: { loaded: Math.min(EXPECTED, priorBytes + size), total: EXPECTED, file, phase: 'downloading' }
    })
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  await cache.put(url, new Response(bytes.buffer, { headers: response.headers }))
}
async function downloadedBytes(cache: Cache): Promise<number> {
  let total = 0
  for (const file of FILES) {
    const response = await cache.match(BASE + file)
    if (!response) continue
    const length = Number(response.headers.get('content-length'))
    total += Number.isFinite(length) && length > 0 ? length : (await response.clone().arrayBuffer()).byteLength
  }
  return total
}
async function ensureAssets(): Promise<void> {
  for (const file of FILES) await cachedDownload(file)
}
async function ensureModule(): Promise<void> {
  if (moduleReady) return moduleReady
  moduleReady = (async () => {
    await ensureAssets()
    postMessage({ progress: { loaded: EXPECTED, total: EXPECTED, phase: 'loading' } })
    // The bundled upstream JS API resolves the data and WASM through locateFile.
    // Cache URLs are same-origin to the app's worker and served by Cache Storage via fetch?
    // Instead blob URLs ensure the cache has a complete, offline-capable payload.
    const cache = await caches.open(CACHE)
    const blobs = new Map<string, string>()
    for (const file of FILES) {
      const response = await cache.match(BASE + file)
      if (!response) throw new Error(`Cached asset missing: ${file}`)
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.wasm')
          ? 'application/wasm'
          : 'application/octet-stream'
      blobs.set(file, URL.createObjectURL(new Blob([await response.arrayBuffer()], { type })))
    }
    const apiResponse = await cache.match(BASE + FILES[0])
    if (!apiResponse) throw new Error('Cached sherpa JS API is missing')
    // Upstream publishes a CommonJS wrapper; expose its top-level class for this classic worker.
    const apiBlob = URL.createObjectURL(
      new Blob([await apiResponse.text(), '\nglobalThis.SherpaOfflineRecognizer = OfflineRecognizer;'], {
        type: 'text/javascript'
      })
    )
    const glueBlob = blobs.get(FILES[1]!)!
    const wasmUrl = blobs.get(FILES[2]!)!
    const dataUrl = blobs.get(FILES[3]!)!
    let initialized!: () => void
    const initializedPromise = new Promise<void>((resolve) => {
      initialized = resolve
    })
    const moduleConfig: any = {
      locateFile: (path: string) => (path.endsWith('.wasm') ? wasmUrl : path.endsWith('.data') ? dataUrl : path),
      onRuntimeInitialized: () => initialized()
    }
    ;(self as any).Module = moduleConfig
    importScripts(apiBlob, glueBlob)
    await Promise.race([
      initializedPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out initializing sherpa-onnx WASM')), 120_000)
      )
    ])
    // OfflineRecognizer is the upstream API class (sherpa-onnx-asr.js); its
    // config expects modelConfig.transducer encoder/decoder/joiner/tokens fields.
    const Api = (self as any).SherpaOfflineRecognizer
    if (!Api) throw new Error('Upstream OfflineRecognizer API unavailable in worker')
    recognizer = new Api(
      {
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: '/transducer-encoder.onnx',
            decoder: '/transducer-decoder.onnx',
            joiner: '/transducer-joiner.onnx'
          },
          tokens: '/tokens.txt',
          numThreads: 1,
          provider: 'cpu'
        },
        decodingMethod: 'greedy_search',
        maxActivePaths: 4
      },
      moduleConfig
    )
  })().catch((error) => {
    moduleReady = null
    throw error
  })
  return moduleReady
}

self.onmessage = async (event: MessageEvent<any>) => {
  const { id, type } = event.data
  try {
    if (type === 'dispose') {
      disposed = true
      recognizer?.free()
      recognizer = null
      return
    }
    if (type === 'load') {
      await ensureModule()
      postMessage({ id, ok: true })
      return
    }
    if (type === 'transcribe') {
      await ensureModule()
      if (disposed || !recognizer) throw new Error('Zipformer has been disposed')
      const stream = recognizer.createStream()
      try {
        stream.acceptWaveform(16000, new Float32Array(event.data.pcm))
        recognizer.decode(stream)
        const result = recognizer.getResult(stream)
        postMessage({ id, ok: true, text: result.text ?? '', runtime: lastRuntime })
      } finally {
        stream.free()
      }
      return
    }
    throw new Error(`Unknown worker request: ${type}`)
  } catch (error) {
    postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}
