import { utf8Decode, utf8Encode, fromBase64, toBase64 } from './bytes'
import { plan, resolveMerge, type Base, type Manifest, type Op } from './plan'
import { applyRenames, matchRenames, renameCandidates } from './renames'
import { caseAdoptions, copyExists, rebaseCase, redundantCopies, renameEntries } from './paths'
import { sha256 } from './hash'
import { mapLimit } from './walk'
import type { ApplyReq } from './protocol'

/**
 * One sync session, run by the phone against the Mac. Platform code supplies
 * the file system, the remote, and the per-peer state; this decides and
 * applies everything. Safe to re-run: an interrupted session just leaves a
 * stale base, and the next run re-plans from the real files.
 */

export interface SyncFs {
  /**
   * Manifest of every syncable file (vault + `inbox/` + `daily/`).
   * `fresh`: ignore any size/mtime hash cache and rehash everything (repair).
   */
  list(opts?: { fresh?: boolean }): Promise<Manifest>
  read(path: string): Promise<Uint8Array>
  /**
   * Atomic write (temp + rename), creating parent dirs. `hash` is the sha256
   * of `data` when the engine already knows it, so a hash cache can record
   * it instead of re-reading the file on the next walk.
   */
  write(path: string, data: Uint8Array, hash?: string): Promise<void>
  /** Remove (implementations may move to a local trash instead). */
  remove(path: string): Promise<void>
  move(from: string, to: string): Promise<void>
}

export interface Remote {
  manifest(): Promise<Manifest>
  get(paths: string[]): Promise<Record<string, Uint8Array>>
  apply(req: { moves: ApplyReq['moves']; writes: Array<{ path: string; data: Uint8Array }>; deletes: string[] }): Promise<Manifest>
}

export interface SyncState {
  loadBase(): Promise<Base>
  saveBase(base: Base): Promise<void>
  /** Cached text of a base version (for three-way merges of notes). */
  getText(hash: string): Promise<string | null>
  putText(hash: string, text: string): Promise<void>
  /** Drop cached texts not in `keep`. */
  pruneTexts(keep: Set<string>): Promise<void>
}

export interface SyncReport {
  pulled: number
  pushed: number
  merged: number
  conflicts: string[]
  deleted: number
  moved: number
  /** Paths changed on this device by the sync (for re-reading lists). */
  changedLocal: string[]
  /** Files this sync moved on this device (renames from the other side), so open views can follow. */
  movedLocal: Array<{ from: string; to: string }>
  /** Local files renamed to the Mac's spelling of the same path (case / Unicode only). */
  adopted?: number
  /** Redundant conflict copies (identical to what's kept) moved to trash. */
  cleaned?: number
  /** Pulls skipped because the file changed (or arrived damaged) since the manifest; next run retries. */
  skipped?: number
  /** Wall time of the run (ms). */
  ms?: number
}

/** Where a running sync is. `finding` is the platform's (discovery), the engine starts at `comparing`. */
export type SyncStage = 'finding' | 'comparing' | 'downloading' | 'applying' | 'uploading' | 'done'

export interface SyncProgress {
  stage: SyncStage
  /** Files done / total in this stage (downloading, uploading). */
  done: number
  total: number
  bytesDone: number
  bytesTotal: number
  /** File being transferred, if any. */
  current?: string
  /** When the run started (epoch ms). */
  startedAt: number
  /** When the current stage started (epoch ms). */
  stageAt?: number
}

/** Progress callbacks fire at most this often (plus once per stage change and at the end). */
export const PROGRESS_THROTTLE_MS = 250

class Progress {
  private p: SyncProgress
  private last = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly cb: ((p: SyncProgress) => void) | undefined,
    private readonly clock: () => number
  ) {
    const t = clock()
    this.p = { stage: 'comparing', done: 0, total: 0, bytesDone: 0, bytesTotal: 0, startedAt: t, stageAt: t }
    this.emit(true)
  }
  phase(stage: SyncStage): void {
    if (this.p.stage === stage) return
    this.p = { ...this.p, stage, done: 0, total: 0, bytesDone: 0, bytesTotal: 0, current: undefined, stageAt: this.clock() }
    this.emit(true)
  }
  total(files: number, bytes: number): void {
    this.p = { ...this.p, total: files, bytesTotal: bytes }
    this.emit(true)
  }
  step(current: string, bytes: number): void {
    this.p = { ...this.p, done: this.p.done + 1, bytesDone: this.p.bytesDone + bytes, current }
    this.emit(false)
  }
  startedAt(): number {
    return this.p.startedAt
  }
  finish(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.p = { ...this.p, stage: 'done', current: undefined }
    this.emit(true)
  }
  private emit(force: boolean): void {
    if (!this.cb) return
    const t = this.clock()
    if (force || t - this.last >= PROGRESS_THROTTLE_MS) {
      if (this.timer) clearTimeout(this.timer)
      this.timer = null
      this.last = t
      try {
        this.cb({ ...this.p })
      } catch {
        // a UI callback never breaks sync
      }
    } else if (!this.timer) {
      // Trailing update so the last step of a burst isn't lost.
      this.timer = setTimeout(() => this.emit(true), PROGRESS_THROTTLE_MS - (t - this.last))
    }
  }
}

/** A sync that would delete this many files on one side, and this share of what's synced, asks first. */
export const GUARD_MIN = 10
export const GUARD_SHARE = 0.2

export interface BigDelete {
  /** Files this sync would delete on this device. */
  local: string[]
  /** Files it would delete on the other device. */
  remote: string[]
  /** Files synced before this run (the share is measured against this). */
  total: number
}

/**
 * What to do with a big deletion: `apply` it, `keep` the files (deleted ones
 * are copied back from the side that still has them), or `hold` — stop this
 * run before changing anything, and ask again next time.
 */
export type GuardChoice = 'apply' | 'keep' | 'hold'

export class SyncHeld extends Error {
  constructor(readonly pending: BigDelete) {
    super(`waiting to confirm deleting ${pending.local.length + pending.remote.length} files`)
    this.name = 'SyncHeld'
  }
}

/** The deletions in a plan, if they're big enough to ask about. */
export function bigDeletion(ops: Op[], base: Base): BigDelete | null {
  const total = Object.keys(base).length
  const local = ops.flatMap((o) => (o.op === 'deleteLocal' ? [o.path] : []))
  const remote = ops.flatMap((o) => (o.op === 'deleteRemote' ? [o.path] : []))
  const big = (n: number): boolean => n >= GUARD_MIN && n >= total * GUARD_SHARE
  return big(local.length) || big(remote.length) ? { local, remote, total } : null
}

/** Keep each `get`/`apply` request under ~4 MB of content (sealed + base64 ≈ 5.4 MB on the wire). */
const BATCH_BYTES = 4 * 1024 * 1024
/** …and under this many files, so one batch of notes doesn't hold everything up. */
const BATCH_FILES = 200
/** `get` batches in flight at once. */
const GET_CONCURRENCY = 3
/** Write-only `apply` batches in flight at once (moves go first, deletes last, alone). */
const APPLY_CONCURRENCY = 2
/** Local writes in flight at once, per `get` batch. */
const WRITE_CONCURRENCY = 4
/** Local reads in flight at once. */
const READ_CONCURRENCY = 6

/** Notes first (small, what you're looking at), then everything else smallest-first. */
export function transferOrder(paths: string[], sizes: Manifest): string[] {
  const rank = (p: string): number => (isText(p) ? 0 : 1)
  return [...paths].sort((a, b) => rank(a) - rank(b) || (sizes[a]?.size ?? 0) - (sizes[b]?.size ?? 0) || (a < b ? -1 : 1))
}

export function batchPaths(paths: string[], sizes: Manifest): string[][] {
  const out: string[][] = []
  let cur: string[] = []
  let bytes = 0
  for (const p of paths) {
    const s = sizes[p]?.size ?? 0
    if (cur.length && (bytes + s > BATCH_BYTES || cur.length >= BATCH_FILES)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(p)
    bytes += s
  }
  if (cur.length) out.push(cur)
  return out
}

function batchWrites<T extends { data: Uint8Array }>(writes: T[]): T[][] {
  const out: T[][] = [[]]
  let bytes = 0
  for (const w of writes) {
    const cur = out[out.length - 1]!
    if (cur.length && (bytes + w.data.length > BATCH_BYTES || cur.length >= BATCH_FILES)) {
      out.push([])
      bytes = 0
    }
    out[out.length - 1]!.push(w)
    bytes += w.data.length
  }
  return out
}

function isText(path: string): boolean {
  return /\.(md|markdown|txt)$/i.test(path)
}

async function fetchAll(remote: Remote, paths: string[], sizes: Manifest): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {}
  let batch: string[] = []
  let bytes = 0
  const flush = async (): Promise<void> => {
    if (!batch.length) return
    Object.assign(out, await remote.get(batch))
    batch = []
    bytes = 0
  }
  for (const p of paths) {
    const s = sizes[p]?.size ?? 0
    if (batch.length && bytes + s > BATCH_BYTES) await flush()
    batch.push(p)
    bytes += s
  }
  await flush()
  return out
}

export async function runSync(opts: {
  fs: SyncFs
  remote: Remote
  state: SyncState
  /** Shown in conflict-copy names, e.g. "Mac". */
  remoteName: string
  now?: Date
  /**
   * Asked before a big deletion (see `bigDeletion`). Without it big
   * deletions are held: nothing changes and the run throws `SyncHeld`.
   */
  confirmDelete?: (d: BigDelete) => Promise<GuardChoice>
  /**
   * One-shot repair: rehash everything, ignore the saved base for files one
   * side lacks (so they're copied, never deleted), and trash `name 2.md`
   * bumps identical to `name.md`.
   */
  repair?: boolean
  /** Live progress (throttled to PROGRESS_THROTTLE_MS; never per file). */
  onProgress?: (p: SyncProgress) => void
  /** Clock (tests). */
  clock?: () => number
}): Promise<SyncReport> {
  const clock = opts.clock ?? Date.now
  const progress = new Progress(opts.onProgress, clock)
  try {
    const report = await runSyncInner(opts, progress)
    report.ms = clock() - progress.startedAt()
    return report
  } finally {
    progress.finish()
  }
}

async function runSyncInner(
  opts: Parameters<typeof runSync>[0],
  progress: Progress
): Promise<SyncReport> {
  const { fs, remote, state } = opts
  const report: SyncReport = { pulled: 0, pushed: 0, merged: 0, conflicts: [], deleted: 0, moved: 0, changedLocal: [], movedLocal: [], adopted: 0, cleaned: 0 }
  const [local, remoteMan, savedBase] = await Promise.all([fs.list(opts.repair ? { fresh: true } : undefined), remote.manifest(), state.loadBase()])
  // Same file, different spelling (APFS is case-insensitive, Android isn't): take the Mac's.
  await adoptCase(fs, local, remoteMan, report)
  let base = rebaseCase(savedBase, remoteMan)
  // Repair: forget what we think was synced for anything one side lacks, so
  // nothing is read as a deletion — missing files are copied, never deleted.
  if (opts.repair) base = Object.fromEntries(Object.entries(base).filter(([p]) => p in local && p in remoteMan))
  // Conflict copies identical to what's kept (left behind by the v0.2.13 loop) → trash, on both sides.
  for (const p of redundantCopies(local, { bumps: opts.repair })) {
    const h = local[p]!.hash
    try {
      await fs.remove(p)
    } catch {
      continue
    }
    delete local[p]
    // Make sure the plan reads it as a deletion (not a missing file to pull back).
    if (remoteMan[p]?.hash === h) base[p] = h
    report.cleaned = (report.cleaned ?? 0) + 1
    report.changedLocal.push(p)
  }
  let ops = plan(local, remoteMan, base)
  // Renames that also changed the note (Mac title → filename, edit + rename) arrive as
  // "X gone, Y new"; pair them back up into moves before anything is deleted.
  const prefetched: Record<string, Uint8Array> = {}
  ops = await pairRenames({ ops, local, remoteMan, base, fs, remote, state, prefetched })
  const big = bigDeletion(ops, base)
  if (big) {
    const choice = opts.confirmDelete ? await opts.confirmDelete(big) : 'hold'
    if (choice === 'hold') throw new SyncHeld(big)
    if (choice === 'keep') {
      // Undo the deletion: copy each file back from the side that still has it.
      ops = ops.map((o): Op => {
        if (o.op === 'deleteLocal') return { op: 'push', path: o.path, hash: local[o.path]!.hash }
        if (o.op === 'deleteRemote') return { op: 'pull', path: o.path, hash: remoteMan[o.path]!.hash }
        return o
      })
    }
  }

  progress.phase('downloading')
  // Pulls stream in: notes first (small, what you look at), then assets
  // smallest-first; a few size-bounded batches in flight; each file's hash
  // is checked before it's written, and it's written as soon as it lands.
  const localNow: Manifest = { ...local }
  const bytesOf = new Map<string, Uint8Array>() // note bytes kept for the base-text cache
  const pullSet = new Set(ops.flatMap((o) => (o.op === 'pull' ? [o.path] : [])))
  const mergeFrom = new Set(ops.flatMap((o) => (o.op === 'merge' ? [o.remoteFrom ?? o.path] : [])))
  const fetched: Record<string, Uint8Array> = { ...prefetched }
  const written = new Set<string>()
  const toFetch = transferOrder([...new Set([...pullSet, ...mergeFrom])].filter((p) => !(p in prefetched)), remoteMan)
  progress.total(toFetch.length, toFetch.reduce((n, p) => n + (remoteMan[p]?.size ?? 0), 0))
  await mapLimit(batchPaths(toFetch, remoteMan), GET_CONCURRENCY, async (batch) => {
    const got = await remote.get(batch)
    await mapLimit(batch, WRITE_CONCURRENCY, async (p) => {
      const data = got[p]
      const want = remoteMan[p]?.hash
      progress.step(p, remoteMan[p]?.size ?? 0)
      // Missing (deleted since the manifest) or different bytes (changed since, or damaged in
      // transit): skip it — nothing half-right is ever written; the next run re-plans.
      if (!data || !want || sha256(data) !== want) {
        report.skipped = (report.skipped ?? 0) + 1
        return
      }
      if (mergeFrom.has(p)) fetched[p] = data
      if (pullSet.has(p)) {
        await fs.write(p, data, want)
        written.add(p)
        localNow[p] = { hash: want, size: data.length, mtime: Date.now() }
        if (isText(p)) bytesOf.set(p, data)
        report.pulled++
        report.changedLocal.push(p)
      }
    })
  })

  const moves: ApplyReq['moves'] = []
  const writes: Array<{ path: string; data: Uint8Array }> = []
  const deletes: string[] = []
  const pushPaths: string[] = []

  progress.phase('applying')
  for (const o of ops as Op[]) {
    switch (o.op) {
      case 'pull': {
        if (written.has(o.path)) break
        const data = prefetched[o.path]
        if (!data || sha256(data) !== o.hash) break // vanished / changed remotely mid-sync; next run sorts it out
        await fs.write(o.path, data, o.hash)
        localNow[o.path] = { hash: o.hash, size: data.length, mtime: Date.now() }
        if (isText(o.path)) bytesOf.set(o.path, data)
        report.pulled++
        report.changedLocal.push(o.path)
        break
      }
      case 'push':
        pushPaths.push(o.path)
        break
      case 'deleteLocal':
        await fs.remove(o.path)
        delete localNow[o.path]
        report.deleted++
        report.changedLocal.push(o.path)
        break
      case 'deleteRemote':
        deletes.push(o.path)
        report.deleted++
        break
      case 'moveLocal':
        await fs.move(o.from, o.to)
        renameEntries(localNow, [{ from: o.from, to: o.to }])
        report.moved++
        report.changedLocal.push(o.from, o.to)
        report.movedLocal.push({ from: o.from, to: o.to })
        break
      case 'moveRemote':
        moves.push({ from: o.from, to: o.to })
        report.moved++
        break
      case 'merge': {
        const theirs = fetched[o.remoteFrom ?? o.path]
        if (!theirs) break
        const ours = await fs.read(o.path)
        const text =
          o.kind === 'binary' || !isText(o.path)
            ? { local: '', remote: '' }
            : {
                local: utf8Decode(ours),
                remote: utf8Decode(theirs),
                base: (o.base && (await state.getText(o.base))) ?? undefined
              }
        let result = resolveMerge(o, text, opts.remoteName, opts.now)
        // Never mint a conflict copy the vault already holds (same bytes): keep ours at the path.
        if (result.length > 1 && copyExists(o.path, o.remote, local, remoteMan)) result = [result[0]!]
        for (const w of result) {
          const data = w.text !== undefined ? utf8Encode(w.text) : w.from === 'local' ? ours : theirs
          if (w.path !== o.path || w.text !== undefined) {
            const h = sha256(data)
            await fs.write(w.path, data, h)
            localNow[w.path] = { hash: h, size: data.length, mtime: Date.now() }
            report.changedLocal.push(w.path)
          }
          if (isText(w.path)) bytesOf.set(w.path, data)
          writes.push({ path: w.path, data })
        }
        if (result.length > 1) report.conflicts.push(result[1]!.path)
        else report.merged++
        break
      }
    }
  }

  // Read what we push a few at a time (each read is a bridge round trip on the phone).
  const pushed = await mapLimit(pushPaths, READ_CONCURRENCY, async (p) => {
    try {
      return { path: p, data: await fs.read(p) }
    } catch {
      return null // gone since the manifest; next run re-plans
    }
  })
  for (const w of pushed) {
    if (!w) continue
    // Changed since we listed it? Send what's there now and record that hash.
    const h = sha256(w.data)
    if (localNow[w.path]?.hash !== h) localNow[w.path] = { hash: h, size: w.data.length, mtime: Date.now() }
    if (isText(w.path)) bytesOf.set(w.path, w.data)
    writes.push(w)
    report.pushed++
  }

  // Push in size-bounded batches: moves ride the first, deletes the last;
  // the ones in between go a couple at a time.
  let remoteAfter: Manifest = remoteMan
  if (moves.length || writes.length || deletes.length) {
    progress.phase('uploading')
    progress.total(writes.length, writes.reduce((n, w) => n + w.data.length, 0))
    const batches = batchWrites(writes)
    const send = async (b: typeof writes, extra: { moves?: ApplyReq['moves']; deletes?: string[] }): Promise<Manifest> => {
      const m = await remote.apply({ moves: extra.moves ?? [], writes: b, deletes: extra.deletes ?? [] })
      for (const w of b) progress.step(w.path, w.data.length)
      return m
    }
    if (batches.length === 1) remoteAfter = await send(batches[0]!, { moves, deletes })
    else {
      await send(batches[0]!, { moves })
      await mapLimit(batches.slice(1, -1), APPLY_CONCURRENCY, (b) => send(b, {}))
      remoteAfter = await send(batches[batches.length - 1]!, { deletes })
    }
  }

  // Pushed `work/x.md`, the Mac stored it as `Work/x.md`: follow its spelling now, not next run.
  await adoptCase(fs, localNow, remoteAfter, report)
  // New base = every path both sides now hold identically. (No second walk of
  // the vault: localNow already reflects every change this run made.)
  const next: Base = {}
  for (const [p, e] of Object.entries(localNow)) if (remoteAfter[p]?.hash === e.hash) next[p] = e.hash
  // Cache base texts for notes so the next concurrent edit can three-way merge.
  const keep = new Set<string>()
  const toCache: Array<[string, string]> = []
  for (const [p, h] of Object.entries(next)) {
    if (!isText(p)) continue
    keep.add(h)
    if (base[p] === h) continue
    toCache.push([p, h])
  }
  await mapLimit(toCache, READ_CONCURRENCY, async ([p, h]) => {
    try {
      const data = bytesOf.get(p) ?? (await fs.read(p))
      await state.putText(h, utf8Decode(data))
    } catch {
      // unreadable now; the merge will fall back to a conflict copy
    }
  })
  await state.saveBase(next)
  await state.pruneTexts(keep)
  return report
}

async function adoptCase(fs: SyncFs, local: Manifest, remote: Manifest, report: SyncReport): Promise<void> {
  const done: Array<{ from: string; to: string }> = []
  for (const mv of caseAdoptions(local, remote)) {
    try {
      await fs.move(mv.from, mv.to)
    } catch {
      continue // next run tries again
    }
    done.push(mv)
    report.movedLocal.push(mv)
    report.changedLocal.push(mv.from, mv.to)
  }
  renameEntries(local, done)
  report.adopted = (report.adopted ?? 0) + done.length
}

/** Notes larger than this are never compared for rename pairing. */
const RENAME_TEXT_MAX = 1024 * 1024

/** See `renames.ts`. Reads only the candidate notes; anything unreadable keeps the plain plan. */
async function pairRenames(c: {
  ops: Op[]
  local: Manifest
  remoteMan: Manifest
  base: Base
  fs: SyncFs
  remote: Remote
  state: SyncState
  prefetched: Record<string, Uint8Array>
}): Promise<Op[]> {
  const { gone, added } = renameCandidates(c.ops, c.local, c.remoteMan, c.base)
  if (!gone.length || !added.length) return c.ops
  const small = (m: Manifest, p: string): boolean => (m[p]?.size ?? 0) <= RENAME_TEXT_MAX
  const goneText = new Map<string, string>()
  const addedText = new Map<string, string>()
  const fromRemote: string[] = []
  try {
    for (const g of gone) {
      const h = c.base[g.path]
      const cached = h ? await c.state.getText(h) : null
      if (cached !== null) goneText.set(g.path, cached)
      // No cached base: compare against the copy that survived (close enough to score).
      else if (g.side === 'remote' && small(c.local, g.path)) goneText.set(g.path, utf8Decode(await c.fs.read(g.path)))
      else if (g.side === 'local' && small(c.remoteMan, g.path)) fromRemote.push(g.path)
    }
    for (const a of added) {
      if (a.side === 'local' && small(c.local, a.path)) addedText.set(a.path, utf8Decode(await c.fs.read(a.path)))
      else if (a.side === 'remote' && small(c.remoteMan, a.path)) fromRemote.push(a.path)
    }
    if (fromRemote.length) {
      const got = await fetchAll(c.remote, fromRemote, c.remoteMan)
      const isGone = new Set(gone.map((g) => g.path))
      for (const [p, d] of Object.entries(got)) {
        c.prefetched[p] = d
        ;(isGone.has(p) ? goneText : addedText).set(p, utf8Decode(d))
      }
    }
  } catch {
    // Unreadable right now: fall back to the plain plan (delete + add), as older builds did.
    return c.ops
  }
  const pairs = matchRenames(gone, added, (p, which) => (which === 'gone' ? goneText.get(p) : addedText.get(p)) ?? null)
  return applyRenames(c.ops, pairs, c.local, c.remoteMan, c.base)
}

// --- base64 transport helpers for Remote implementations --------------------

export function encodeFiles(files: Array<{ path: string; data: Uint8Array }>): Array<{ path: string; data: string }> {
  return files.map((f) => ({ path: f.path, data: toBase64(f.data) }))
}

export function decodeFiles(files: Record<string, string>): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {}
  for (const [p, d] of Object.entries(files)) out[p] = fromBase64(d)
  return out
}
