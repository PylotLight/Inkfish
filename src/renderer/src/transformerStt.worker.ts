import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import {
  DownloadTotals,
  TRANSFORMER_ENGINES,
  padAudio,
  speechWindows,
  transformerCache,
  type TransformerEngine,
  type TransformerReply,
  type TransformerRequest
} from './transformerSttModels'

// CPU q8 is intentional: WebGPU cannot execute every quantized graph. Running
// in a dedicated worker keeps decoding off the UI thread. One WASM thread also
// avoids the nested pthread/CSP startup hang of the previous Moonshine runtime.
env.allowLocalModels = false
const wasm = env.backends.onnx.wasm!
wasm.numThreads = 1
wasm.proxy = false
wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmFactoryUrl }
// Assets ship in the app; only model files are downloaded and cached.
env.useWasmCache = false

let engine: TransformerEngine | undefined
let transcriber: AutomaticSpeechRecognitionPipeline | undefined
const reply = (message: TransformerReply): void => self.postMessage(message)

async function handle(message: TransformerRequest): Promise<void> {
  const { seq } = message
  try {
    if (message.action === 'prepare') {
      engine = TRANSFORMER_ENGINES.find((e) => e.id === message.id)
      if (!engine) throw new Error(`Unknown STT model ${message.id}`)
      if (message.mirror) {
        const url = new URL(message.mirror)
        if (url.protocol !== 'https:') throw new Error('Model mirror must use HTTPS')
        env.remoteHost = `${url.href.replace(/\/+$/, '')}/`
      }
      env.cacheKey = transformerCache(engine.id)
      const totals = new DownloadTotals()
      const weightsDone = new Set<string>()
      reply({ seq, progress: { loaded: 0, phase: 'downloading' } })
      // The explicit WASM device prevents accidental selection of a Node/native
      // backend. Vite resolves the package's browser export for this worker.
      transcriber = await pipeline('automatic-speech-recognition', engine.model, {
        device: 'wasm',
        dtype: 'q8',
        progress_callback: (event) => {
          const p = totals.update(event)
          if (p) reply({ seq, progress: p })
          if (event.status === 'done' && event.file?.endsWith('.onnx')) {
            weightsDone.add(event.file)
            if (weightsDone.size >= 2) reply({ seq, progress: { loaded: 1, phase: 'loading' } })
          }
        }
      })
      reply({ seq, result: { text: '', runtime: runtime() } })
      return
    }
    if (!engine || !transcriber) throw new Error('STT model is not prepared')
    if (!message.pcm.length) {
      reply({ seq, result: { text: '', runtime: runtime() } })
      return
    }
    const parts: string[] = []
    // Independent quiet-cut windows are deliberate for both model families.
    // Whisper Base q8 dropped whole sections of our 79 s clip when routed
    // through the pipeline's overlap/token-timestamp stitching path.
    const maxS = engine.id === 'web-distil-whisper-small-en' ? 15 : 20
    for (const window of speechWindows(message.pcm, 16_000, maxS)) {
      const output = await transcriber(padAudio(window, engine.frameSize), {
        max_new_tokens: 256
      })
      const text = (Array.isArray(output) ? output[0]?.text : output.text)?.trim()
      if (text) parts.push(text)
    }
    reply({ seq, result: { text: parts.join(' '), runtime: runtime() } })
  } catch (error) {
    reply({ seq, error: error instanceof Error ? error.message : String(error) })
  }
}

function runtime(): string {
  return `WASM q8 (CPU, 1 thread) · ${engine?.name.replace(' · Web', '') ?? 'Transformers.js'}`
}

// Serialize requests even if recording/benchmark actions overlap.
let queue = Promise.resolve()
self.onmessage = (event: MessageEvent<TransformerRequest>): void => {
  queue = queue.then(() => handle(event.data))
}
