import { secs, type SyncStage, type SyncStageTimings } from './sync'

const ORDER: ReadonlyArray<[keyof SyncStageTimings, string]> = [
  ['finding', 'Find'],
  ['comparing', 'Compare'],
  ['downloading', 'Download'],
  ['applying', 'Apply'],
  ['uploading', 'Upload']
]

/** Elapsed-time clock; performance.now is monotonic, unlike wall-clock time. */
export function monotonicNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** Accumulates elapsed time spent in each stage of one phone-driven sync run. */
export class SyncStageTimer {
  private active: keyof SyncStageTimings | null = null
  private since: number | null = null
  private readonly elapsed: SyncStageTimings = {}

  constructor(private readonly now: () => number = monotonicNow) {}

  enter(stage: SyncStage): void {
    if (stage === this.active) return
    const at = this.now()
    this.close(at)
    if (stage === 'done') return
    this.active = stage
    this.since = at
    this.elapsed[stage] ??= 0
  }

  /** Closes the active stage and returns a snapshot; safe to call more than once. */
  finish(): SyncStageTimings {
    this.close(this.now())
    return { ...this.elapsed }
  }

  private close(at: number): void {
    if (this.active === null || this.since === null) return
    this.elapsed[this.active] = (this.elapsed[this.active] ?? 0) + Math.max(0, Math.round(at - this.since))
    this.active = null
    this.since = null
  }
}

/** Compact, stable-order summary for Sync details (e.g. `Find 0.2s · Compare 1.1s`). */
export function stageTimingLine(timings: SyncStageTimings | undefined): string | null {
  if (!timings) return null
  const parts = ORDER.flatMap(([stage, label]) => {
    const ms = timings[stage]
    return typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? [`${label} ${secs(ms)}`] : []
  })
  return parts.length ? parts.join(' · ') : null
}
