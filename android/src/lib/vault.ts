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

export async function ensureTree(): Promise<void> {
  for (const d of [VAULT, INBOX, DAILY, ASSETS, UNDONE]) await mkdir(d);
}

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
    const names = await FileSystem.readDirectoryAsync(dir);
    const out: string[] = [];
    for (const n of names) {
      if (n.startsWith('.')) continue;
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      if (info.exists && info.isDirectory) out.push(n);
    }
    return out.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function childFiles(dir: string): Promise<string[]> {
  try {
    const names = await FileSystem.readDirectoryAsync(dir);
    const out: string[] = [];
    for (const n of names) {
      if (n.startsWith('.') || !n.endsWith('.md')) continue;
      const info = await FileSystem.getInfoAsync(`${dir}${n}`);
      if (info.exists && !info.isDirectory) out.push(n);
    }
    return out.sort();
  } catch {
    return [];
  }
}

/** Recursive vault walk — every non-hidden `.md` (our notes + imported trees). */
async function walkVault(dir: string, relBase: string, out: string[]): Promise<void> {
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith('.')) continue;
    const abs = `${dir}${n}`;
    const rel = relBase ? `${relBase}/${n}` : n;
    const top = rel.split('/')[0];
    if (top === 'inbox' || top === 'daily') continue;
    const info = await FileSystem.getInfoAsync(abs);
    if (!info.exists) continue;
    if (info.isDirectory) await walkVault(`${abs}/`, rel, out);
    else if (n.endsWith('.md')) out.push(rel);
  }
}

// --- projects ---

const COLORS = ['#6ea8fe', '#7ee2a8', '#e5a56e', '#c79bfe', '#e5636f', '#6ed3e5'];

export async function listProjects(): Promise<Project[]> {
  await ensureTree();
  const dirs = await childDirs(VAULT);
  const seen = new Set<string>();
  const found: Project[] = [];
  for (const name of dirs) {
    if (RESERVED.has(name)) continue;
    const id = slugToId(name);
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ id, name, dir: name, color: COLORS[found.length % COLORS.length] } as Project & { color?: string } as Project);
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
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
  return listProjects();
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
  const items: InboxItem[] = [];
  for (const f of files) {
    try {
      items.push(inboxFromFile(f.replace(/\.md$/, ''), await readText(`${INBOX}${f}`)));
    } catch {
      // skip unreadable captures
    }
  }
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
  const rels: string[] = [];
  await walkVault(VAULT, '', rels);
  const out: NoteEntry[] = [];
  for (const rel of rels) {
    const e = await noteEntryForRel(rel);
    if (e) out.push(e);
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  if (projectId === 'inbox') return out.filter((e) => e.status === 'inbox' || e.status === 'processing');
  if (projectId) return out.filter((e) => e.projectId === projectId);
  return out;
}

export async function getNote(id: string): Promise<NoteDoc | null> {
  await ensureTree();
  // Ids are `inbox:` refs or file ids — scan (V1 has no index; files are truth).
  const rels: string[] = [];
  await walkVault(VAULT, '', rels);
  const inboxFiles = await childFiles(INBOX);
  for (const f of inboxFiles) rels.push(`inbox/${f}`);
  const dailyFiles = await childFiles(DAILY);
  for (const f of dailyFiles) rels.push(`daily/${f}`);
  for (const rel of rels) {
    const e = await noteEntryForRel(rel);
    if (e && e.id === id) {
      const abs = rel.startsWith('inbox/')
        ? `${INBOX}${rel.slice('inbox/'.length)}`
        : rel.startsWith('daily/')
          ? `${DAILY}${rel.slice('daily/'.length)}`
          : `${VAULT}${rel}`;
      const { parseFrontmatter } = await import('./format');
      const [, body] = parseFrontmatter(await readText(abs));
      return { ...e, markdown: body };
    }
  }
  return null;
}

export async function saveNote(id: string, markdown: string): Promise<NoteDoc | null> {
  const doc = await getNote(id);
  if (!doc) return null;
  const abs = doc.path.startsWith('inbox/')
    ? `${INBOX}${doc.path.slice('inbox/'.length)}`
    : doc.path.startsWith('daily/')
      ? `${DAILY}${doc.path.slice('daily/'.length)}`
      : `${VAULT}${doc.path}`;
  const { parseFrontmatter } = await import('./format');
  const [fm] = parseFrontmatter(await readText(abs));
  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm)) flat[k] = v;
  await writeText(abs, `${stringifyFrontmatter(flat)}${markdown.replace(/\s+$/, '')}\n`);
  return getNote(id);
}

export function searchNotesSync(entries: NoteEntry[], query: string): NoteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return entries
    .filter((e) => `${e.title}\n${e.snippet}\n${e.tags.join(' ')}`.toLowerCase().includes(q))
    .slice(0, 50);
}

// --- files: create note / trash ---

export async function createNoteFile(dirRel: string): Promise<string> {
  await ensureTree();
  if (dirRel.includes('..')) throw new Error('folder is outside the vault');
  await mkdir(`${VAULT}${dirRel ? `${dirRel}/` : ''}`);
  let name = 'Untitled.md';
  let i = 1;
  while ((await FileSystem.getInfoAsync(`${VAULT}${dirRel ? `${dirRel}/` : ''}${name}`)).exists) {
    i++;
    name = `Untitled ${i}.md`;
  }
  const rel = dirRel ? `${dirRel}/${name}` : name;
  await writeText(`${VAULT}${rel}`, '');
  return rel;
}

// --- daily ---

/** Local calendar day — matches Mac `localDay` (UTC filed mornings under yesterday). */
function todayName(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export async function appendDaily(raw: string, kind: NoteKind = 'text'): Promise<string> {
  await ensureTree();
  const text = raw.trim();
  if (!text) throw new Error('daily note is empty');
  const rel = `daily/${todayName()}.md`;
  const uri = `${DAILY}${todayName()}.md`;
  const stamp = new Date().toTimeString().slice(0, 5);
  const section = `## ${stamp}${kind !== 'text' ? ` · ${kind}` : ''}\n\n${text}\n\n`;
  const exists = (await FileSystem.getInfoAsync(uri)).exists;
  if (!exists) {
    const fm = stringifyFrontmatter({
      kind: 'daily',
      created: new Date().toISOString(),
      source: 'android'
    });
    await writeText(uri, `${fm}# ${todayName()}\n\n${section}`);
  } else {
    const prev = await readText(uri);
    await writeText(uri, `${prev.replace(/\s+$/, '')}\n\n${section}`);
  }
  return rel;
}

export async function readDaily(d = new Date()): Promise<{ rel: string; body: string }> {
  await ensureTree();
  const rel = `daily/${todayName(d)}.md`;
  const uri = `${DAILY}${todayName(d)}.md`;
  if (!(await FileSystem.getInfoAsync(uri)).exists) return { rel, body: '' };
  const { parseFrontmatter } = await import('./format');
  const [, body] = parseFrontmatter(await readText(uri));
  return { rel, body };
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
