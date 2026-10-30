import { decodePairUri } from './sync'

/** Return only complete Inkfish pairing URIs; ignore unrelated app links. */
export function pairingUriFromLink(url: string | null | undefined): string | null {
  const candidate = url?.trim()
  return candidate && decodePairUri(candidate) ? candidate : null
}
