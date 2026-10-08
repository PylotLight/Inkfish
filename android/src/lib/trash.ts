import * as FileSystem from 'expo-file-system/legacy';
import { TRASH, uriFor } from './syncfs';

/**
 * Phone trash: files sync removed live at `trash/<stamp>/<rel>` (rel in the
 * sync namespace: vault-relative, or `inbox/…`, `daily/…`). Kept 7 days.
 */
export interface TrashItem {
  /** `<stamp>/<rel>` — unique, and where it sits under TRASH. */
  id: string;
  rel: string;
  name: string;
  deletedAt: number;
}

const KEEP_MS = 7 * 86400_000;

function stampTime(stamp: string): number {
  // 2026-10-08T01-02-03-456Z → 2026-10-08T01:02:03.456Z
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(stamp);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : 0;
}

async function ls(uri: string): Promise<string[]> {
  try {
    return await FileSystem.readDirectoryAsync(uri);
  } catch {
    return [];
  }
}

export async function listTrash(): Promise<TrashItem[]> {
  const out: TrashItem[] = [];
  for (const stamp of await ls(TRASH)) {
    const deletedAt = stampTime(stamp);
    const walk = async (dir: string, prefix: string): Promise<void> => {
      for (const n of await ls(dir)) {
        const rel = prefix ? `${prefix}/${n}` : n;
        const info = await FileSystem.getInfoAsync(`${dir}${n}`);
        if (info.isDirectory) await walk(`${dir}${n}/`, rel);
        else out.push({ id: `${stamp}/${rel}`, rel, name: n, deletedAt });
      }
    };
    await walk(`${TRASH}${stamp}/`, '');
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt || a.rel.localeCompare(b.rel));
}

async function freeUri(uri: string): Promise<string> {
  if (!(await FileSystem.getInfoAsync(uri)).exists) return uri;
  const slash = uri.lastIndexOf('/');
  const dot = uri.lastIndexOf('.');
  const ext = dot > slash ? uri.slice(dot) : '';
  const stem = ext ? uri.slice(0, -ext.length) : uri;
  for (let i = 1; ; i++) {
    const next = `${stem} (restored${i > 1 ? ` ${i}` : ''})${ext}`;
    if (!(await FileSystem.getInfoAsync(next)).exists) return next;
  }
}

/** Remove stamp folders left empty after restores/deletes. */
async function tidy(): Promise<void> {
  const prune = async (dir: string): Promise<boolean> => {
    let empty = true;
    for (const n of await ls(dir)) {
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      if (info.isDirectory && (await prune(`${dir}${n}/`))) continue;
      empty = false;
    }
    if (empty) await FileSystem.deleteAsync(dir, { idempotent: true });
    return empty;
  };
  for (const stamp of await ls(TRASH)) await prune(`${TRASH}${stamp}/`);
}

/** Put items back where they were; a taken path gets "(restored)". */
export async function restoreTrash(items: TrashItem[]): Promise<number> {
  let n = 0;
  for (const it of items) {
    const src = `${TRASH}${it.id}`;
    if (!(await FileSystem.getInfoAsync(src)).exists) continue;
    const dest = await freeUri(uriFor(it.rel));
    const parent = dest.slice(0, dest.lastIndexOf('/') + 1);
    if (!(await FileSystem.getInfoAsync(parent)).exists)
      await FileSystem.makeDirectoryAsync(parent, { intermediates: true });
    await FileSystem.moveAsync({ from: src, to: dest });
    n++;
  }
  await tidy();
  return n;
}

export async function deleteTrash(items: TrashItem[]): Promise<void> {
  for (const it of items) await FileSystem.deleteAsync(`${TRASH}${it.id}`, { idempotent: true });
  await tidy();
}

/** Drop whole stamp folders older than 7 days. */
export async function purgeTrash(): Promise<void> {
  const cutoff = Date.now() - KEEP_MS;
  for (const stamp of await ls(TRASH)) {
    const t = stampTime(stamp);
    if (t && t < cutoff) await FileSystem.deleteAsync(`${TRASH}${stamp}/`, { idempotent: true });
  }
}
