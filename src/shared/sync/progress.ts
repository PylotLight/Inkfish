import type { SyncProgress, SyncReport, SyncStage } from './engine'

/**
 * Display helpers for a running / finished sync, shared by the Mac popover,
 * the tray tooltip and the phone's header, drawer and Settings. Pure.
 */

/** One finished session, as the phone reports it to the Mac (`/v1/done`) and keeps in its own log. */
export interface PeerRun {
  at: number
  ms: number
  pulled: number
  pushed: number
  merged: number
  moved: number
  deleted: number
  conflicts: number
  error?: string
}

/** Live progress as the Mac last heard it (`at` = when it arrived). */
export interface LiveProgress extends SyncProgress {
  at: number
}

/** Runs kept per device. */
export const RUNS_CAP = 10

export const STAGE_LABEL: Record<SyncStage, string> = {
  finding: 'finding Mac',
  comparing: 'comparing',
  downloading: 'downloading',
  applying: 'applying',
  uploading: 'uploading',
  done: 'done'
}

/** 0–100 for a transfer stage (bytes when known, else files), null when there's nothing to count. */
export function percent(p: Pick<SyncProgress, 'done' | 'total' | 'bytesDone' | 'bytesTotal'>): number | null {
  if (p.bytesTotal > 0) return Math.max(0, Math.min(100, Math.floor((p.bytesDone / p.bytesTotal) * 100)))
  if (p.total > 0) return Math.max(0, Math.min(100, Math.floor((p.done / p.total) * 100)))
  return null
}

/** Rough time left in the current stage from its rate so far; null until there's enough to go on. */
export function etaMs(p: SyncProgress, now: number): number | null {
  const since = p.stageAt ?? p.startedAt
  const elapsed = now - since
  const pct = percent(p)
  if (pct === null || pct <= 0 || pct >= 100 || elapsed < 1500) return null
  return Math.round((elapsed * (100 - pct)) / pct)
}

export function mb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

export function secs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms / 100) / 10)}s`
  if (ms < 60_000) return `${Math.round(ms / 100) / 10}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`
}

/** "downloading 120 of 400 · 3.1 of 9.8 MB · ~12s left" */
export function progressLine(p: SyncProgress, now: number): string {
  const parts = [STAGE_LABEL[p.stage]]
  if ((p.stage === 'downloading' || p.stage === 'uploading') && p.total > 0) {
    parts[0] = `${parts[0]} ${p.done} of ${p.total}`
    if (p.bytesTotal > 256 * 1024) parts.push(`${mb(p.bytesDone)} of ${mb(p.bytesTotal)}`)
    const eta = etaMs(p, now)
    if (eta !== null) parts.push(`~${secs(eta)} left`)
  }
  return parts.join(' · ')
}

/** Header-sized: "42%", "3/10", or the stage. */
export function progressShort(p: SyncProgress): string {
  const pct = percent(p)
  if ((p.stage === 'downloading' || p.stage === 'uploading') && pct !== null) return `${pct}%`
  return STAGE_LABEL[p.stage]
}

export function runFromReport(r: SyncReport, at: number, ms: number): PeerRun {
  return { at, ms, pulled: r.pulled, pushed: r.pushed, merged: r.merged, moved: r.moved, deleted: r.deleted, conflicts: r.conflicts.length }
}

/** "↓12 ↑3 · 2 moved · 1 conflict · 4.2s" or "failed: …" */
export function runLine(r: PeerRun): string {
  if (r.error) return `failed: ${r.error}`
  const parts: string[] = []
  if (r.pulled) parts.push(`↓${r.pulled}`)
  if (r.pushed) parts.push(`↑${r.pushed}`)
  const head = parts.join(' ')
  const rest: string[] = []
  if (r.merged) rest.push(`${r.merged} merged`)
  if (r.moved) rest.push(`${r.moved} moved`)
  if (r.deleted) rest.push(`${r.deleted} deleted`)
  if (r.conflicts) rest.push(`${r.conflicts} conflict${r.conflicts === 1 ? '' : 's'}`)
  const body = [head, ...rest].filter(Boolean).join(' · ') || 'nothing to do'
  return `${body} · ${secs(r.ms)}`
}

/** Sanitize a run / progress that came over the wire (never trust shapes from the network). */
export function cleanRun(x: unknown, now: number): PeerRun | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  const n = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 ? Math.floor(o[k] as number) : 0)
  const at = n('at')
  return {
    at: at && Math.abs(at - now) < 24 * 3600_000 ? at : now,
    ms: n('ms'),
    pulled: n('pulled'),
    pushed: n('pushed'),
    merged: n('merged'),
    moved: n('moved'),
    deleted: n('deleted'),
    conflicts: n('conflicts'),
    ...(typeof o['error'] === 'string' && o['error'] ? { error: (o['error'] as string).slice(0, 200) } : {})
  }
}

const STAGES = new Set<SyncStage>(['finding', 'comparing', 'downloading', 'applying', 'uploading', 'done'])

export function cleanProgress(x: unknown, now: number): LiveProgress | null {
  if (!x || typeof x !== 'object') return null
  const o = x as Record<string, unknown>
  if (!STAGES.has(o['stage'] as SyncStage)) return null
  const n = (k: string): number => (typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) >= 0 ? (o[k] as number) : 0)
  // Times are re-based on our clock (the phone's may be skewed): keep only the durations.
  const sent = n('sentAt') || now
  const rebase = (t: number): number => (t ? now - Math.max(0, sent - t) : now)
  return {
    stage: o['stage'] as SyncStage,
    done: Math.floor(n('done')),
    total: Math.floor(n('total')),
    bytesDone: n('bytesDone'),
    bytesTotal: n('bytesTotal'),
    current: typeof o['current'] === 'string' ? (o['current'] as string).slice(0, 300) : undefined,
    startedAt: rebase(n('startedAt')),
    stageAt: rebase(n('stageAt')),
    at: now
  }
}

export function pushRun(runs: PeerRun[] | undefined, r: PeerRun): PeerRun[] {
  const next = [...(runs ?? []), r]
  return next.length > RUNS_CAP ? next.slice(next.length - RUNS_CAP) : next
}
