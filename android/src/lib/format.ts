/**
 * Pure vault-format helpers — byte-compatible with the Mac app
 * (`src/main/vault.ts`, `src/main/ai.ts`). No RN / Expo imports here so the
 * file can be unit-tested with plain `tsc` + node.
 */

export type NoteKind = 'text' | 'voice' | 'image' | 'meeting';
export type NoteStatus = 'inbox' | 'processing' | 'ready' | 'archived';
export type NoteSource = 'tray' | 'popover' | 'meeting' | 'image' | 'import' | 'android';

export interface Project {
  id: string;
  name: string;
  /** Vault-relative dir, e.g. `work`. */
  dir: string;
}

export interface InboxItem {
  id: string;
  kind: NoteKind;
  raw: string;
  assets: string[];
  status: NoteStatus;
  projectHint?: string;
  createdAt: number;
}

export interface NoteEntry {
  id: string;
  /** Vault-relative path, e.g. `work/2026-10-07-slug.md` (staging: `inbox/<id>.md`). */
  path: string;
  title: string;
  kind: NoteKind;
  status: NoteStatus;
  projectId: string | null;
  inboxId: string | null;
  tags: string[];
  snippet: string;
  createdAt: number;
  updatedAt: number;
  size: number;
}

export interface NoteDoc extends NoteEntry {
  markdown: string;
}

export interface ClassifyResult {
  projectId: string;
  projectName: string;
  title: string;
  tags: string[];
  markdown: string;
  provider: string;
  confidence: number;
}

export function newId(prefix = ''): string {
  const rand = Math.random().toString(16).slice(2, 8);
  const stamp = new Date().toISOString().slice(0, 10);
  return prefix ? `${prefix}-${stamp}-${rand}` : `${stamp}-${rand}`;
}

export function slugify(s: string, max = 48): string {
  const slug =
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'untitled';
  return slug.slice(0, max).replace(/-+$/, '') || 'untitled';
}

export function slugToId(slug: string): string {
  return slugify(slug, 32);
}

// --- frontmatter (must stay identical to Mac `stringifyFrontmatter`) ---

function fmEscape(v: string): string {
  return v.includes(':') || v.includes('#') || v.includes('"')
    ? `"${v.replace(/"/g, '\\"')}"`
    : v;
}

export function stringifyFrontmatter(data: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}: [${v.map((x) => fmEscape(String(x))).join(', ')}]`);
    } else {
      lines.push(`${k}: ${fmEscape(String(v))}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function unquote(s: string): string {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

function parseList(s: string): string[] {
  s = s.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return s ? [unquote(s)] : [];
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  return inner.split(',').map((x) => unquote(x.trim()));
}

/** Minimal `---\nkey: value\n---\nbody` parser. Returns [data, body]. */
export function parseFrontmatter(md: string): [Record<string, string | string[]>, string] {
  if (!md.startsWith('---')) return [{}, md];
  const end = md.indexOf('\n---', 3);
  if (end === -1) return [{}, md];
  const data: Record<string, string | string[]> = {};
  for (const line of md.slice(3, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line.slice(i + 1).trim();
    if (!key) continue;
    data[key] = val.startsWith('[') ? parseList(val) : unquote(val);
  }
  return [data, md.slice(end + 4).replace(/^\n/, '')];
}

// --- titles / bodies (same rules as Mac `db.ts` + `ai.ts`) ---

export function titleFromBody(body: string): string {
  const h = /^#\s+(.+)$/m.exec(body);
  if (h?.[1]) return h[1].trim().slice(0, 120);
  return body.split('\n')[0]?.trim().slice(0, 120) || 'Untitled';
}

export function titleFromRaw(raw: string): string {
  const first =
    raw
      .split('\n')
      .map((l) => l.trim().replace(/^#+\s*/, ''))
      .find((l) => l.length > 0) ?? 'Untitled';
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return sentence.slice(0, 80).trim() || 'Untitled';
}

export function tagsFromRaw(raw: string, kind: NoteKind): string[] {
  const tags = new Set<string>();
  for (const m of raw.matchAll(/#([a-z0-9][a-z0-9-_]*)/gi)) {
    const t = m[1]?.toLowerCase();
    if (t) tags.add(t);
  }
  if (kind !== 'text') tags.add(kind);
  return [...tags].slice(0, 8);
}

export function formatBody(raw: string, kind: NoteKind): string {
  const text = raw.trim();
  if (kind === 'meeting') return text;
  return text
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => (/^\s*[*•]\s+/.test(l) ? l.replace(/^\s*[*•]\s+/, '- ') : l))
    .join('\n');
}

/** Rules router — identical scoring to Mac `rulesClassify` (no Apple LLM on Android). */
export function rulesClassify(
  raw: string,
  kind: NoteKind,
  projects: Project[],
  projectHint?: string
): ClassifyResult {
  const hint = projectHint && projectHint !== 'auto' ? projectHint : null;
  let project: Project | null = hint
    ? (projects.find((p) => p.id === hint || p.name === hint) ?? null)
    : null;
  let confidence = hint ? 1 : 0;
  if (!project) {
    const hay = raw.toLowerCase();
    let best = 0;
    for (const p of projects) {
      const name = p.name.toLowerCase();
      const words = name.split(/[^a-z0-9]+/).filter(Boolean);
      let score = 0;
      for (const w of words) {
        if (w.length < 3) continue;
        const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        score += (hay.match(re) ?? []).length * 2;
        if (hay.includes(w)) score += 0.5;
      }
      if (score > best) {
        best = score;
        project = p;
      }
    }
    confidence = best >= 2 ? 0.7 : best > 0 ? 0.45 : 0.25;
    project ??= projects[0] ?? { id: 'general', name: 'general', dir: 'general' };
  }
  return {
    projectId: project.id,
    projectName: project.name,
    title: titleFromRaw(raw),
    tags: tagsFromRaw(raw, kind),
    markdown: formatBody(raw, kind),
    provider: 'rules',
    confidence
  };
}

/** Folder-derived project for a vault-relative path (same rule as Mac `projectFromPath`). */
export function projectFromPath(vaultRel: string): string | null {
  const parts = vaultRel.split('/');
  if (parts[0] === 'projects' && parts[1]) return parts[1] ?? null;
  if (parts[0] === 'inbox' || parts[0] === 'daily') return null;
  return parts.length > 1 ? (parts[0] ?? null) : null;
}

/** Build a `NoteEntry` from raw file text + stat info (mirrors Mac `indexFile`). */
export function entryFromFile(
  vaultRel: string,
  text: string,
  stat: { size: number; mtime: number }
): NoteEntry {
  const [fm, body] = parseFrontmatter(text);
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const id = str(fm['id']) ?? vaultRel;
  const kind = (str(fm['kind']) as NoteKind | null) ?? 'text';
  const status =
    (str(fm['status']) as NoteStatus | null) ?? (vaultRel.startsWith('inbox/') ? 'inbox' : 'ready');
  const fromFm = str(fm['project']);
  const fromPath = projectFromPath(vaultRel);
  const projectId = fromFm ?? (fromPath ? slugToId(fromPath) : null);
  const inboxId = str(fm['inbox']);
  const tags = Array.isArray(fm['tags']) ? (fm['tags'] as string[]) : [];
  let createdAt = str(fm['created']) ? Date.parse(str(fm['created']) as string) : NaN;
  if (!Number.isFinite(createdAt)) createdAt = stat.mtime;
  const clean = body.replace(/^#\s+.*\n/, '').trim();
  return {
    id,
    path: vaultRel,
    title: titleFromBody(body),
    kind,
    status,
    projectId,
    inboxId,
    tags,
    snippet: clean.slice(0, 220),
    createdAt,
    updatedAt: stat.mtime,
    size: stat.size
  };
}

/** Build an `InboxItem` from a staging inbox file (mirrors Mac `readInboxItem`). */
export function inboxFromFile(id: string, text: string): InboxItem {
  const [fm, body] = parseFrontmatter(text);
  const created = typeof fm['created'] === 'string' ? Date.parse(fm['created']) : NaN;
  const assets = fm['assets'];
  return {
    id: String(fm['id'] ?? id),
    kind: (fm['kind'] as NoteKind) ?? 'text',
    raw: body.replace(/\s+$/, ''),
    assets: Array.isArray(assets) ? (assets as string[]) : [],
    status: (fm['status'] as NoteStatus) ?? 'inbox',
    projectHint: typeof fm['projectHint'] === 'string' ? fm['projectHint'] : 'auto',
    createdAt: Number.isFinite(created) ? (created as number) : 0
  };
}
