/** Auto-pick order among *ready* engines when the user hasn't chosen one. */
export const STT_AUTO_ORDER = [
  'parakeet-v3',
  'parakeet-v2',
  'parakeet-ultra',
  'phonon-2',
  'parakeet-redux',
  'parakeet-flash',
  'nemotron-multilingual',
  'cohere-transcribe',
  'apple-analyzer',
  'apple-speech'
]

export function pickAutoEngine<T extends { id: string; ready: boolean }>(engines: T[]): T | undefined {
  if (engines[0]?.id === 'override') return engines[0]
  for (const id of STT_AUTO_ORDER) {
    const e = engines.find((x) => x.id === id && x.ready)
    if (e) return e
  }
  return undefined
}

/**
 * Pull the helper's JSON reply out of its stdout. Normally that's the whole
 * output, but library logs (Core ML, FluidAudio) can share the stream; then
 * take the last line that parses, or the outermost {...} / [...] block.
 * Returns undefined when there's no JSON at all (plain-text engines).
 */
export function parseHelperJson<T = unknown>(out: string): T | undefined {
  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T
    } catch {
      return undefined
    }
  }
  const whole = out.trim()
  if (!whole) return undefined
  const direct = tryParse(whole)
  if (direct !== undefined && typeof direct === 'object') return direct
  const lines = whole.split('\n').map((l) => l.trim())
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!
    if (!l.startsWith('{') && !l.startsWith('[')) continue
    const v = tryParse(l)
    if (v !== undefined && typeof v === 'object') return v
  }
  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ] as const) {
    const a = whole.indexOf(open)
    const b = whole.lastIndexOf(close)
    if (a >= 0 && b > a) {
      const v = tryParse(whole.slice(a, b + 1))
      if (v !== undefined) return v
    }
  }
  return undefined
}
