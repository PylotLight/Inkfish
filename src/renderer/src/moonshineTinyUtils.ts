export function padMoonshineTinyAudio(samples: Float32Array): Float32Array {
  const length = Math.ceil(samples.length / 80) * 80
  if (length === samples.length) return samples
  const out = new Float32Array(length)
  out.set(samples)
  return out
}
/** Split long utterances at the lowest-energy 100ms point near each 5s boundary. */
export function quietCutsMoonshineTiny(samples: Float32Array, rate: number, maxSeconds = 5): Float32Array[] {
  if (!samples.length) return []
  const max = Math.max(1, Math.floor(rate * maxSeconds)),
    radius = Math.floor(rate * 0.5),
    frame = Math.max(1, Math.floor(rate * 0.1)),
    out: Float32Array[] = []
  let start = 0
  while (samples.length - start > max) {
    const nominal = start + max,
      lo = Math.max(start + Math.floor(max * 0.75), nominal - radius),
      hi = nominal
    let cut = nominal,
      best = Infinity
    for (let p = lo; p <= hi; p += frame) {
      let energy = 0,
        end = Math.min(p + frame, samples.length)
      for (let i = p; i < end; i++) energy += samples[i]! * samples[i]!
      energy /= Math.max(1, end - p)
      if (energy < best) {
        best = energy
        cut = p
      }
    }
    if (cut <= start) cut = nominal
    out.push(samples.slice(start, cut))
    start = cut
  }
  if (start < samples.length) out.push(samples.slice(start))
  return out
}
/** Decode the model-card tokenizer.json WordLevel/BPE vocabulary without assuming a Transformers pipeline. */
export function decodeMoonshineTinyIds(raw: unknown, ids: number[]): string {
  const root = raw as {
    model?: { vocab?: Record<string, number> }
    added_tokens?: Array<{ id: number; content: string; special?: boolean }>
    decoder?: { type?: string; add_prefix_space?: boolean }
  }
  const vocab = root?.model?.vocab
  if (!vocab) throw new Error('Unsupported Moonshine tokenizer.json: missing model vocabulary')
  const byId = new Map<number, string>(Object.entries(vocab).map(([s, i]) => [i, s]))
  for (const t of root.added_tokens ?? []) byId.set(t.id, t.content)
  const special = new Set((root.added_tokens ?? []).filter((t) => t.special).map((t) => t.id))
  // This repository's tokenizer uses Replace(▁ -> space), ByteFallback, Fuse, Strip.
  // Preserve fallback bytes across adjacent tokens, then UTF-8 decode the fused stream.
  let bytes: number[] = []
  const flush = (text: string): void => {
    for (const c of text) bytes.push(...new TextEncoder().encode(c))
  }
  for (const id of ids) {
    if (special.has(id)) continue
    const t = byId.get(id)
    if (t === undefined) continue
    const fallback = [...t.matchAll(/<0x([0-9A-Fa-f]{2})>/g)]
    if (fallback.length) {
      let cursor = 0
      for (const m of fallback) {
        flush(t.slice(cursor, m.index))
        bytes.push(parseInt(m[1]!, 16))
        cursor = (m.index ?? 0) + m[0].length
      }
      flush(t.slice(cursor))
    } else flush(t.replace(/▁/g, ' '))
  }
  let text = new TextDecoder().decode(Uint8Array.from(bytes))
  return text.replace(/^ /, '')
}
