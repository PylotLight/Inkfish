import type { SyncPhase } from './syncing';
import { when } from './when';

/**
 * Header/drawer sync indicator: pure derivation from the sync loop's state
 * (src/lib/syncing). No timers of its own — it re-renders whenever the loop's
 * phase / lastSync changes (launch, foreground, edits, the 90 s open-app poll).
 */

export type IndicatorState = 'hidden' | 'connecting' | 'syncing' | 'synced' | 'idle' | 'offline' | 'held' | 'error' | 'outdated';
export type IndicatorTone = 'accent' | 'muted' | 'faint' | 'danger';

export interface IndicatorInput {
  phase: SyncPhase;
  macName: string | null;
  lastSync: number | null;
  error: string | null;
  /** Files waiting on a big-deletion choice (phase 'held'). */
  heldCount?: number;
  /** Phase 'outdated': which app needs updating (protocol handshake). */
  outdated?: 'mac' | 'phone' | null;
}

export interface SyncIndicator {
  state: IndicatorState;
  /** A few chars next to the glyph ("2m", "offline"). */
  short: string;
  /** Full sentence for the drawer row + accessibility label. */
  label: string;
  tone: IndicatorTone;
  spinning: boolean;
  /** What a tap does: run a sync, open the sync settings, or nothing (already running). */
  tap: 'sync' | 'open' | 'none';
}

export function syncIndicator(s: IndicatorInput, now = Date.now()): SyncIndicator {
  const mac = s.macName ?? 'your Mac';
  const last = s.lastSync ? ` · last synced ${agoText(s.lastSync, now)}` : '';
  switch (s.phase) {
    case 'unpaired':
      return { state: 'hidden', short: '', label: 'Not paired with a Mac', tone: 'faint', spinning: false, tap: 'open' };
    case 'finding':
      return { state: 'connecting', short: 'looking…', label: `Looking for ${mac}…`, tone: 'muted', spinning: true, tap: 'none' };
    case 'syncing':
      return { state: 'syncing', short: 'syncing', label: `Syncing with ${mac}…`, tone: 'accent', spinning: true, tap: 'none' };
    case 'offline':
      return { state: 'offline', short: 'offline', label: `${mac} isn't on this Wi-Fi${last}`, tone: 'faint', spinning: false, tap: 'sync' };
    case 'held': {
      const n = s.heldCount ?? 0;
      return {
        state: 'held',
        short: 'review',
        label: n ? `${n} deletion${n === 1 ? '' : 's'} waiting for you` : 'Sync paused — review deletions',
        tone: 'danger',
        spinning: false,
        tap: 'open'
      };
    }
    case 'outdated': {
      const app = s.outdated ?? 'phone';
      return {
        state: 'outdated',
        short: app === 'mac' ? 'update Mac' : 'update phone',
        label: app === 'mac' ? `Update Inkfish on ${mac} to keep syncing` : `Update Inkfish on this phone to keep syncing with ${mac}`,
        tone: 'danger',
        spinning: false,
        tap: 'open'
      };
    }
    case 'error':
      return { state: 'error', short: 'error', label: `Sync failed${s.error ? ` — ${s.error}` : ''}${last}`, tone: 'danger', spinning: false, tap: 'sync' };
    case 'idle':
    default:
      if (!s.lastSync) return { state: 'idle', short: '', label: `Paired with ${mac} · not synced yet`, tone: 'muted', spinning: false, tap: 'sync' };
      return {
        state: 'synced',
        short: when(s.lastSync, now),
        label: `Synced with ${mac} · ${agoText(s.lastSync, now)}`,
        tone: 'accent',
        spinning: false,
        tap: 'sync'
      };
  }
}

/** "just now" / "5m ago" / "Yesterday" — `when()` plus a suffix where it reads naturally. */
export function agoText(at: number, now: number): string {
  const w = when(at, now);
  if (w === 'now') return 'just now';
  return /^\d+[mh]$/.test(w) ? `${w} ago` : w;
}
