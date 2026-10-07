/**
 * In-app (WASM / WebGPU) speech engines that run in the renderer — no helper,
 * no installs. Models download on first use into the renderer's Cache Storage
 * / IndexedDB. These complement the native helper engines and show up beside
 * them in Settings › Voice Engine (ids prefixed `web-`).
 */
import type { SttEngine, SttResult } from '../../shared/types'

interface Heard {
  text: string
  /** What actually ran, e.g. "WebGPU fp16 · apple metal-3". */
  runtime: string
}
type Loaded = (pcm: Float32Array) => Promise<Heard>

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
  load: (gpu: Gpu) => Promise<Loaded>
}

/** A real WebGPU adapter (not just the API existing), with its name for the runtime label. */
type Gpu = { ok: boolean; label: string }
let gpuProbe: Promise<Gpu> | null = null
export function probeGpu(): Promise<Gpu> {
  gpuProbe ??= (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter: any = await (navigator as any).gpu?.requestAdapter({ powerPreference: 'high-performance' })
      if (!adapter) return { ok: false, label: 'no WebGPU adapter' }
      const info = adapter.info ?? {}
      return { ok: true, label: [info.vendor, info.architecture].filter(Boolean).join(' ') || 'GPU' }
    } catch {
      return { ok: false, label: 'WebGPU unavailable' }
    }
  })()
  return gpuProbe
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
      const speech = await reduxSpeech()
      return async (pcm) => {
        const t = await speech.transcribe({ samples: pcm, sampleRate: 16_000 })
        const rt = t.metrics.realtimeFactor
        return {
          text: t.text,
          runtime: `WebGPU+WASM · ${t.model.id}${t.verified ? ' (verified)' : ''} · ${rt.toFixed(0)}× realtime`
        }
      }
    }
  },
  {
    id: 'web-parakeet-v2',
    name: 'Parakeet v2 · Web',
    subtitle: 'parakeet.js — TDT 0.6B v2 on WebGPU (ONNX Runtime Web)',
    family: 'nvidia',
    // WebGPU can't run the int8 encoder, so fp16 (1.24 GB) is the smallest GPU
    // build; CPU-only Macs get int8 (652 MB). FluidVoice's 442 MB is the native
    // Core ML build — that's our native "Parakeet v2" engine.
    size: '~1.2 GB GPU · 650 MB CPU',
    languages: 'English',
    caches: [],
    dbs: ['parakeet-cache-db'],
    load: async (gpu) => {
      const { fromHub } = await import('parakeet.js')
      const encoderQuant = gpu.ok ? 'fp16' : 'int8'
      const model = await fromHub('parakeet-tdt-0.6b-v2', {
        backend: gpu.ok ? 'webgpu-hybrid' : 'wasm',
        encoderQuant,
        decoderQuant: 'int8',
        cpuThreads: Math.max(1, (navigator.hardwareConcurrency || 4) - 1)
      })
      const runtime = gpu.ok
        ? `WebGPU encoder fp16 (${gpu.label}) + WASM decoder int8 · TDT 0.6B v2`
        : 'WASM int8 (CPU) · TDT 0.6B v2'
      return async (pcm) => ({ text: (await model.transcribeLongAudio(pcm, 16_000)).text, runtime })
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
      return async (pcm) => ({
        text: t
          .transcribe(pcm, { sampleRate: 16_000 })
          .lines.map((l) => l.text.trim())
          .filter(Boolean)
          .join(' '),
        runtime: 'WASM · Moonshine Base'
      })
    }
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
    p = probeGpu().then((g) => e.load(g))
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
  if (id === 'web-parakeet-redux') redux = null
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
  const heard = await run(pcm)
  const text = heard.text.replace(/\s+/g, ' ').trim()
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
    runtime: heard.runtime,
    ms: Math.round(performance.now() - t0)
  }
}

/**
 * One warm Redux instance shared by file transcription and live dictation, so
 * the worker and GPU pipelines are built once per window instead of per
 * recording. (Meeting capture makes its own second instance for "Them".)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let redux: Promise<any> | null = null
export function reduxSpeech(): Promise<import('@karanganesan/vocule').Speech> {
  redux ??= import('@karanganesan/vocule').then(async ({ createSpeech }) => {
    const speech = createSpeech()
    await speech.prepare()
    return speech
  })
  redux.catch(() => (redux = null))
  return redux
}

/** Load the chosen web engine in the background so the first transcription doesn't pay for it. */
export function warmWeb(id: string | undefined): void {
  if (id && isWebEngine(id) && readySet().has(id)) void get(id).catch(() => undefined)
}
