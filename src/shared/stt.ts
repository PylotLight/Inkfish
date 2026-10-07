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
