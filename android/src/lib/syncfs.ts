import * as FileSystem from 'expo-file-system/legacy';
import { getRandomBytes } from 'expo-crypto';
import {
  fromBase64,
  ignored,
  safeRel,
  sha256,
  toBase64,
  toHex,
  type Base,
  type Entry,
  type MacPeer,
  type Manifest,
  type SyncFs,
  type SyncState
} from './sync';
import { syncRoots } from './vault';

/**
 * Android file system + state for the shared sync engine. Paths use the
 * Mac's namespace: vault-relative, plus `inbox/…` and `daily/…` for staging.
 * Deletes from sync go to `inkfish/trash/` (never hard-deleted).
 */

const R = syncRoots();
const SYNC_DIR = `${R.app}.sync/`;
const TRASH = `${R.app}trash/`;
const B64 = { encoding: FileSystem.EncodingType.Base64 };
const UTF8 = { encoding: FileSystem.EncodingType.UTF8 };

export const random = (n: number): Uint8Array => getRandomBytes(n);

function uriFor(rel: string): string {
  if (!safeRel(rel) || ignored(rel)) throw new Error(`refused path ${rel}`);
  if (rel.startsWith('inbox/')) return `${R.inbox}${rel.slice(6)}`;
  if (rel.startsWith('daily/')) return `${R.daily}${rel.slice(6)}`;
  return `${R.vault}${rel}`;
}

async function mkdirp(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

function parentOf(uri: string): string {
  return uri.slice(0, uri.lastIndexOf('/') + 1);
}

async function readJson<T>(uri: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await FileSystem.readAsStringAsync(uri, UTF8)) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(uri: string, v: unknown): Promise<void> {
  await mkdirp(parentOf(uri));
  const tmp = `${uri}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(v), UTF8);
  await FileSystem.moveAsync({ from: tmp, to: uri });
}

// --- hash cache: path → size/mtime/hash, so unchanged files aren't re-read ---
type HashCache = Record<string, { size: number; mtime: number; hash: string }>;
const CACHE_URI = `${SYNC_DIR}hashes.json`;

export const androidFs: SyncFs = {
  async list(): Promise<Manifest> {
    const cache = await readJson<HashCache>(CACHE_URI, {});
    const next: HashCache = {};
    const m: Manifest = {};
    const add = async (uri: string, rel: string): Promise<void> => {
      if (ignored(rel)) return;
      const info = await FileSystem.getInfoAsync(uri);
      if (!info.exists || info.isDirectory) return;
      const size = info.size ?? 0;
      const mtime = info.modificationTime ?? 0;
      if (size > 200 * 1024 * 1024) return;
      const c = cache[rel];
      let hash: string;
      if (c && c.size === size && c.mtime === mtime) hash = c.hash;
      else hash = sha256(fromBase64(await FileSystem.readAsStringAsync(uri, B64)));
      next[rel] = { size, mtime, hash };
      const e: Entry = { hash, size, mtime: mtime * 1000 };
      m[rel] = e;
    };
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let names: string[] = [];
      try {
        names = await FileSystem.readDirectoryAsync(dir);
      } catch {
        return;
      }
      for (const n of names) {
        if (n.startsWith('.')) continue;
        const rel = prefix ? `${prefix}/${n}` : n;
        if (!prefix && (n === 'inbox' || n === 'daily')) continue; // staging lives elsewhere
        const uri = `${dir}${n}`;
        const info = await FileSystem.getInfoAsync(uri);
        if (info.isDirectory) await walk(`${uri}/`, rel);
        else await add(uri, rel);
      }
    };
    await walk(R.vault, '');
    for (const [dir, prefix] of [
      [R.inbox, 'inbox'],
      [R.daily, 'daily']
    ] as const) {
      let names: string[] = [];
      try {
        names = await FileSystem.readDirectoryAsync(dir);
      } catch {
        continue;
      }
      for (const n of names) if (!n.startsWith('.')) await add(`${dir}${n}`, `${prefix}/${n}`);
    }
    await writeJson(CACHE_URI, next);
    return m;
  },
  async read(rel) {
    return fromBase64(await FileSystem.readAsStringAsync(uriFor(rel), B64));
  },
  async write(rel, data) {
    const uri = uriFor(rel);
    await mkdirp(parentOf(uri));
    const tmp = `${parentOf(uri)}.${toHex(random(4))}.inkfish-sync`;
    await FileSystem.writeAsStringAsync(tmp, toBase64(data), B64);
    await FileSystem.deleteAsync(uri, { idempotent: true });
    await FileSystem.moveAsync({ from: tmp, to: uri });
  },
  async remove(rel) {
    const uri = uriFor(rel);
    const info = await FileSystem.getInfoAsync(uri);
    if (!info.exists) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = `${TRASH}${stamp}/${rel}`;
    await mkdirp(parentOf(dest));
    await FileSystem.moveAsync({ from: uri, to: dest });
  },
  async move(from, to) {
    const a = uriFor(from);
    const b = uriFor(to);
    const info = await FileSystem.getInfoAsync(a);
    if (!info.exists) return;
    await mkdirp(parentOf(b));
    await FileSystem.moveAsync({ from: a, to: b });
  }
};

// --- per-Mac state: base manifest + cached base texts ------------------------

export function stateFor(macId: string): SyncState {
  const dir = `${SYNC_DIR}${macId.replace(/[^A-Za-z0-9_-]/g, '')}/`;
  const texts = `${dir}base/`;
  return {
    loadBase: () => readJson<Base>(`${dir}base.json`, {}),
    saveBase: (b) => writeJson(`${dir}base.json`, b),
    async getText(hash) {
      try {
        return await FileSystem.readAsStringAsync(`${texts}${hash}`, UTF8);
      } catch {
        return null;
      }
    },
    async putText(hash, text) {
      await mkdirp(texts);
      await FileSystem.writeAsStringAsync(`${texts}${hash}`, text, UTF8);
    },
    async pruneTexts(keep) {
      let names: string[] = [];
      try {
        names = await FileSystem.readDirectoryAsync(texts);
      } catch {
        return;
      }
      for (const n of names) if (!keep.has(n)) await FileSystem.deleteAsync(`${texts}${n}`, { idempotent: true });
    }
  };
}

// --- identity + paired Mac ----------------------------------------------------

interface Identity {
  id: string;
  mac: MacPeer | null;
}
const ID_URI = `${SYNC_DIR}identity.json`;

export async function loadIdentity(): Promise<Identity> {
  const v = await readJson<Partial<Identity>>(ID_URI, {});
  if (v.id) return { id: v.id, mac: v.mac ?? null };
  const fresh: Identity = { id: `android-${toBase64(random(9), true)}`, mac: null };
  await writeJson(ID_URI, fresh);
  return fresh;
}

export async function saveIdentity(v: Identity): Promise<void> {
  await writeJson(ID_URI, v);
}

/** Forget the Mac and its sync state (files stay). */
export async function forgetMac(v: Identity): Promise<Identity> {
  if (v.mac) await FileSystem.deleteAsync(`${SYNC_DIR}${v.mac.id.replace(/[^A-Za-z0-9_-]/g, '')}/`, { idempotent: true });
  const next = { ...v, mac: null };
  await saveIdentity(next);
  return next;
}
