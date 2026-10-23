/**
 * The only engines Inkfish offers: Parakeet Redux (native Core ML on the Mac,
 * and the in-app vocule build), Apple Speech · macOS 26+ (SpeechAnalyzer), and
 * the dev-only `$INKFISH_STT_BIN` override.
 */
export const STT_ENGINE_IDS = ['parakeet-redux', 'web-parakeet-redux', 'apple-analyzer', 'override']

/** Auto-pick order among *ready* engines when the user hasn't chosen one. */
export const STT_AUTO_ORDER = ['parakeet-redux', 'apple-analyzer']

export function pickAutoEngine<T extends { id: string; ready: boolean }>(engines: T[]): T | undefined {
  if (engines[0]?.id === 'override') return engines[0]
  for (const id of STT_AUTO_ORDER) {
    const e = engines.find((x) => x.id === id && x.ready)
    if (e) return e
  }
  return undefined
}

/**
 * A saved engine choice from before the model list was trimmed (Whisper,
 * Moonshine, Parakeet v2/v3, Nemotron, legacy Apple Speech, …) moves to Parakeet Redux: native on
 * the Mac, the Web build everywhere else. '' (auto) and current ids stay.
 */
export function migrateEngineId(id: string, mac: boolean): string {
  if (!id || STT_ENGINE_IDS.includes(id)) return id
  return mac ? 'parakeet-redux' : 'web-parakeet-redux'
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
