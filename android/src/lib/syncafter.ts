/**
 * What the app does after a sync run lands — pure, so it's tested under bun.
 *
 * The note list, drawer and open note are all fed by the store, so "refresh
 * the UI" means one store refresh. It runs after EVERY successful sync, not
 * just ones that report local changes: the case-heal inside the phone's
 * manifest walk can move files without the engine knowing, and a refresh
 * with nothing new is cheap (cached scan, arrays are retained when equal).
 *
 * The refresh changes `notes`, which normally nudges a sync a few seconds
 * later (local edit → push). A sync's own refresh must not do that, or every
 * pull schedules a pointless follow-up sync: `quietMs` is how long the
 * provider ignores note changes after it refreshes.
 */
import type { SyncReport } from './sync';

export interface AfterSync {
  refresh: boolean;
  /** Renames to replay on open views (`recordMoves`). */
  moves: Array<{ from: string; to: string }>;
  /** Extra detail for the sync log row, if any. */
  note: string | null;
  quietMs: number;
}

export const QUIET_AFTER_SYNC_MS = 2500;

export function afterSync(report: SyncReport): AfterSync {
  const parts: string[] = [];
  if (report.adopted) parts.push(`${report.adopted} renamed to match the Mac`);
  if (report.cleaned) parts.push(`${report.cleaned} duplicate cop${report.cleaned === 1 ? 'y' : 'ies'} trashed`);
  return { refresh: true, moves: report.movedLocal ?? [], note: parts.length ? parts.join(' · ') : null, quietMs: QUIET_AFTER_SYNC_MS };
}
