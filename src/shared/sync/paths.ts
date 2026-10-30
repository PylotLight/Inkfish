import { ignored, type Base, type Manifest } from './plan'

/**
 * Path identity across file systems.
 *
 * The Mac vault normally lives on APFS, which is case-insensitive and
 * Unicode-normalization-insensitive (but preserving): `work/x.md` written
 * while `Work/` exists lands in `Work/x.md`, and its manifest keeps saying
 * `Work/x.md`. Android is case-sensitive. Two spellings of one folder must
 * never be treated as two files, or the phone pulls `Work/x.md`, heals it
 * into `work/x.md`, pushes that, the Mac stores it as `Work/x.md` again, and
 * the pair loops forever (v0.2.13 / android-v0.2.6).
 *
 * Rule: the Mac's spelling wins. The phone renames its copy to match, and
 * never asks the Mac to rename (a case-only rename on APFS is a no-op for
 * folders anyway).
 */

export function foldPath(p: string): string {
  return p.normalize('NFC').toLowerCase()
}

function byFold(m: Manifest | Base): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const p of Object.keys(m)) {
    const k = foldPath(p)
    const arr = out.get(k)
    if (arr) arr.push(p)
    else out.set(k, [p])
  }
  return out
}

/**
 * Local files whose path differs from a remote file's only by case /
 * normalization: rename them locally to the remote spelling. Only
 * unambiguous one-to-one pairs (one local spelling, one remote spelling,
 * neither present exactly on the other side).
 */
export function caseAdoptions(local: Manifest, remote: Manifest): Array<{ from: string; to: string }> {
  const r = byFold(remote)
  const l = byFold(local)
  const out: Array<{ from: string; to: string }> = []
  for (const p of Object.keys(local)) {
    if (p in remote || ignored(p)) continue
    const k = foldPath(p)
    const rs = r.get(k)
    if (rs?.length !== 1 || l.get(k)?.length !== 1) continue
    const to = rs[0]!
    if (to in local || ignored(to)) continue
    out.push({ from: p, to })
  }
  return out
}

/** Move manifest entries per `moves` (in place) and return it. */
export function renameEntries<T extends Manifest | Base>(m: T, moves: Array<{ from: string; to: string }>): T {
  const rec = m as Record<string, unknown>
  for (const { from, to } of moves) {
    if (!(from in rec)) continue
    rec[to] = rec[from]
    delete rec[from]
  }
  return m
}

/** Base entries recorded under another spelling of a remote path → the remote spelling. */
export function rebaseCase(base: Base, remote: Manifest): Base {
  const r = byFold(remote)
  const b = byFold(base)
  const out: Base = { ...base }
  for (const p of Object.keys(base)) {
    if (p in remote) continue
    const k = foldPath(p)
    const rs = r.get(k)
    if (rs?.length !== 1 || b.get(k)?.length !== 1) continue
    const to = rs[0]!
    if (to in base) continue
    out[to] = base[p]!
    delete out[p]
  }
  return out
}

// --- conflict copies + heal bumps ----------------------------------------------

const CONFLICT_RE = /^(.*) \(conflict · [^/]* · \d{4}-\d{2}-\d{2} \d{4}(?: #\d+)?\)(\.[^./]+)?$/
const BUMP_RE = /^(.*) ([2-9]|[1-9]\d)(\.md)$/

/** `a/b (conflict · Mac · 2026-10-19 1802).md` → `a/b.md`; null if not a conflict copy. */
export function conflictOriginal(p: string): string | null {
  const m = CONFLICT_RE.exec(p)
  return m ? `${m[1]}${m[2] ?? ''}` : null
}

/** `a/b 2.md` (a case-heal / collision bump) → `a/b.md`; null otherwise. */
export function bumpOriginal(p: string): string | null {
  const m = BUMP_RE.exec(p)
  return m ? `${m[1]}${m[3]}` : null
}

/**
 * Copies that add nothing: conflict copies byte-identical to their original
 * or to an older copy of the same note, and (with `bumps`) `name 2.md`
 * heal bumps identical to `name.md` next to them. Safe to trash — the same
 * bytes stay at the path that's kept.
 */
export function redundantCopies(m: Manifest, opts: { bumps?: boolean } = {}): string[] {
  const out: string[] = []
  const seen = new Map<string, Set<string>>() // original → hashes kept among its copies
  for (const p of Object.keys(m).sort()) {
    const orig = conflictOriginal(p) ?? (opts.bumps ? bumpOriginal(p) : null)
    if (!orig) continue
    const h = m[p]!.hash
    if (m[orig]?.hash === h) {
      out.push(p)
      continue
    }
    const kept = seen.get(orig) ?? new Set<string>()
    seen.set(orig, kept)
    if (kept.has(h)) out.push(p)
    else kept.add(h)
  }
  return out
}

/** Does a conflict copy of `path` already hold `hash` (on any of the manifests)? */
export function copyExists(path: string, hash: string, ...ms: Manifest[]): boolean {
  for (const m of ms)
    for (const [p, e] of Object.entries(m)) if (e.hash === hash && conflictOriginal(p) === path) return true
  return false
}
