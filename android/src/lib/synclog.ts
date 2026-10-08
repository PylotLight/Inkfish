import * as FileSystem from 'expo-file-system/legacy';
import { appendCapped, type SyncLogEntry } from './sync';
import { syncRoots } from './vault';

export type { SyncLogEntry };

/**
 * Sync history (Settings › Sync › Recent) — one entry per session plus
 * failures, so there's something to look at when a sync goes wrong.
 * Oldest-first on disk, capped; best-effort, never throws into sync.
 */

const UTF8 = { encoding: FileSystem.EncodingType.UTF8 };

function logUri(): string {
  return `${syncRoots().app}.sync/sync-log.json`;
}

async function mkdirp(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

export async function appendSyncLog(e: SyncLogEntry): Promise<void> {
  try {
    const uri = logUri();
    await mkdirp(uri.slice(0, uri.lastIndexOf('/') + 1));
    let log: SyncLogEntry[] = [];
    try {
      const raw = JSON.parse(await FileSystem.readAsStringAsync(uri, UTF8)) as unknown;
      if (Array.isArray(raw)) log = raw as SyncLogEntry[];
    } catch {
      // fresh log
    }
    await FileSystem.writeAsStringAsync(uri, JSON.stringify(appendCapped(log, e)), UTF8);
  } catch {
    // never break sync for logging
  }
}

export async function readSyncLog(): Promise<SyncLogEntry[]> {
  try {
    const raw = JSON.parse(await FileSystem.readAsStringAsync(logUri(), UTF8)) as unknown;
    return Array.isArray(raw) ? (raw as SyncLogEntry[]) : [];
  } catch {
    return [];
  }
}
