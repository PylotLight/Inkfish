/**
 * In-app (WASM / WebGPU) speech engines that run in the renderer — no helper,
 * no installs. Models download on first use into the renderer's Cache Storage
 * / IndexedDB. These complement the native helper engines and show up beside
 * them in Settings › Voice Engine (ids prefixed `web-`).
 */
import type { SttEngine, SttResult } from '../../shared/types'

type Loaded = (pcm: Float32Array) => Promise<string>

interface WebEngine {
  id: string
  name: string
  subtitle: string
  family: string
  size: string
  languages: string
  /** Cache Storage buckets / IndexedDB databases the model lives in. */
  caches: string[]
  dbs?: string[]
  load: (gpu: boolean) => Promise<Loaded>
}

const hasGpu = (): boolean => typeof navigator !== 'undefined' && 'gpu' in navigator

const whisper =
  (model: string, dtype: (gpu: boolean) => unknown) =>
  async (gpu: boolean): Promise<Loaded> => {
    const { pipeline } = await import('@huggingface/transformers')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const asr: any = await pipeline('automatic-speech-recognition', model, {
      device: gpu ? 'webgpu' : 'wasm',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      dtype: dtype(gpu) as any
    })
    return async (pcm) => {
      const out = await asr(pcm, {
        chunk_length_s: 30,
        stride_length_s: 5,
        task: 'transcribe'
      })
      return (Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text) as string
    }
  }

export const WEB_ENGINES: WebEngine[] = [
  {
    id: 'web-parakeet-redux',
    name: 'Parakeet Redux · Web',
    subtitle: 'vocule — Redux on WebGPU + WASM in a worker',
    family: 'nvidia',
    size: '~178 MB',
    languages: '25 languages',
    caches: ['vocule-verified-weights-v1'],
    load: async () => {
      const { createSpeech } = await import('@karanganesan/vocule')
      const speech = createSpeech()
      await speech.prepare()
      return async (pcm) => (await speech.transcribe({ samples: pcm, sampleRate: 16_000 })).text
    }
  },
  {
    id: 'web-parakeet-v2',
    name: 'Parakeet v2 · Web',
    subtitle: 'parakeet.js — TDT 0.6B v2 on WebGPU (ONNX Runtime Web)',
    family: 'nvidia',
    size: '~1.2 GB',
    languages: 'English',
    caches: [],
    dbs: ['parakeet-cache-db'],
    load: async (gpu) => {
      const { fromHub } = await import('parakeet.js')
      const model = await fromHub('parakeet-tdt-0.6b-v2', {
        backend: gpu ? 'webgpu' : 'wasm',
        encoderQuant: gpu ? 'fp16' : 'int8',
        decoderQuant: 'int8'
      })
      return async (pcm) => (await model.transcribeLongAudio(pcm, 16_000)).text
    }
  },
  {
    id: 'web-moonshine',
    name: 'Moonshine Base · Web',
    subtitle: 'Moonshine — tiny English model, also powers live captions',
    family: 'moonshine',
    size: '~60 MB',
    languages: 'English',
    caches: ['moonshine-models-v1'],
    load: async () => {
      const { Transcriber, ModelArch } = await import('@moonshine-ai/moonshine-wasm')
      const t = await Transcriber.load({
        language: 'en',
        modelArch: ModelArch.Base,
        moduleOptions: await moonshineModule()
      })
      return async (pcm) =>
        t
          .transcribe(pcm, { sampleRate: 16_000 })
          .lines.map((l) => l.text.trim())
          .filter(Boolean)
          .join(' ')
    }
  },
  {
    id: 'web-whisper-turbo',
    name: 'Whisper Large v3 Turbo · Web',
    subtitle: 'Transformers.js — OpenAI Whisper on WebGPU',
    family: 'openai',
    size: '~1 GB',
    languages: '99 languages',
    caches: ['transformers-cache'],
    load: whisper('onnx-community/whisper-large-v3-turbo', (gpu) =>
      gpu ? { encoder_model: 'fp16', decoder_model_merged: 'q4' } : 'q8'
    )
  },
  {
    id: 'web-whisper-base',
    name: 'Whisper Base · Web',
    subtitle: 'Transformers.js — small multilingual Whisper',
    family: 'openai',
    size: '~80 MB',
    languages: '99 languages',
    caches: ['transformers-cache'],
    load: whisper('onnx-community/whisper-base', () => 'q8')
  }
]

/** Moonshine's emscripten module lives beside a .wasm Vite renames; pin it. */
export async function moonshineModule(): Promise<{
  locateFile: (p: string, dir: string) => string
}> {
  const wasmUrl = (await import('@moonshine-ai/moonshine-wasm/moonshine.wasm?url')).default
  return { locateFile: (p, dir) => (p.endsWith('.wasm') ? wasmUrl : dir + p) }
}

export const isWebEngine = (id: string | undefined): boolean => !!id && id.startsWith('web-')

const READY_KEY = 'inkfish.webstt.ready'
const readySet = (): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(READY_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}
const saveReady = (s: Set<string>): void => localStorage.setItem(READY_KEY, JSON.stringify([...s]))

export const isWebReady = (id: string): boolean => readySet().has(id)

export function webEngines(): SttEngine[] {
  const ready = readySet()
  const ok = typeof WebAssembly !== 'undefined'
  return WEB_ENGINES.map((e) => {
    const r = ok && ready.has(e.id)
    return {
      id: e.id,
      name: e.name,
      available: ok,
      ready: r,
      detail: !ok ? 'WebAssembly unavailable' : r ? 'Downloaded' : 'Download to use',
      subtitle: e.subtitle,
      family: e.family,
      size: e.size,
      languages: e.languages,
      downloadable: ok && !r
    }
  })
}

const loaded = new Map<string, Promise<Loaded>>()

function get(id: string): Promise<Loaded> {
  const e = WEB_ENGINES.find((x) => x.id === id)
  if (!e) return Promise.reject(new Error(`Unknown engine ${id}`))
  let p = loaded.get(id)
  if (!p) {
    p = e.load(hasGpu())
    loaded.set(id, p)
    p.catch(() => loaded.delete(id))
  }
  return p
}

export async function prepareWeb(id: string): Promise<void> {
  await get(id)
  const s = readySet()
  s.add(id)
  saveReady(s)
}

export async function removeWeb(id: string): Promise<void> {
  const e = WEB_ENGINES.find((x) => x.id === id)
  if (!e) return
  loaded.delete(id)
  for (const c of e.caches) await caches.delete(c).catch(() => false)
  for (const db of e.dbs ?? []) indexedDB.deleteDatabase(db)
  // Engines sharing a cache bucket lose their weights too.
  const s = readySet()
  for (const other of WEB_ENGINES) {
    if (other.id === id || other.caches.some((c) => e.caches.includes(c))) s.delete(other.id)
  }
  saveReady(s)
}

/** Decode any audio blob to 16 kHz mono Float32 PCM. */
export async function toPcm16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer()
  const ctx = new AudioContext()
  const decoded = await ctx.decodeAudioData(bytes).finally(() => void ctx.close())
  const frames = Math.max(1, Math.ceil(decoded.duration * 16_000))
  const off = new OfflineAudioContext(1, frames, 16_000)
  const src = off.createBufferSource()
  src.buffer = decoded
  src.connect(off.destination)
  src.start()
  return (await off.startRendering()).getChannelData(0)
}

export async function transcribeWeb(id: string, audio: Blob): Promise<SttResult> {
  const t0 = performance.now()
  const pcm = await toPcm16k(audio)
  const run = await get(id)
  const text = (await run(pcm)).replace(/\s+/g, ' ').trim()
  const s = readySet()
  if (!s.has(id)) {
    s.add(id)
    saveReady(s)
  }
  return {
    text,
    segments: text ? [{ start: 0, end: pcm.length / 16_000, text }] : [],
    provider: id,
    engine: WEB_ENGINES.find((e) => e.id === id)?.name ?? id,
    ms: Math.round(performance.now() - t0)
  }
}
