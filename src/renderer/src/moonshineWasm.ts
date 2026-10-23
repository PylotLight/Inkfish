/** Official @moonshine-ai/moonshine-wasm Small Streaming adapter. */
import type { SttWorkerHost, TranscriptEventListener } from '@moonshine-ai/moonshine-wasm'
import type { WebProgress } from './webStt'

interface Heard {
  text: string
  runtime: string
}
type Loaded = (pcm: Float32Array) => Promise<Heard>
let host: SttWorkerHost | undefined
let loading: Promise<SttWorkerHost> | undefined
let sequence = 0

// The Emscripten build requests these exact basenames via locateFile(). Keep
// the package's dist files together under this canonical, copied runtime tree;
// ?url imports would hash the assets and break locateFile('moonshine.wasm').
function moonshineWasmBaseUrl(): string {
  return new URL('moonshine-runtime/', document.baseURI).href
}

function requireThreadedWasmSupport(): void {
  // Electron can explicitly expose SAB in a trusted renderer without the web
  // crossOriginIsolated flag. Test the capability itself; worker errors still surface.
  if (typeof SharedArrayBuffer === 'undefined') {
    throw new Error(
      'Moonshine WASM threaded build requires SharedArrayBuffer. Enable it in the Electron renderer or serve the web app with COOP: same-origin and COEP: require-corp; the published package has no single-thread fallback.'
    )
  }
}

export const MOONSHINE_WASM_ENGINE = {
  id: 'web-moonshine-streaming-small-en',
  name: 'Moonshine Streaming Small · Web',
  subtitle: 'Official Moonshine Voice · Small Streaming English · CPU/WASM',
  family: 'moonshine',
  size: 'Model download size varies by upstream catalog',
  languages: 'English',
  caches: ['moonshine-models-v1'],
  load: async (_gpu: unknown, onProgress: (p: WebProgress) => void): Promise<Loaded> => {
    requireThreadedWasmSupport()
    const runtimeUrl = new URL('index.js', moonshineWasmBaseUrl()).href
    const { SttWorkerHost, ModelArch } = (await import(
      /* @vite-ignore */ runtimeUrl
    )) as typeof import('@moonshine-ai/moonshine-wasm')
    const h = await (loading ??= Promise.resolve().then(() => {
      const instance = new SttWorkerHost(moonshineWasmBaseUrl())
      instance.onProgress = (_id, loaded, total, file) => onProgress({ loaded, total, file, phase: 'downloading' })
      host = instance
      return instance
    })).catch((error) => {
      loading = undefined
      throw error
    })
    const transcriberId = `inkfish-moonshine-${++sequence}`
    onProgress({ loaded: 0, file: 'Moonshine Small Streaming · English', phase: 'loading' })
    try {
      await h.loadTranscriber({
        transcriberId,
        modelArch: ModelArch.SmallStreaming,
        source: { kind: 'catalog', language: 'en' }
      })
    } catch (error) {
      h.close()
      if (host === h) host = undefined
      loading = undefined
      throw error
    }
    onProgress({ loaded: 1, total: 1, file: 'Moonshine Small Streaming · English', phase: 'loading' })

    let disposed = false
    return async (pcm: Float32Array): Promise<Heard> => {
      if (disposed) throw new Error('Moonshine stream is closed')
      const streamId = `${transcriberId}-${++sequence}-stream`
      const lines = new Map<string, string>()
      let streamError: Error | undefined
      const listener: TranscriptEventListener = {
        onLineUpdated: ({ line }) => lines.set(line.id, line.text),
        onLineCompleted: ({ line }) => lines.set(line.id, line.text),
        onError: ({ error }) => {
          streamError = error
        }
      }
      await h.createStream(transcriberId, streamId, { updateInterval: 250 })
      h.setListener(streamId, listener)
      try {
        await h.start(streamId)
        // This callable is a full-utterance harness, but exercises genuine streaming:
        // PCM is enqueued as 100 ms frames, not sent through one-shot Transcriber.
        const frameSize = 1600
        for (let offset = 0; offset < pcm.length; offset += frameSize) {
          if (disposed) throw new Error('Moonshine stream is closed')
          h.addAudio(streamId, pcm.subarray(offset, Math.min(offset + frameSize, pcm.length)).slice(), 16_000)
        }
        await h.stop(streamId)
        if (streamError) throw streamError
        return {
          text: [...lines.values()].join(' ').trim(),
          runtime: 'Moonshine Voice Small Streaming · WASM CPU (worker; full-utterance chunked-stream harness)'
        }
      } finally {
        await h.closeStream(streamId).catch(() => undefined)
      }
    }
  }
}

/** Terminate the upstream worker (including its WASM/pthread workers). */
export function disposeMoonshineWasm(): void {
  host?.close()
  host = undefined
  loading = undefined
}
