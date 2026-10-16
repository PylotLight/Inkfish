import { isAbsolute, join, normalize, relative } from 'node:path'

/** Absolute path of vault-relative `rel` under `root`, or null if it escapes the root. */
export function vaultAbsPath(root: string, rel: string): string | null {
  if (!rel || isAbsolute(rel)) return null
  const abs = normalize(join(root, rel))
  const r = relative(root, abs)
  if (!r || r.startsWith('..') || isAbsolute(r)) return null
  return abs
}
