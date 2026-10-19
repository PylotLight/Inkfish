/**
 * Vault I/O on top of `expo-file-system` (legacy string API — present in all
 * SDKs; migrate to the `File`/`Directory` API when it is removed).
 *
 * On-disk layout mirrors the Mac app exactly so a future sync is a plain
 * file copy — `.md` files stay the source of truth:
 *
 *   <doc>/inkfish/vault/...          finalised notes + assets/  (Mac: ~/Inkfish/)
 *   <doc>/inkfish/staging/inbox/…    raw captures               (Mac: app-data staging)
 *   <doc>/inkfish/staging/daily/…    day-log scratch
 *   <doc>/inkfish/staging/undone/…   undone routings
 *
 * V1 has no SQLite index (Mac uses FTS5 + sqlite-vec as a *cache*). Lists and
 * search scan files directly — fine for hundreds of notes, and the Mac
 * re-indexes from files on first sync anyway.
 */
import * as FileSystem from 'expo-file-system/legacy';
import {
  entryFromFile,
  inboxFromFile,
  newId,
  slugify,
  slugToId,
  stringifyFrontmatter,
  type InboxItem,
  type NoteDoc,
  type NoteEntry,
  type NoteKind,
  type NoteSource,
  type NoteStatus,
  type Project
} from './format';
import { bodyOf, frontmatterHead, planSave, relocate, withHead } from './notesave';
import { relinkAfterRename } from './relink';
import { appendToDailyFile, dayOfPath, formatEntry, localDay, splitDailyFile, stripLegacyTitle, type DailyEntry } from '../../../src/shared/daily';
import { summarizeDay } from '../../../src/shared/journal';

const DOC = FileSystem.documentDirectory ?? '';
const APP = `${DOC}inkfish/`;
const VAULT = `${APP}vault/`;
const STAGING = `${APP}staging/`;
const INBOX = `${STAGING}inbox/`;
const DAILY = `${STAGING}daily/`;
const ASSETS = `${VAULT}assets/`;
const UNDONE = `${STAGING}undone/`;

export function vaultRootUri(): string {
  return VAULT;
}
export function stagingUri(): string {
  return STAGING;
}
/** Roots the sync layer maps `inbox/`, `daily/` and vault paths onto. */
export function syncRoots(): { app: string; vault: string; inbox: string; daily: string } {
  return { app: APP, vault: VAULT, inbox: INBOX, daily: DAILY };
}

/** Dirs that are staging/app-owned, never projects (same set as Mac). */
const RESERVED = new Set(['inbox', 'daily', 'assets']);

async function mkdir(uri: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) await FileSystem.makeDirectoryAsync(uri, { intermediates: true });
}

let ensureTreeTask: Promise<void> | null = null;
let treeMade = false;

/**
 * Make the app's folders (once per launch). Cheap: no vault walk. Case-duplicate
 * healing used to run here on EVERY call — a full sequential stat walk of the
 * vault, images included, before every list, open and save. Now it runs only
 * when an index scan (below) or the sync walk actually sees a case-duplicate.
 */
export function ensureTree(): Promise<void> {
  if (treeMade) return Promise.resolve();
  if (ensureTreeTask) return ensureTreeTask;
  const task = (async () => {
    await Promise.all([VAULT, INBOX, DAILY, ASSETS, UNDONE].map((d) => mkdir(d)));
    treeMade = true;
  })();
  ensureTreeTask = task;
  task.finally(() => {
    if (ensureTreeTask === task) ensureTreeTask = null;
  }).catch(() => undefined);
  return task;
}

/**
 * Names that are certainly files, not folders (images, audio, docs): listing
 * code records them without a stat. Saves one bridge call per attachment.
 */
const SKIP_STAT = /\.(png|jpe?g|gif|webp|heic|heif|bmp|svg|avif|tiff?|m4a|mp3|wav|ogg|opus|aac|flac|mp4|mov|webm|pdf|zip|json|txt|csv)$/i;

async function writeText(uri: string, text: string): Promise<void> {
  await FileSystem.writeAsStringAsync(uri, text, {
    encoding: FileSystem.EncodingType.UTF8
  });
}

async function readText(uri: string): Promise<string> {
  return FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
}

async function childDirs(dir: string): Promise<string[]> {
  try {
    const names = (await FileSystem.readDirectoryAsync(dir)).filter((n) => !n.startsWith('.') && !SKIP_STAT.test(n) && !n.endsWith('.md'));
    const hits = await mapLimit(names, 8, async (n) => {
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      return info.exists && info.isDirectory;
    });
    return names.filter((_, i) => hits[i]).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function childFiles(dir: string): Promise<string[]> {
  try {
    const names = (await FileSystem.readDirectoryAsync(dir)).filter((n) => !n.startsWith('.') && n.endsWith('.md'));
    const hits = await mapLimit(names, 8, async (n) => {
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      return info.exists && !info.isDirectory;
    });
    return names.filter((_, i) => hits[i]).sort();
  } catch {
    return [];
  }
}

// --- case-duplicate healing ------------------------------------------------------
// `Personal` vs `personal`: one dir on case-insensitive APFS, two on
// case-sensitive Android/Linux. Fold is plain lowercase — identical to Mac's
// `foldName` — so both sides converge on the same survivor.

function foldName(s: string): string {
  return s.toLowerCase();
}

function pickSurvivor(names: string[]): string {
  return names.find((n) => n === foldName(n)) ?? [...names].sort()[0]!;
}

/** Direct child dir matching `name` case-insensitively (on-disk spelling). */
async function childDirNamed(dir: string, name: string, includeHidden = false): Promise<string | null> {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return null;
  }
  const want = foldName(name);
  for (const n of names) {
    if (n === name) return n;
    if (!includeHidden && n.startsWith('.')) continue;
    if (foldName(n) !== want) continue;
    const info = await FileSystem.getInfoAsync(`${dir}${n}`);
    if (info.exists && info.isDirectory) return n;
  }
  return null;
}

/** Resolve each segment of dirRel to its on-disk spelling (see Mac `resolveDirRel`). */
export async function resolveDirRel(dirRel: string): Promise<string> {
  if (!dirRel) return '';
  const out: string[] = [];
  let cur = VAULT;
  for (const seg of dirRel.split('/')) {
    if (!seg || seg === '.') continue;
    const hit = await childDirNamed(cur, seg);
    const use = hit ?? seg;
    out.push(use);
    cur = `${cur}${use}/`;
  }
  return out.join('/');
}

/** True when the folder holds nothing but hidden files (or nothing at all). */
async function dirIsEmpty(uri: string): Promise<boolean> {
  try {
    const names = await FileSystem.readDirectoryAsync(uri);
    for (const n of names) {
      if (!n.startsWith('.')) return false;
      const info = await FileSystem.getInfoAsync(`${uri}${n}`);
      if (info.exists && info.isDirectory) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function uniqueName(dir: string, file: string): Promise<string> {
  const dot = file.lastIndexOf('.');
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : '';
  let name = file;
  let i = 1;
  while ((await FileSystem.getInfoAsync(`${dir}${name}`)).exists) {
    i++;
    name = `${base} ${i}${ext}`;
  }
  return name;
}

async function fileTextEq(a: string, b: string): Promise<boolean> {
  try {
    return (await readText(a)) === (await readText(b));
  } catch {
    return false;
  }
}

async function mergeDirInto(srcDir: string, dstDir: string): Promise<number> {
  let files = 0;
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(srcDir);
  } catch {
    return 0;
  }
  for (const n of names) {
    const from = `${srcDir}${n}`;
    const info = await FileSystem.getInfoAsync(from);
    if (!info.exists) continue;
    if (info.isDirectory) {
      const hit = await childDirNamed(dstDir, n, true);
      if (hit) {
        files += await mergeDirInto(`${from}/`, `${dstDir}${hit}/`);
        await FileSystem.deleteAsync(from, { idempotent: true });
      } else {
        await FileSystem.moveAsync({ from, to: `${dstDir}${n}` });
      }
      continue;
    }
    if (!info.isDirectory && !n.endsWith('.md')) {
      // Non-note files ride along; bump on any collision so nothing is lost.
      if (!(await FileSystem.getInfoAsync(`${dstDir}${n}`)).exists) {
        await FileSystem.moveAsync({ from, to: `${dstDir}${n}` });
      } else {
        const bumped = await uniqueName(dstDir, n);
        await FileSystem.moveAsync({ from, to: `${dstDir}${bumped}` });
      }
      continue;
    }
    let onto: string | null = null;
    if ((await FileSystem.getInfoAsync(`${dstDir}${n}`)).exists) onto = n;
    else {
      // Case-variant of an existing note?
      let kids: string[];
      try {
        kids = await FileSystem.readDirectoryAsync(dstDir);
      } catch {
        kids = [];
      }
      for (const k of kids) {
        if (k === n || foldName(k) !== foldName(n)) continue;
        const ki = await FileSystem.getInfoAsync(`${dstDir}${k}`);
        if (ki.exists && !ki.isDirectory) {
          onto = k;
          break;
        }
      }
    }
    if (!onto) {
      await FileSystem.moveAsync({ from, to: `${dstDir}${n}` });
      files++;
    } else if (await fileTextEq(from, `${dstDir}${onto}`)) {
      await FileSystem.deleteAsync(from, { idempotent: true });
    } else {
      const bumped = await uniqueName(dstDir, n);
      await FileSystem.moveAsync({ from, to: `${dstDir}${bumped}` });
      files++;
    }
  }
  return files;
}

export interface CaseMergeReport {
  dirs: number;
  files: number;
}

/** Collapse sibling dirs/notes that differ only by case, recursively.
 * Same survivor rule as Mac — both sides always agree. Reserved top-level
 * names are skipped. */
export async function mergeCaseDuplicates(): Promise<CaseMergeReport> {
  const report: CaseMergeReport = { dirs: 0, files: 0 };
  const heal = async (dir: string, top: boolean): Promise<void> => {
    let names: string[];
    try {
      names = await FileSystem.readDirectoryAsync(dir);
    } catch {
      return;
    }
    const dirGroups = new Map<string, string[]>();
    const fileGroups = new Map<string, string[]>();
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      if (!info.exists) continue;
      const key = foldName(n);
      if (info.isDirectory) {
        if (top && RESERVED.has(key)) continue;
        const arr = dirGroups.get(key) ?? [];
        arr.push(n);
        dirGroups.set(key, arr);
      } else if (n.endsWith('.md')) {
        const arr = fileGroups.get(key) ?? [];
        arr.push(n);
        fileGroups.set(key, arr);
      }
    }
    for (const [key, all] of dirGroups) {
      if (all.length < 2) continue;
      // An empty spelling (a seeded `work/`, or one sync just emptied by
      // adopting the Mac's `Work/`) is dropped, never chosen as the survivor —
      // otherwise the heal fights the Mac's spelling and sync loops.
      const group: string[] = [];
      for (const n of all) {
        if (await dirIsEmpty(`${dir}${n}/`)) await FileSystem.deleteAsync(`${dir}${n}`, { idempotent: true });
        else group.push(n);
      }
      if (group.length < 2) continue;
      const survivor = pickSurvivor(group);
      if (survivor !== key) await FileSystem.moveAsync({ from: `${dir}${survivor}`, to: `${dir}${key}` });
      for (const loser of group) {
        if (loser === survivor) continue;
        report.files += await mergeDirInto(`${dir}${loser}/`, `${dir}${key}/`);
        await FileSystem.deleteAsync(`${dir}${loser}`, { idempotent: true });
      }
      report.dirs++;
    }
    for (const [key, group] of fileGroups) {
      if (group.length < 2) continue;
      const survivor = pickSurvivor(group);
      if (survivor !== key) await FileSystem.moveAsync({ from: `${dir}${survivor}`, to: `${dir}${key}` });
      for (const loser of group) {
        if (loser === survivor) continue;
        const from = `${dir}${loser}`;
        const onto = `${dir}${key}`;
        if (await fileTextEq(from, onto)) {
          await FileSystem.deleteAsync(from, { idempotent: true });
        } else {
          const bumped = await uniqueName(dir, loser);
          await FileSystem.moveAsync({ from, to: `${dir}${bumped}` });
          report.files++;
        }
      }
    }
    let next: string[];
    try {
      next = await FileSystem.readDirectoryAsync(dir);
    } catch {
      return;
    }
    for (const n of next) {
      if (n.startsWith('.')) continue;
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      if (info.exists && info.isDirectory) await heal(`${dir}${n}/`, false);
    }
  };
  await heal(VAULT, true);
  return report;
}

interface ScannedFile {
  rel: string;
  uri: string;
  size: number;
  mtime: number;
}

export interface VaultScan {
  files: ScannedFile[];
  dirs: string[];
  /** Non-note files (images, audio…), vault-relative — recorded without a stat. */
  attachments: string[];
  /** Some folder holds two names that differ only by case (needs a heal). */
  caseDupes: boolean;
}

type ScannedChild =
  | { kind: 'dir'; uri: string; rel: string }
  | { kind: 'file'; file: ScannedFile }
  | { kind: 'attachment'; rel: string };

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

function hasCaseDupes(names: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const n of names) {
    const k = foldName(n);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/**
 * One bounded-concurrency inventory pass for notes, folders and attachments.
 * Every folder of a level is listed (the v0.2.14 walk only descended into the
 * first 6 folders of each level and silently dropped the rest — notes went
 * missing from the drawer in bigger vaults). Attachments by extension skip the stat.
 */
async function scanVault(root = VAULT, relBase = ''): Promise<VaultScan> {
  const files: ScannedFile[] = [];
  const dirs: string[] = [];
  const attachments: string[] = [];
  let caseDupes = false;
  let pending = [{ uri: root, rel: relBase }];

  while (pending.length) {
    const parents = pending;
    pending = [];
    const groups = await mapLimit(parents, 6, async (parent): Promise<ScannedChild[]> => {
      let names: string[];
      try {
        names = await FileSystem.readDirectoryAsync(parent.uri);
      } catch {
        return [];
      }
      const visible = names.filter((name) => !name.startsWith('.'));
      // Only what the heal handles (folders + notes; reserved top-level names are never healed).
      const healable = visible.filter((n) => !SKIP_STAT.test(n) && !(parent.rel === '' && RESERVED.has(foldName(n))));
      if (!caseDupes && hasCaseDupes(healable)) caseDupes = true;
      const children = await mapLimit(visible, 8, async (name): Promise<ScannedChild | null> => {
        const uri = `${parent.uri}${name}`;
        const rel = parent.rel ? `${parent.rel}/${name}` : name;
        const top = rel.split('/')[0] ?? '';
        if (top === 'inbox' || top === 'daily') return null;
        if (SKIP_STAT.test(name)) return { kind: 'attachment', rel };
        try {
          const info = await FileSystem.getInfoAsync(uri);
          if (!info.exists) return null;
          if (info.isDirectory) return { kind: 'dir', uri: `${uri}/`, rel };
          if (!name.endsWith('.md')) return /\.markdown$/i.test(name) ? null : { kind: 'attachment', rel };
          return {
            kind: 'file',
            file: {
              rel,
              uri,
              size: info.size ?? 0,
              mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
            }
          };
        } catch {
          return null;
        }
      });
      return children.filter((child): child is ScannedChild => child !== null);
    });

    for (const group of groups) {
      for (const child of group) {
        if (child.kind === 'file') {
          files.push(child.file);
          continue;
        }
        if (child.kind === 'attachment') {
          attachments.push(child.rel);
          continue;
        }
        const top = child.rel.split('/')[0] ?? '';
        // `assets` is scanned for legacy markdown, but never appears in the
        // sidebar. Inbox/daily were skipped above, matching the previous walk.
        if (!RESERVED.has(top.toLowerCase())) dirs.push(child.rel);
        pending.push(child);
      }
    }
  }

  dirs.sort((a, b) => a.localeCompare(b));
  attachments.sort();
  return { files, dirs, attachments, caseDupes };
}

/** Recursive vault walk — every non-hidden `.md` (our notes + imported trees). */
async function walkVault(dir: string, relBase: string, out: string[]): Promise<void> {
  const scan = await scanVault(dir, relBase);
  out.push(...scan.files.map((file) => file.rel));
}

const noteEntryCache = new Map<string, { size: number; mtime: number; entry: NoteEntry }>();
/** Note id → vault rel from the latest index, so opening a note is one file, not a vault scan. */
const idToRel = new Map<string, string>();

function rememberIds(entries: readonly NoteEntry[]): void {
  idToRel.clear();
  for (const e of entries) idToRel.set(e.id, e.path);
}

async function entriesFromFiles(files: ScannedFile[]): Promise<NoteEntry[]> {
  const entries = await mapLimit(files, 8, async (file): Promise<NoteEntry | null> => {
    const cached = noteEntryCache.get(file.rel);
    if (cached && cached.size === file.size && cached.mtime === file.mtime) return cached.entry;
    try {
      const entry = entryFromFile(file.rel, await readText(file.uri), { size: file.size, mtime: file.mtime });
      noteEntryCache.set(file.rel, { size: file.size, mtime: file.mtime, entry });
      return entry;
    } catch {
      noteEntryCache.delete(file.rel);
      return null;
    }
  });
  const present = new Set(files.map((file) => file.rel));
  for (const path of noteEntryCache.keys()) {
    if (!present.has(path)) noteEntryCache.delete(path);
  }
  return entries.filter((entry): entry is NoteEntry => entry !== null);
}

/** Every folder in the vault (rel paths), app-managed ones excluded — so empty folders still show in the sidebar. */
export async function listDirs(): Promise<string[]> {
  await ensureTree();
  return (await scanVault()).dirs;
}

// --- projects ---

const COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5'];

function projectsFromNames(names: string[]): Project[] {
  const seen = new Set<string>();
  const found: Project[] = [];
  for (const name of names) {
    if (RESERVED.has(name.toLowerCase())) continue;
    const id = slugToId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ id, name, dir: name });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name)).map((project, index) => ({
    ...project,
    color: COLORS[index % COLORS.length]
  } as Project));
}

export async function listProjects(): Promise<Project[]> {
  await ensureTree();
  return projectsFromNames(await childDirs(VAULT));
}

export async function createProject(name: string): Promise<Project> {
  const slug = slugify(name, 32);
  if (!slug || slug === 'untitled') throw new Error('project name is empty');
  await mkdir(`${VAULT}${slug}/`);
  return { id: slugToId(slug), name: slug, dir: slug };
}

export async function ensureSeedProjects(): Promise<Project[]> {
  await ensureTree();
  const rels: string[] = [];
  await walkVault(VAULT, '', rels);
  if (rels.length === 0) {
    for (const name of ['personal', 'work', 'reading']) await mkdir(`${VAULT}${name}/`);
  }
  return projectsFromNames(await childDirs(VAULT));
}

export interface VaultIndex {
  notes: NoteEntry[];
  projects: Project[];
  dirs: string[];
}

let indexTask: Promise<VaultIndex> | null = null;

/**
 * Load all sidebar/store data from one filesystem inventory. Concurrent callers
 * share one pass. `onPartial` (first launch, no saved index) gets a stat-only
 * index — file names as titles, paths as ids — before every note is read, so
 * the drawer fills in seconds instead of after the last file read.
 */
export function listVaultIndex(opts: { onPartial?: (index: VaultIndex) => void } = {}): Promise<VaultIndex> {
  if (indexTask) return indexTask;
  const task = buildVaultIndex(opts.onPartial);
  indexTask = task;
  task.finally(() => {
    if (indexTask === task) indexTask = null;
  }).catch(() => undefined);
  return task;
}

/** Index row from the stat alone: the file name stands in for the title until the file is read. */
function provisionalEntry(file: ScannedFile): NoteEntry {
  return { ...entryFromFile(file.rel, '', { size: file.size, mtime: file.mtime }), title: fileLabel(file.rel) };
}

async function buildVaultIndex(onPartial?: (index: VaultIndex) => void): Promise<VaultIndex> {
  await ensureTree();
  let scan = await scanVault();
  if (scan.caseDupes) {
    // Heal only when this walk saw `Personal` + `personal` (same rule as sync).
    try {
      await mergeCaseDuplicates();
    } catch {
      // best-effort
    }
    scan = await scanVault();
  }
  if (scan.files.length === 0 && scan.dirs.length === 0) {
    await Promise.all(['personal', 'work', 'reading'].map((name) => mkdir(`${VAULT}${name}/`)));
    scan = await scanVault();
  }
  const dirs = scan.dirs;
  const projects = projectsFromNames(dirs.filter((dir) => !dir.includes('/')));
  if (onPartial) {
    const unread = scan.files.filter((f) => {
      const c = noteEntryCache.get(f.rel);
      return !c || c.size !== f.size || c.mtime !== f.mtime;
    }).length;
    if (unread > 200) {
      const rough = scan.files.map((f) => noteEntryCache.get(f.rel)?.entry ?? provisionalEntry(f));
      rough.sort((a, b) => b.updatedAt - a.updatedAt);
      onPartial({ notes: rough, dirs, projects });
    }
  }
  const notes = await entriesFromFiles(scan.files);
  notes.sort((a, b) => b.updatedAt - a.updatedAt);
  rememberIds(notes);
  attachmentsTask = Promise.resolve(scan.attachments.filter((p) => !/\.(md|markdown|txt)$/i.test(p)));
  return { notes, dirs, projects };
}

// --- persisted index snapshot ------------------------------------------------------
// The drawer, Home and search all read the note index. Building it from files
// means a stat per note (and a read per changed note), so the last index is
// kept on disk and shown immediately on launch; the scan then only re-reads
// what changed (size/mtime) and swaps the fresh index in. Files stay the truth:
// a missing or corrupt snapshot just means one full scan. Not synced (lives
// outside vault/ and staging/).

const INDEX_SNAPSHOT = `${APP}.cache/index-v1.json`;

export interface IndexSnapshot {
  v: 1;
  savedAt: number;
  notes: NoteEntry[];
  dirs: string[];
  projects: Project[];
  inbox: InboxItem[];
  attachments?: string[];
  /** Daily-note summaries (Journal / Home Daily) — optional so older snapshots still load. */
  days?: DayInfo[];
}

function seedFromSnapshot(snap: IndexSnapshot): void {
  for (const e of snap.notes) {
    if (!noteEntryCache.has(e.path)) noteEntryCache.set(e.path, { size: e.size, mtime: e.updatedAt, entry: e });
  }
  if (idToRel.size === 0) rememberIds(snap.notes);
  if (!attachmentsTask && snap.attachments) attachmentsTask = Promise.resolve(snap.attachments);
  if (Array.isArray(snap.days)) {
    for (const d of snap.days) if (!dayCache.has(d.path)) dayCache.set(d.path, d);
  }
}

/** Last launch's index (one file read), or null. Seeds the per-file cache so the next scan only reads changes. */
export async function loadIndexSnapshot(): Promise<IndexSnapshot | null> {
  try {
    const raw = JSON.parse(await readText(INDEX_SNAPSHOT)) as Partial<IndexSnapshot>;
    if (raw.v !== 1 || !Array.isArray(raw.notes) || !Array.isArray(raw.dirs) || !Array.isArray(raw.projects) || !Array.isArray(raw.inbox)) return null;
    const snap = raw as IndexSnapshot;
    seedFromSnapshot(snap);
    return snap;
  } catch {
    return null;
  }
}

export async function saveIndexSnapshot(index: VaultIndex, inbox: InboxItem[], days?: DayInfo[]): Promise<void> {
  const snap: IndexSnapshot = {
    v: 1,
    savedAt: Date.now(),
    notes: index.notes,
    dirs: index.dirs,
    projects: index.projects,
    inbox,
    attachments: attachmentsTask ? await attachmentsTask : undefined,
    ...(days ? { days } : {})
  };
  await mkdir(`${APP}.cache/`);
  const tmp = `${INDEX_SNAPSHOT}.tmp`;
  await writeText(tmp, JSON.stringify(snap));
  await FileSystem.moveAsync({ from: tmp, to: INDEX_SNAPSHOT });
}

// --- inbox ---

export interface InboxWriteInput {
  kind: NoteKind;
  raw: string;
  projectHint?: string;
  source?: NoteSource;
  assets?: string[];
}

export async function writeInboxItem(input: InboxWriteInput): Promise<InboxItem> {
  await ensureTree();
  const id = newId('in');
  const createdAt = Date.now();
  const fm = stringifyFrontmatter({
    id,
    kind: input.kind,
    status: 'inbox' satisfies NoteStatus,
    created: new Date(createdAt).toISOString(),
    source: input.source ?? 'android',
    projectHint: input.projectHint ?? 'auto',
    assets: input.assets ?? []
  });
  await writeText(`${INBOX}${id}.md`, `${fm}${input.raw.replace(/\s+$/, '')}\n`);
  return {
    id,
    kind: input.kind,
    raw: input.raw,
    assets: input.assets ?? [],
    status: 'inbox',
    projectHint: input.projectHint ?? 'auto',
    createdAt
  };
}

export async function listInbox(): Promise<InboxItem[]> {
  await ensureTree();
  const files = await childFiles(INBOX);
  const read = await mapLimit(files, 8, async (f): Promise<InboxItem | null> => {
    try {
      return inboxFromFile(f.replace(/\.md$/, ''), await readText(`${INBOX}${f}`));
    } catch {
      return null; // skip unreadable captures
    }
  });
  const items = read.filter((i): i is InboxItem => i !== null);
  return items.sort((a, b) => b.createdAt - a.createdAt);
}

export async function setInboxStatus(id: string, status: NoteStatus): Promise<boolean> {
  const uri = `${INBOX}${id}.md`;
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) return false;
  const { parseFrontmatter } = await import('./format');
  const [fm, body] = parseFrontmatter(await readText(uri));
  fm['status'] = status;
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) flat[k] = v;
  await writeText(uri, `${stringifyFrontmatter(flat)}${body}`);
  return true;
}

// --- routing (rules engine; same output shape as Mac `routeToProject`) ---

export interface RouteInput {
  inboxId: string;
  projectName: string;
  title: string;
  tags: string[];
  markdown: string;
  kind: NoteKind;
}

export async function routeToProject(
  input: RouteInput
): Promise<{ noteId: string; vaultRel: string }> {
  await ensureTree();
  const slug = slugify(input.projectName, 32);
  await mkdir(`${VAULT}${slug}/`);
  const noteId = newId('n');
  const createdAt = Date.now();
  const day = new Date(createdAt).toISOString().slice(0, 10);
  const base = `${day}-${slugify(input.title)}`;
  let name = `${base}.md`;
  let i = 1;
  while ((await FileSystem.getInfoAsync(`${VAULT}${slug}/${name}`)).exists) {
    i++;
    name = `${base} ${i}.md`;
  }
  const fm = stringifyFrontmatter({
    id: noteId,
    inbox: input.inboxId,
    project: slug,
    kind: input.kind,
    created: new Date(createdAt).toISOString(),
    tags: input.tags
  });
  const rel = `${slug}/${name}`;
  await writeText(
    `${VAULT}${rel}`,
    `${fm}# ${input.title}\n\n${input.markdown.replace(/\s+$/, '')}\n`
  );
  return { noteId, vaultRel: rel };
}

/** Undo a routing: processed file → staging/undone, inbox item back to `inbox`. */
export async function undoRoute(inboxId: string): Promise<boolean> {
  await ensureTree();
  const rels: string[] = [];
  await walkVault(VAULT, '', rels);
  let found = false;
  const { parseFrontmatter } = await import('./format');
  for (const rel of rels) {
    try {
      const text = await readText(`${VAULT}${rel}`);
      const [fm] = parseFrontmatter(text);
      if (fm['inbox'] === inboxId) {
        const base = rel.split('/').slice(-1)[0] ?? `${inboxId}.md`;
        await writeText(`${UNDONE}${inboxId}-${base}`, text);
        await FileSystem.deleteAsync(`${VAULT}${rel}`, { idempotent: true });
        found = true;
      }
    } catch {
      // keep going
    }
  }
  await setInboxStatus(inboxId, 'inbox');
  return found;
}

// --- notes ---

export async function noteEntryForRel(rel: string): Promise<NoteEntry | null> {
  const abs = rel.startsWith('inbox/')
    ? `${INBOX}${rel.slice('inbox/'.length)}`
    : rel.startsWith('daily/')
      ? `${DAILY}${rel.slice('daily/'.length)}`
      : `${VAULT}${rel}`;
  const info = await FileSystem.getInfoAsync(abs);
  if (!info.exists || info.isDirectory) return null;
  try {
    return entryFromFile(rel, await readText(abs), {
      size: info.size ?? 0,
      mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
    });
  } catch {
    return null;
  }
}

export async function listNotes(projectId?: string | null): Promise<NoteEntry[]> {
  await ensureTree();
  const out = await entriesFromFiles((await scanVault()).files);
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  if (projectId === 'inbox') return out.filter((e) => e.status === 'inbox' || e.status === 'processing');
  if (projectId) return out.filter((e) => e.projectId === projectId);
  return out;
}

function absForRel(rel: string): string {
  return rel.startsWith('inbox/')
    ? `${INBOX}${rel.slice('inbox/'.length)}`
    : rel.startsWith('daily/')
      ? `${DAILY}${rel.slice('daily/'.length)}`
      : `${VAULT}${rel}`;
}

async function allNoteRels(): Promise<string[]> {
  const rels: string[] = [];
  await walkVault(VAULT, '', rels);
  for (const f of await childFiles(INBOX)) rels.push(`inbox/${f}`);
  for (const f of await childFiles(DAILY)) rels.push(`daily/${f}`);
  return rels;
}

/** Read one note file as a doc: a stat and a read, in parallel. */
async function docAt(rel: string): Promise<NoteDoc | null> {
  const abs = absForRel(rel);
  try {
    const [info, text] = await Promise.all([FileSystem.getInfoAsync(abs), readText(abs)]);
    if (!info.exists || info.isDirectory) return null;
    const e = entryFromFile(rel, text, {
      size: info.size ?? 0,
      mtime: info.modificationTime ? info.modificationTime * 1000 : Date.now()
    });
    return { ...e, markdown: bodyOf(text), head: frontmatterHead(text) };
  } catch {
    return null;
  }
}

/** Where a note id most likely lives, without touching the disk. */
export function candidateRels(id: string): string[] {
  const out: string[] = [];
  const known = idToRel.get(id);
  if (known) out.push(known, followMoves(known));
  if (id.endsWith('.md')) out.push(id, followMoves(id)); // path-id notes (no front matter id)
  out.push(`inbox/${id}.md`); // inbox items open in the editor by their id
  return [...new Set(out)];
}

/**
 * Open a note by id. Used to scan the whole vault one file at a time (two
 * bridge calls per note until it hit the right one) on every open and twice
 * per save. Now: the index says which file, so it's a stat + a read.
 */
export async function getNote(id: string): Promise<NoteDoc | null> {
  // Fast path, verified by the id read back from the file so a stale index can't open the wrong note.
  for (const rel of candidateRels(id)) {
    const doc = await docAt(rel);
    // A path opens the file at that path even when it has a front matter id
    // (rows from a not-yet-read first-launch index carry paths as ids).
    if (doc && (doc.id === id || rel === id)) return doc;
  }
  // Slow path (note created outside this index): share/run one parallel index pass.
  const [index, staged] = await Promise.all([
    listVaultIndex(),
    Promise.all([childFiles(INBOX), childFiles(DAILY)]).then(([i, d]) => [...i.map((f) => `inbox/${f}`), ...d.map((f) => `daily/${f}`)])
  ]);
  const hit = index.notes.find((e) => e.id === id);
  if (hit) return docAt(hit.path);
  for (const rel of staged) {
    const doc = await docAt(rel);
    if (doc && doc.id === id) return doc;
  }
  return null;
}

// --- moves this app knows about (sync renames, phone renames) --------------------
// Notes without a front matter `id` are identified by their path, so an open
// editor loses its note when sync (or the drawer) renames it. Remember recent
// moves so the editor and `saveNote` can follow them.

const moved = new Map<string, string>();

export function recordMoves(moves: ReadonlyArray<{ from: string; to: string }>): void {
  for (const m of moves) {
    if (m.from === m.to) continue;
    moved.set(m.from, m.to);
    moved.delete(m.to);
  }
  // Keep it small: only the latest few hundred matter for open views.
  while (moved.size > 500) moved.delete(moved.keys().next().value as string);
}

/** Where `path` lives now after any recorded moves (itself when it never moved). */
export function followMoves(path: string): string {
  let p = path;
  for (let i = 0; i < 20 && moved.has(p); i++) p = moved.get(p)!;
  return p;
}

// --- every vault file (notes + attachments) ---------------------------------------

/** Vault-relative paths of every non-hidden file in the vault (any type). */
export async function listVaultFiles(): Promise<string[]> {
  const out: string[] = [];
  let pending: Array<{ uri: string; rel: string }> = [{ uri: VAULT, rel: '' }];
  while (pending.length) {
    const batch = pending;
    pending = [];
    await mapLimit(batch, 6, async (dir) => {
      let names: string[];
      try {
        names = await FileSystem.readDirectoryAsync(dir.uri);
      } catch {
        return;
      }
      await mapLimit(
        names.filter((n) => !n.startsWith('.')),
        8,
        async (n) => {
          const rel = dir.rel ? `${dir.rel}/${n}` : n;
          try {
            const info = await FileSystem.getInfoAsync(`${dir.uri}${n}`);
            if (!info.exists) return;
            if (info.isDirectory) pending.push({ uri: `${dir.uri}${n}/`, rel });
            else out.push(rel);
          } catch {
            // vanished mid-walk
          }
        }
      );
    });
  }
  return out.sort();
}

let attachmentsTask: Promise<string[]> | null = null;

/** Non-note files in the vault (images, audio, …) for resolving image refs. Cached until `invalidateAttachments`. */
export function listAttachments(): Promise<string[]> {
  attachmentsTask ??= listVaultFiles()
    .then((all) => all.filter((p) => !/\.(md|markdown|txt)$/i.test(p)))
    .catch(() => []);
  return attachmentsTask;
}

export function invalidateAttachments(): void {
  attachmentsTask = null;
}

/** Tests/bench: forget every in-memory cache, like a fresh app process. */
export function resetMemoryForTests(): void {
  noteEntryCache.clear();
  dayCache.clear();
  daysTask = null;
  idToRel.clear();
  moved.clear();
  attachmentsTask = null;
  indexTask = null;
  treeMade = false;
  rescanWanted = false;
}

export interface SaveContext {
  /** Body the editor opened / last saved (merge base, and how a moved note is found again). */
  base?: string;
  /** Path the editor opened the note at. */
  path?: string;
  /** Front matter the note had when opened (kept if the note has to be recreated). */
  head?: string;
}

/**
 * Save an editor body. Front matter stays byte-for-byte; a change sync made
 * while the note was open is merged rather than overwritten; a note sync moved
 * or deleted under the editor is found again (or recreated) instead of the
 * edit being silently dropped. See `notesave.ts`.
 */
let rescanWanted = false;

/** True once after a save wrote more than the note itself (a conflict copy): the index needs a full rescan. */
export function takeRescan(): boolean {
  const r = rescanWanted;
  rescanWanted = false;
  return r;
}

/** The index row for a doc (drops the body), and remember it so the next scan doesn't re-read the file. */
export function entryOfDoc(doc: NoteDoc): NoteEntry {
  const { markdown: _m, head: _h, ...entry } = doc;
  if (!doc.path.startsWith('inbox/') && !doc.path.startsWith('daily/')) {
    noteEntryCache.set(doc.path, { size: doc.size, mtime: doc.updatedAt, entry });
    idToRel.set(doc.id, doc.path);
  }
  return entry;
}

export async function saveNote(id: string, markdown: string, ctx: SaveContext = {}): Promise<NoteDoc | null> {
  let doc = await getNote(id);
  if (!doc && ctx.path !== undefined && ctx.base !== undefined) {
    // Gone from under the editor: path-id notes (no front matter `id`) lose their id on a move.
    const candidates: Array<{ path: string; body: string }> = [];
    for (const rel of await allNoteRels()) {
      try {
        candidates.push({ path: rel, body: bodyOf(await readText(absForRel(rel))) });
      } catch {
        // unreadable — skip
      }
    }
    // A rename this app saw (sync or drawer) wins; else find it by content.
    const followed = followMoves(ctx.path);
    const rel = followed !== ctx.path && candidates.some((c) => c.path === followed) ? followed : relocate(candidates, ctx.base, ctx.path);
    const abs = absForRel(rel);
    const info = await FileSystem.getInfoAsync(abs);
    if (!info.exists) {
      await mkdir(abs.slice(0, abs.lastIndexOf('/') + 1));
      await writeText(abs, withHead(ctx.head ?? '', markdown));
    } else {
      await writeText(abs, planSave({ path: rel, disk: await readText(abs), base: ctx.base, next: markdown }).file);
    }
    const e = await noteEntryForRel(rel);
    if (!e) return null;
    const text = await readText(abs);
    return { ...e, markdown: bodyOf(text), head: frontmatterHead(text) };
  }
  if (!doc) return null;
  const abs = absForRel(doc.path);
  const disk = await readText(abs);
  const plan = planSave({ path: doc.path, disk, base: ctx.base ?? bodyOf(disk), next: markdown });
  await writeText(abs, plan.file);
  if (plan.conflict) {
    const cAbs = absForRel(plan.conflict.path);
    await mkdir(cAbs.slice(0, cAbs.lastIndexOf('/') + 1));
    await writeText(cAbs, plan.conflict.text);
    rescanWanted = true;
  }
  doc = await getNote(doc.id);
  return doc;
}

export function searchNotesSync(entries: NoteEntry[], query: string): NoteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return entries
    .filter((e) => `${e.title}\n${e.snippet}\n${e.tags.join(' ')}`.toLowerCase().includes(q))
    .slice(0, 50);
}

// --- files: create note / trash ---

/** Display name for a sidebar row — the filename, never content. */
export function fileLabel(vaultRel: string): string {
  const base = vaultRel.split('/').pop() ?? vaultRel;
  return base.replace(/\.md$/i, '');
}

function cleanName(name: string, what: string): string {
  const t = name.trim().replace(/^\/+|\/+$/g, '');
  if (!t) throw new Error(`${what} name is empty`);
  if (t.includes('/') || t.includes('\\')) throw new Error(`${what} name can't contain /`);
  if (t === '.' || t === '..') throw new Error(`${what} name is reserved`);
  if (t.startsWith('.')) throw new Error(`${what} name can't start with .`);
  if (t.includes('..')) throw new Error(`${what} name is outside the vault`);
  return t;
}

function ensureMd(name: string): string {
  return name.toLowerCase().endsWith('.md') ? name : `${name}.md`;
}

/** Create a subfolder inside `parentRel` ('' = vault root). Returns its rel. */
export async function createDir(parentRel: string, name: string): Promise<string> {
  const clean = cleanName(name, 'Folder');
  const parent = await resolveDirRel(parentRel);
  if (parent.split('/').includes('..')) throw new Error('folder is outside the vault');
  const rel = parent ? `${parent}/${clean}` : clean;
  if (rel.split('/').includes('..')) throw new Error('folder is outside the vault');
  if (!parent && RESERVED.has(clean.toLowerCase())) throw new Error(`“${clean}” is reserved`);
  const abs = `${VAULT}${rel}/`;
  if ((await FileSystem.getInfoAsync(abs)).exists) throw new Error(`“${clean}” already exists`);
  await mkdir(abs);
  return rel;
}

const TRASH_VAULT = `${APP}trash/`;

async function trashMove(abs: string, rel: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(abs);
  if (!info.exists) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${TRASH_VAULT}${stamp}/${rel}`;
  await mkdir(dest.slice(0, dest.lastIndexOf('/') + 1));
  await FileSystem.moveAsync({ from: abs, to: dest });
}

function assertVaultRel(rel: string): void {
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('path is outside the vault');
  const top = rel.split('/')[0]?.toLowerCase();
  if (top === 'inbox' || top === 'daily' || top === 'assets') throw new Error('that folder is managed by the app');
}

/** Trash a single vault note (recoverable in Settings › Trash). */
export async function trashNoteFile(rel: string): Promise<void> {
  assertVaultRel(rel);
  await trashMove(`${VAULT}${rel}`, rel);
}

/** Trash a whole vault folder with everything in it (recoverable). */
export async function trashDir(dirRel: string): Promise<void> {
  assertVaultRel(dirRel);
  await trashMove(`${VAULT}${dirRel}`, dirRel);
}

/** Rename a vault note. `newName` is the bare filename (`Meeting` or `Meeting.md`). Returns the new rel. */
export async function renameNoteFile(oldRel: string, newName: string): Promise<string> {
  assertVaultRel(oldRel);
  const clean = ensureMd(cleanName(newName, 'File'));
  const slash = oldRel.lastIndexOf('/');
  const dir = slash >= 0 ? oldRel.slice(0, slash) : '';
  const next = dir ? `${dir}/${clean}` : clean;
  if (next === oldRel) return oldRel;
  if ((await FileSystem.getInfoAsync(`${VAULT}${next}`)).exists) throw new Error(`“${clean}” already exists`);
  const info = await FileSystem.getInfoAsync(`${VAULT}${oldRel}`);
  if (!info.exists || info.isDirectory) throw new Error('note not found');
  await FileSystem.moveAsync({ from: `${VAULT}${oldRel}`, to: `${VAULT}${next}` });
  recordMoves([{ from: oldRel, to: next }]);
  try {
    await relinkVault(oldRel, next);
  } catch {
    // the rename itself happened; links are best-effort (same as the Mac)
  }
  return next;
}

/**
 * Point other notes' `[[wikilinks]]` and relative markdown links at a renamed
 * note (same rewrite as the Mac's rename). Returns the notes it changed.
 */
export async function relinkVault(oldRel: string, newRel: string): Promise<string[]> {
  const files = await listVaultFiles();
  const all = new Set(files);
  const notes: Array<{ path: string; text: string }> = [];
  await mapLimit(
    files.filter((p) => p.toLowerCase().endsWith('.md')),
    8,
    async (p) => {
      try {
        notes.push({ path: p, text: await readText(`${VAULT}${p}`) });
      } catch {
        // unreadable — leave it
      }
    }
  );
  const changed = relinkAfterRename(notes, oldRel, newRel, (rel) => all.has(rel));
  for (const n of changed) await writeText(`${VAULT}${n.path}`, n.text);
  return changed.map((n) => n.path);
}

/** Rename a vault folder. Returns the new rel. */
export async function renameDir(oldRel: string, newName: string): Promise<string> {
  assertVaultRel(oldRel);
  const clean = cleanName(newName, 'Folder');
  const slash = oldRel.lastIndexOf('/');
  const parent = slash >= 0 ? oldRel.slice(0, slash) : '';
  const next = parent ? `${parent}/${clean}` : clean;
  if (!parent && RESERVED.has(clean.toLowerCase())) throw new Error(`“${clean}” is reserved`);
  if (next === oldRel) return oldRel;
  if ((await FileSystem.getInfoAsync(`${VAULT}${next}`)).exists) throw new Error(`“${clean}” already exists`);
  const info = await FileSystem.getInfoAsync(`${VAULT}${oldRel}`);
  if (!info.exists || !info.isDirectory) throw new Error('folder not found');
  await FileSystem.moveAsync({ from: `${VAULT}${oldRel}`, to: `${VAULT}${next}` });
  return next;
}

/** Create a note with a chosen filename. Returns the note id (for openNote). */
export async function createNamedNoteFile(dirRel: string, name: string): Promise<string> {
  await ensureTree();
  const clean = ensureMd(cleanName(name, 'File'));
  const resolved = await resolveDirRel(dirRel);
  if (resolved.split('/').includes('..')) throw new Error('folder is outside the vault');
  await mkdir(`${VAULT}${resolved ? `${resolved}/` : ''}`);
  const dot = clean.lastIndexOf('.');
  const base = dot > 0 ? clean.slice(0, dot) : clean;
  let file = clean;
  let i = 1;
  while ((await FileSystem.getInfoAsync(`${VAULT}${resolved ? `${resolved}/` : ''}${file}`)).exists) {
    i++;
    file = `${base} ${i}.md`;
  }
  const rel = resolved ? `${resolved}/${file}` : file;
  const noteId = newId('n');
  const fm = stringifyFrontmatter({ id: noteId, created: new Date().toISOString(), source: 'android' });
  await writeText(`${VAULT}${rel}`, `${fm}\n`);
  return noteId;
}

export async function createNoteFile(dirRel: string): Promise<string> {
  await ensureTree();
  const resolved = await resolveDirRel(dirRel);
  if (resolved.split('/').includes('..')) throw new Error('folder is outside the vault');
  await mkdir(`${VAULT}${resolved ? `${resolved}/` : ''}`);
  let name = 'Untitled.md';
  let i = 1;
  while ((await FileSystem.getInfoAsync(`${VAULT}${resolved ? `${resolved}/` : ''}${name}`)).exists) {
    i++;
    name = `Untitled ${i}.md`;
  }
  const rel = resolved ? `${resolved}/${name}` : name;
  await writeText(`${VAULT}${rel}`, '');
  return rel;
}

// --- daily ---

/** Local calendar day — matches Mac `localDay` (UTC filed mornings under yesterday). */
function todayName(d = new Date()): string {
  return localDay(d);
}

/** Append a compact `- HH:MM text` line to today's note (same shape as Mac — see shared/daily). */
export async function appendDaily(raw: string, kind: NoteKind = 'text'): Promise<string> {
  await ensureTree();
  const text = raw.trim();
  if (!text) throw new Error('daily note is empty');
  const now = new Date();
  const rel = `daily/${todayName(now)}.md`;
  const uri = `${DAILY}${todayName(now)}.md`;
  const entry = formatEntry(text, kind, now);
  const exists = (await FileSystem.getInfoAsync(uri)).exists;
  if (!exists) {
    const fm = stringifyFrontmatter({
      kind: 'daily',
      created: now.toISOString(),
      source: 'android'
    });
    await writeText(uri, `${fm}${entry}\n`);
  } else {
    await writeText(uri, appendToDailyFile(await readText(uri), entry));
  }
  return rel;
}

// --- journal: every daily note, summarized once per change ---------------------------
// Daily notes live in staging (`staging/daily/YYYY-MM-DD.md`, one flat folder), not the vault.
// The Journal + Home Daily section draw from these summaries, which ride in the saved index
// snapshot, so they show instantly at launch; the refresh lists that one folder (a stat per
// file) and only re-reads days whose size/mtime changed. Full bodies are read per visible page.

/** Index row for one daily note: enough to draw a card / timeline row without reading it. */
export interface DayInfo {
  /** Path id (daily notes have no front matter id), opens in the editor. */
  id: string;
  path: string;
  day: string;
  size: number;
  updatedAt: number;
  /** Timestamped entries in the note. */
  count: number;
  /** First few entries (plain text), file order. */
  entries: DailyEntry[];
  /** Plain text of the day for filtering + free-text previews (capped). */
  snippet: string;
}

const DAY_PREVIEW = 4;
const DAY_TEXT_CAP = 400;
const dayCache = new Map<string, DayInfo>();
let daysTask: Promise<DayInfo[]> | null = null;

/** Summarize one day file's text (front matter dropped). Pure apart from the parse. */
export function dayInfoFromText(rel: string, text: string, stat: { size: number; mtime: number }): DayInfo | null {
  const day = dayOfPath(rel);
  if (!day) return null;
  const all = summarizeDay(splitDailyFile(text).body, 1000);
  const entries = all.entries.slice(0, DAY_PREVIEW);
  const snippet = (all.entries.length ? all.entries.map((e) => e.text).join(' · ') : all.text).slice(0, DAY_TEXT_CAP);
  return { id: rel, path: rel, day, size: stat.size, updatedAt: stat.mtime, count: all.count, entries, snippet };
}

/** Every daily note, newest day first. Concurrent callers share one pass. */
export function listDays(): Promise<DayInfo[]> {
  if (daysTask) return daysTask;
  const task = (async () => {
    let names: string[];
    try {
      names = (await FileSystem.readDirectoryAsync(DAILY)).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
    } catch {
      names = [];
    }
    const rows = await mapLimit(names, 8, async (name): Promise<DayInfo | null> => {
      const rel = `daily/${name}`;
      const uri = `${DAILY}${name}`;
      try {
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory) return null;
        const size = info.size ?? 0;
        const mtime = info.modificationTime ? info.modificationTime * 1000 : Date.now();
        const hit = dayCache.get(rel);
        if (hit && hit.size === size && hit.updatedAt === mtime) return hit;
        const row = dayInfoFromText(rel, await readText(uri), { size, mtime });
        if (row) dayCache.set(rel, row);
        return row;
      } catch {
        return null;
      }
    });
    const present = new Set(names.map((n) => `daily/${n}`));
    for (const k of dayCache.keys()) if (!present.has(k)) dayCache.delete(k);
    return rows.filter((r): r is DayInfo => r !== null).sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  })();
  daysTask = task;
  task.finally(() => {
    if (daysTask === task) daysTask = null;
  }).catch(() => undefined);
  return task;
}

/** Summaries from the saved snapshot (no disk), newest first — what the first frame shows. */
export function cachedDays(): DayInfo[] {
  return [...dayCache.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** One day's body (front matter + old `# date` title dropped), '' when there's no note. */
export async function readDay(day: string): Promise<string> {
  const uri = `${DAILY}${day}.md`;
  try {
    return stripLegacyTitle(splitDailyFile(await readText(uri)).body);
  } catch {
    return '';
  }
}

export async function readDaily(d = new Date()): Promise<{ rel: string; body: string }> {
  await ensureTree();
  const rel = `daily/${todayName(d)}.md`;
  const uri = `${DAILY}${todayName(d)}.md`;
  if (!(await FileSystem.getInfoAsync(uri)).exists) return { rel, body: '' };
  const { parseFrontmatter } = await import('./format');
  const [, body] = parseFrontmatter(await readText(uri));
  // Older notes opened with a `# YYYY-MM-DD` heading that repeats the screen title.
  return { rel, body: stripLegacyTitle(body) };
}

// --- assets ---

export async function saveAssetCopy(fromUri: string, ext: string): Promise<string> {
  await ensureTree();
  const now = new Date();
  const dir = `${ASSETS}${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/`;
  await mkdir(dir);
  const name = `${newId('a')}${ext || '.bin'}`;
  await FileSystem.copyAsync({ from: fromUri, to: `${dir}${name}` });
  return `assets/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${name}`;
}
