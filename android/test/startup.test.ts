import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { FakeFs, seedVault } from './helpers/fakefs';
import { progressWorthRender, PROGRESS_RENDER_MS } from '../src/lib/syncstatus';
import type { SyncProgress } from '../src/lib/sync';

/**
 * Startup / open-note cost on a 2,000-note vault (fake expo fs, counts only).
 * Pins the fixes for "black screen + spinner" on android-v0.2.7: no vault walk
 * before first paint, a saved index on relaunch, one file per note open.
 */
const fs = new FakeFs();
fs.scale = 0;
mock.module('expo-file-system/legacy', () => fs.module);
const vault = await import('../src/lib/vault');

const VAULT = `${fs.root}inkfish/vault/`;
let seeded: { rels: string[]; ids: string[] };

function fresh(notes = 2000, images = 300): void {
  fs.files.clear();
  fs.dirs = new Set([fs.root.slice(0, -1)]);
  seeded = seedVault(fs, { notes, images });
  vault.resetMemoryForTests();
  fs.resetCounts();
}

beforeEach(() => fresh());

describe('index scan', () => {
  test('finds every note, even with more than 6 folders per level (v0.2.14 dropped the rest)', async () => {
    const index = await vault.listVaultIndex();
    expect(index.notes).toHaveLength(2000);
    expect(new Set(index.notes.map((n) => n.path))).toEqual(new Set(seeded.rels));
    expect(index.projects.map((p) => p.name)).toContain('travel');
    expect(index.dirs.filter((d) => !d.includes('/'))).toHaveLength(10);
  });

  test('images are listed as attachments without a stat each, and no second walk for them', async () => {
    await vault.listVaultIndex();
    const dirCount = fs.dirs.size;
    expect(fs.counts.stat).toBeLessThan(2000 + dirCount + 10);
    const before = fs.total();
    const att = await vault.listAttachments();
    expect(att.filter((p) => p.endsWith('.png'))).toHaveLength(300);
    expect(fs.total()).toBe(before);
  });

  test('ensureTree makes folders once and never walks the vault', async () => {
    await vault.ensureTree();
    await vault.ensureTree();
    expect(fs.counts.readDir).toBe(0);
    expect(fs.counts.stat).toBeLessThanOrEqual(5);
  });

  test('case duplicates are healed only when the scan sees one', async () => {
    await vault.listVaultIndex();
    const clean = fs.counts.readDir;
    // one readDir per folder: no extra heal walk
    expect(clean).toBeLessThanOrEqual(fs.dirs.size);
    fresh(50, 0);
    fs.put(`${VAULT}Personal/x.md`, '# x\n');
    const index = await vault.listVaultIndex();
    expect(index.dirs).not.toContain('Personal');
    expect(index.notes.map((n) => n.path)).toContain('personal/x.md');
  });
});

describe('saved index (relaunch)', () => {
  test('relaunch shows the saved index from one read, then rescans with zero note reads', async () => {
    const first = await vault.listVaultIndex();
    await vault.saveIndexSnapshot(first, await vault.listInbox());
    vault.resetMemoryForTests(); // new process
    fs.resetCounts();
    const snap = await vault.loadIndexSnapshot();
    expect(fs.total()).toBe(1);
    expect(snap?.notes).toHaveLength(2000);
    fs.resetCounts();
    const again = await vault.listVaultIndex();
    expect(again.notes).toHaveLength(2000);
    expect(fs.counts.read).toBe(0);
  });

  test('only changed notes are re-read', async () => {
    const first = await vault.listVaultIndex();
    await vault.saveIndexSnapshot(first, []);
    vault.resetMemoryForTests();
    await vault.loadIndexSnapshot();
    for (const rel of seeded.rels.slice(0, 7)) {
      const k = `${VAULT}${rel}`;
      const f = fs.files.get(k)!;
      fs.files.set(k, { text: `${f.text}more\n`, size: f.size + 5, mtime: f.mtime + 10 });
    }
    fs.resetCounts();
    await vault.listVaultIndex();
    expect(fs.counts.read).toBe(7);
  });

  test('a corrupt or old snapshot is ignored (one full scan instead)', async () => {
    fs.put(`${fs.root}inkfish/.cache/index-v1.json`, '{"v":1,"notes":');
    expect(await vault.loadIndexSnapshot()).toBeNull();
    fs.put(`${fs.root}inkfish/.cache/index-v1.json`, '{"v":0,"notes":[],"dirs":[],"projects":[],"inbox":[]}');
    expect(await vault.loadIndexSnapshot()).toBeNull();
  });

  test('first launch: a stat-only index (names, path ids) arrives before any note is read', async () => {
    let rough: vault.VaultIndex | null = null;
    let readsAtPartial = -1;
    const index = await vault.listVaultIndex({
      onPartial: (r) => {
        rough = r;
        readsAtPartial = fs.counts.read;
      }
    });
    expect(readsAtPartial).toBe(0);
    const r = rough as unknown as vault.VaultIndex;
    expect(r.notes).toHaveLength(2000);
    const row = r.notes.find((n) => n.path === seeded.rels[97])!;
    expect(row.id).toBe(seeded.rels[97]!);
    expect(row.title).toBe(seeded.rels[97]!.split('/').pop()!.replace(/\.md$/, ''));
    expect(index.notes.find((n) => n.path === seeded.rels[97])!.id).toBe(seeded.ids[1]!);
  });
});

describe('open note', () => {
  test('by id with an index: one stat + one read, no scan', async () => {
    await vault.listVaultIndex();
    fs.resetCounts();
    const doc = await vault.getNote(seeded.ids[3]!);
    expect(doc?.path).toBe(seeded.rels[3 * 97]!);
    expect(fs.counts.readDir).toBe(0);
    expect(fs.total()).toBeLessThanOrEqual(2);
  });

  test('by path before the index is read (first-launch drawer row) opens the file', async () => {
    const rel = seeded.rels[97]!;
    const doc = await vault.getNote(rel);
    expect(doc?.path).toBe(rel);
    expect(doc?.id).toBe(seeded.ids[1]!);
    expect(fs.counts.readDir).toBe(0);
  });

  test('unknown to the index: found with one shared parallel scan', async () => {
    const doc = await vault.getNote(seeded.ids[5]!);
    expect(doc?.path).toBe(seeded.rels[5 * 97]!);
    fs.resetCounts();
    await vault.getNote(seeded.ids[6]!);
    expect(fs.total()).toBeLessThanOrEqual(2); // index now known
  });

  test('inbox items open by their id', async () => {
    const doc = await vault.getNote('in_3');
    expect(doc?.path).toBe('inbox/in_3.md');
    expect(fs.total()).toBeLessThanOrEqual(2);
  });

  test('a stale index entry is verified, never opens the wrong note', async () => {
    await vault.listVaultIndex();
    const rel = seeded.rels[2 * 97]!;
    const k = `${VAULT}${rel}`;
    const f = fs.files.get(k)!;
    fs.files.delete(k);
    fs.put(`${VAULT}moved/${rel.split('/').pop()}`, f.text);
    fs.put(k, '---\nid: someone-else\n---\n# other\n');
    const doc = await vault.getNote(seeded.ids[2]!);
    expect(doc?.path).toBe(`moved/${rel.split('/').pop()}`);
  });

  test('saving patches the index row (no rescan needed)', async () => {
    await vault.listVaultIndex();
    const id = seeded.ids[4]!;
    const doc = (await vault.getNote(id))!;
    const saved = (await vault.saveNote(id, `${doc.markdown}\nadded\n`, { base: doc.markdown, path: doc.path, head: doc.head }))!;
    expect(vault.takeRescan()).toBe(false);
    const row = vault.entryOfDoc(saved);
    expect(row).not.toHaveProperty('markdown');
    fs.resetCounts();
    await vault.listVaultIndex();
    expect(fs.counts.read).toBe(0); // the saved note's new size/mtime is already cached
  });
});

describe('sync progress re-renders', () => {
  const p = (x: Partial<SyncProgress>): SyncProgress => ({ stage: 'downloading', done: 0, total: 10, bytesDone: 0, bytesTotal: 0, startedAt: 0, stageAt: 0, ...x });
  test('stage changes and the last tick always render; ticks in between are thinned', () => {
    expect(progressWorthRender(null, p({}), 0, 0)).toBe(true);
    expect(progressWorthRender(p({ stage: 'comparing' }), p({}), 1000, 1001)).toBe(true);
    expect(progressWorthRender(p({ done: 1 }), p({ done: 2 }), 1000, 1000 + PROGRESS_RENDER_MS - 1)).toBe(false);
    expect(progressWorthRender(p({ done: 1 }), p({ done: 2 }), 1000, 1000 + PROGRESS_RENDER_MS)).toBe(true);
    expect(progressWorthRender(p({ done: 9 }), p({ done: 10 }), 1000, 1001)).toBe(true);
  });
});

describe('journal days (staging/daily summaries)', () => {
  const DAILY = `${fs.root}inkfish/staging/daily/`;
  const dayName = (i: number): string => {
    const d = new Date(2025, 0, 1 + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  function seedDays(n: number): void {
    // seedVault adds a few legacy September days; start this folder clean.
    for (const k of [...fs.files.keys()]) if (k.startsWith(DAILY)) fs.files.delete(k);
    for (let i = 0; i < n; i++) {
      fs.put(
        `${DAILY}${dayName(i)}.md`,
        `---\nkind: daily\ncreated: 2025-01-01T00:00:00.000Z\nsource: android\n---\n- 09:0${i % 10} entry ${i}\n- 12:00 · voice · lunch [[x]]\n- 18:30 home\n- 20:00 tv\n- 22:00 bed\n`
      );
    }
    fs.put(`${DAILY}notes.md`, 'not a day');
  }

  test('lists every day newest first with counts + first entries, from one folder listing', async () => {
    seedDays(300);
    fs.resetCounts();
    const days = await vault.listDays();
    expect(days).toHaveLength(300);
    expect(days[0]!.day > days[299]!.day).toBe(true);
    expect(days[0]!.path).toBe(`daily/${days[0]!.day}.md`);
    expect(days[0]!.id).toBe(days[0]!.path);
    expect(days[0]!.count).toBe(5);
    expect(days[0]!.entries).toHaveLength(4);
    expect(days[0]!.entries[1]).toEqual({ time: '12:00', text: 'lunch x', kind: 'voice' });
    expect(days[0]!.snippet).toContain('lunch x');
    expect(fs.counts.readDir).toBe(1);
    expect(fs.counts.read).toBe(300);
    // never walks the vault
    expect(fs.counts.stat).toBe(300);
  });

  test('a second pass re-reads only changed days and drops deleted ones', async () => {
    seedDays(120);
    await vault.listDays();
    const changed = `${DAILY}${dayName(5)}.md`;
    const f = fs.files.get(changed)!;
    fs.files.set(changed, { text: `${f.text}- 23:00 late\n`, size: f.size + 14, mtime: f.mtime + 10 });
    fs.files.delete(`${DAILY}${dayName(6)}.md`);
    fs.resetCounts();
    const days = await vault.listDays();
    expect(fs.counts.read).toBe(1);
    expect(days).toHaveLength(119);
    expect(days.find((d) => d.day === dayName(5))!.count).toBe(6);
  });

  test('summaries ride in the saved index: relaunch has them with zero day reads', async () => {
    seedDays(200);
    const index = await vault.listVaultIndex();
    const days = await vault.listDays();
    await vault.saveIndexSnapshot(index, [], days);
    vault.resetMemoryForTests();
    expect(vault.cachedDays()).toHaveLength(0);
    fs.resetCounts();
    await vault.loadIndexSnapshot();
    expect(fs.total()).toBe(1);
    expect(vault.cachedDays()).toHaveLength(200);
    expect(vault.cachedDays()[0]!.day).toBe(days[0]!.day);
    fs.resetCounts();
    await vault.listDays();
    expect(fs.counts.read).toBe(0);
  });

  test('readDay returns the body without front matter; missing day is empty', async () => {
    seedDays(3);
    expect(await vault.readDay(dayName(0))).toBe('- 09:00 entry 0\n- 12:00 · voice · lunch [[x]]\n- 18:30 home\n- 20:00 tv\n- 22:00 bed\n');
    expect(await vault.readDay('1999-01-01')).toBe('');
  });
});
