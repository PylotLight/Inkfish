import { conflictPath, mergeDaily, mergeNote } from './note'

/**
 * Sync planning: compare the local and remote manifests against the last
 * agreed state (`base`) and decide what happens to every path. Pure — the
 * platform layer (Electron fs / expo-file-system) does the I/O.
 */

export interface Entry {
  hash: string
  size: number
  mtime: number
}
/** Vault-relative path (`work/x.md`, `assets/2026/10/a.m4a`, `inbox/<id>.md`, `daily/2026-10-08.md`). */
export type Manifest = Record<string, Entry>
/** path → hash both sides agreed on at the last successful sync with this peer. */
export type Base = Record<string, string>

export type MergeKind = 'note' | 'daily' | 'binary'

export type Op =
  | { op: 'pull'; path: string; hash: string }
  | { op: 'push'; path: string; hash: string }
  | { op: 'deleteLocal'; path: string }
  | { op: 'deleteRemote'; path: string }
  | { op: 'moveLocal'; from: string; to: string }
  | { op: 'moveRemote'; from: string; to: string }
  | { op: 'merge'; path: string; kind: MergeKind; local: string; remote: string; base?: string }

const IGNORE = [/^\.inkfish\//, /(^|\/)\.DS_Store$/, /(^|\/)\.trash\//, /(^|\/)\.obsidian\//, /~$/, /\.tmp$/]

export function ignored(path: string): boolean {
  return IGNORE.some((r) => r.test(path))
}

export function mergeKind(path: string): MergeKind {
  if (/^daily\/\d{4}-\d{2}-\d{2}\.md$/.test(path)) return 'daily'
  if (/\.(md|markdown|txt)$/i.test(path)) return 'note'
  return 'binary'
}

export function plan(local: Manifest, remote: Manifest, base: Base): Op[] {
  const paths = new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(base)])
  const ops: Op[] = []
  for (const path of [...paths].sort()) {
    if (ignored(path)) continue
    const l = local[path]?.hash, r = remote[path]?.hash, b = base[path]
    if (l === r) continue // in sync (or gone on both)
    if (l === b) ops.push(r === undefined ? { op: 'deleteLocal', path } : { op: 'pull', path, hash: r })
    else if (r === b) ops.push(l === undefined ? { op: 'deleteRemote', path } : { op: 'push', path, hash: l! })
    // Changed on both sides from here.
    else if (l === undefined) ops.push({ op: 'pull', path, hash: r! }) // deleted here, edited there: edit wins
    else if (r === undefined) ops.push({ op: 'push', path, hash: l }) // edited here, deleted there: edit wins
    else ops.push({ op: 'merge', path, kind: mergeKind(path), local: l, remote: r, base: b })
  }
  return detectMoves(ops, base)
}

/** delete X + add Y of X's exact content on the same side → a move (no transfer). */
function detectMoves(ops: Op[], base: Base): Op[] {
  const out = [...ops]
  const pair = (del: 'deleteLocal' | 'deleteRemote', add: 'pull' | 'push', move: 'moveLocal' | 'moveRemote'): void => {
    for (const d of out.filter((o): o is Extract<Op, { op: typeof del }> => o.op === del)) {
      const h = base[d.path]
      if (!h) continue
      const a = out.find(
        (o): o is Extract<Op, { op: typeof add }> => o.op === add && o.hash === h && !(o.path in base)
      )
      if (!a) continue
      out.splice(out.indexOf(d), 1)
      out.splice(out.indexOf(a), 1, { op: move, from: d.path, to: a.path })
    }
  }
  pair('deleteLocal', 'pull', 'moveLocal')
  pair('deleteRemote', 'push', 'moveRemote')
  return out
}

/** Hashes the local side must fetch (pulls/merges whose content it doesn't already hold anywhere). */
export function neededFromRemote(ops: Op[], local: Manifest): string[] {
  const have = new Set(Object.values(local).map((e) => e.hash))
  const need = new Set<string>()
  for (const o of ops) {
    if (o.op === 'pull' && !have.has(o.hash)) need.add(o.hash)
    if (o.op === 'merge' && !have.has(o.remote)) need.add(o.remote)
  }
  return [...need]
}

export interface Write {
  path: string
  /** Text to write on BOTH sides. */
  text?: string
  /** Or: copy this side's content to the conflict path on both sides. */
  from?: 'local' | 'remote'
}

/**
 * Resolve one `merge` op. Clean merges write one text to both sides; a real
 * conflict keeps local at the path and saves remote beside it as a conflict
 * copy, so nothing is ever lost.
 */
export function resolveMerge(
  op: Extract<Op, { op: 'merge' }>,
  text: { base?: string; local: string; remote: string },
  remoteDevice: string,
  at: Date = new Date()
): Write[] {
  if (op.kind === 'daily') return [{ path: op.path, text: mergeDaily(text.local, text.remote) }]
  if (op.kind === 'note') {
    const r = mergeNote(text.base ?? '', text.local, text.remote)
    if (r.clean) return [{ path: op.path, text: r.text }]
  }
  return [
    { path: op.path, from: 'local' },
    { path: conflictPath(op.path, remoteDevice, at), from: 'remote' }
  ]
}
