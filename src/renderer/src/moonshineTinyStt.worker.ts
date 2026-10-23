import * as ort from 'onnxruntime-web'
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url'
import wasmFactoryUrl from 'onnxruntime-web/ort-wasm-simd-threaded.mjs?url'
import { decodeMoonshineTinyIds, padMoonshineTinyAudio, quietCutsMoonshineTiny } from './moonshineTinyUtils'
import type { WebProgress } from './webStt'

const ROOT =
  'https://huggingface.co/felixem/moonshine-streaming-tiny-optimized/resolve/2f5c1d8368ced5192141d8ea318fb9a4a16073ca/onnx_int8/'
const FILES = [
  'encoder_model_int8.onnx',
  'decoder_model_int8.onnx',
  'decoder_with_past_model_int8.onnx',
  'tokenizer.json',
  'config.json'
]
type Msg = { seq: number; action: 'prepare' | 'transcribe'; mirror?: string; pcm?: Float32Array }
let encoder: ort.InferenceSession | undefined,
  decoder: ort.InferenceSession | undefined,
  past: ort.InferenceSession | undefined
let tokenizer: unknown
let work: Promise<void> = Promise.resolve()
const send = (m: object): void => self.postMessage(m)
function outputs(session: ort.InferenceSession, values: Record<string, ort.Tensor>): ort.Tensor[] {
  return session.outputNames.map((n) => values[n] as ort.Tensor)
}
async function loadFiles(mirror?: string): Promise<Map<string, ArrayBuffer>> {
  if (mirror) {
    const u = new URL(mirror)
    if (u.protocol !== 'https:') throw new Error('Model mirror must use HTTPS')
  }
  const cache = await caches.open('inkfish-moonshine-tiny-int8-v1')
  const result = new Map<string, ArrayBuffer>()
  let total = 0
  for (const f of FILES) {
    const url = mirror
      ? `${mirror.replace(/\/+$/, '')}/felixem/moonshine-streaming-tiny-optimized/resolve/2f5c1d8368ced5192141d8ea318fb9a4a16073ca/onnx_int8/${f}`
      : ROOT + f
    let response = await cache.match(url)
    let data: ArrayBuffer
    if (!response) {
      send({ seq: activeSeq, progress: { loaded: total, total: 79_800_000, file: f, phase: 'downloading' } })
      response = await fetch(url)
      if (!response.ok) throw new Error(`Model download failed (${response.status}): ${f}`)
      try {
        data = await response.arrayBuffer()
        await cache.put(url, new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }))
      } catch (error) {
        throw new Error(`Could not download/cache ${f}: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      data = await response.arrayBuffer()
    }
    result.set(f, data)
    total += data.byteLength
    send({
      seq: activeSeq,
      progress: { loaded: total, total: 79_800_000, file: f, phase: 'downloading' } satisfies WebProgress
    })
  }
  return result
}
let activeSeq = 0
async function setup(m: Msg): Promise<void> {
  activeSeq = m.seq
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmFactoryUrl }
  send({ seq: m.seq, progress: { loaded: 0, phase: 'downloading' } })
  const files = await loadFiles(m.mirror)
  const [enc, dec, dwp, tok] = await Promise.all([
    ort.InferenceSession.create(files.get(FILES[0]!)!, { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(files.get(FILES[1]!)!, { executionProviders: ['wasm'] }),
    ort.InferenceSession.create(files.get(FILES[2]!)!, { executionProviders: ['wasm'] }),
    Promise.resolve(JSON.parse(new TextDecoder().decode(files.get(FILES[3]!)!)))
  ])
  encoder = enc
  decoder = dec
  past = dwp
  tokenizer = tok
  send({ seq: m.seq, progress: { loaded: 1, total: 1, file: 'ONNX sessions ready', phase: 'loading' } })
  send({ seq: m.seq, result: { text: '', runtime: 'Experimental ONNX Runtime Web · WASM int8 CPU · 1 thread' } })
}
async function run(m: Msg): Promise<void> {
  if (!encoder || !decoder || !past || !tokenizer) throw new Error('Prepare Moonshine Tiny first')
  const pcm = m.pcm ?? new Float32Array()
  const cuts = quietCutsMoonshineTiny(pcm, 16000, 5)
  const texts: string[] = []
  for (const segment of cuts) {
    if (!segment.length) continue
    const audio = padMoonshineTinyAudio(segment)
    const mask = new BigInt64Array(audio.length)
    mask.fill(1n)
    const feeds: Record<string, ort.Tensor> = {
      input_values: new ort.Tensor('float32', audio, [1, audio.length]),
      attention_mask: new ort.Tensor('int64', mask, [1, mask.length])
    }
    const encodedMap = await encoder.run(feeds),
      encoded = outputs(encoder, encodedMap)
    const hidden =
      encoded[
        encoder.outputNames.findIndex((n) => n.includes('last_hidden_state')) >= 0
          ? encoder.outputNames.findIndex((n) => n.includes('last_hidden_state'))
          : 0
      ]!
    const encName = decoder.inputNames.find((n) => n === 'encoder_hidden_states')!
    const bos = new ort.Tensor('int64', new BigInt64Array([1n]), [1, 1])
    const firstMap = await decoder.run({ decoder_input_ids: bos, [encName]: hidden }),
      first = outputs(decoder, firstMap)
    let logits = first[0]!,
      token = argmax(logits),
      ids: number[] = []
    let kv = mapKv(decoder, first, past)
    for (let i = 0; i < 255; i++) {
      if (token === 2) break
      ids.push(token)
      const nextMap = await past.run({
          decoder_input_ids: new ort.Tensor('int64', new BigInt64Array([BigInt(token)]), [1, 1]),
          [encName]: hidden,
          ...kv
        }),
        next = outputs(past, nextMap)
      logits = next[0]!
      token = argmax(logits)
      kv = mapKv(past, next, past)
    }
    const text = decodeMoonshineTinyIds(tokenizer, ids).trim()
    if (text) texts.push(text)
  }
  send({
    seq: m.seq,
    result: {
      text: texts.join(' '),
      runtime: 'Experimental ONNX Runtime Web · WASM int8 CPU · 1 thread · 5 s quiet-cut full-utterance harness'
    }
  })
}
function argmax(t: ort.Tensor): number {
  const d = t.data as ArrayLike<number>
  let best = 0
  for (let i = 1; i < d.length; i++) if (d[i]! > d[best]!) best = i
  return best
}
function mapKv(
  source: ort.InferenceSession,
  values: ort.Tensor[],
  target: ort.InferenceSession
): Record<string, ort.Tensor> {
  const want = new Set(target.inputNames.filter((n) => n.startsWith('past_'))),
    out: Record<string, ort.Tensor> = {}
  source.outputNames.slice(1).forEach((name, i) => {
    const mapped = name.replace(/^present_/, 'past_')
    if (want.has(mapped)) out[mapped] = values[i + 1]!
  })
  for (const k of want) if (!out[k]) throw new Error(`KV output/input mismatch: ${k}`)
  return out
}
async function handle(m: Msg): Promise<void> {
  try {
    if (m.action === 'prepare') await setup(m)
    else await run(m)
  } catch (e) {
    send({ seq: m.seq, error: e instanceof Error ? e.message : String(e) })
  }
}
self.onmessage = (event: MessageEvent<Msg>) => {
  work = work.then(() => handle(event.data))
}
