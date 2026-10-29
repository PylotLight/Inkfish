/**
 * Capture router: picks a folder for an inbox capture (or a related note to append to) from what is
 * already in the vault, not from folder names. Pure and offline, shared by main (Mac) and Android.
 *
 * Inputs are the vault folders, light metadata for every note (kind + tags, for folder profiles and
 * the tag vocabulary) and the notes that matched the capture's key terms (main pulls them from the
 * FTS5 index, Android from its in-memory index). Nothing here knows any folder by name: no seeds, no
 * `general`, no `Meetings`. A capture the router isn't sure about stays in the inbox for review (or
 * goes to the default folder the user picked in Settings › Routing).
 */

/** Capture kind (same as `NoteKind` in ./types; kept local so Android can import this file). */
type NoteKind = 'text' | 'voice' | 'image' | 'meeting'

// --- prefs ---------------------------------------------------------------------------

export interface RoutingPrefs {
  /** On: confident captures are filed straight away. Off: suggest only, the capture waits in the inbox. */
  autoFile: boolean
  /** Folder for captures the router isn't sure about. '' = keep them in the inbox for review. */
  defaultFolder: string
  /** Add a capture to a closely related existing note instead of making a new one. */
  allowAppend: boolean
  /** 0..1 note similarity needed to append. */
  appendThreshold: number
  /** 0..1 folder confidence needed to file without asking. */
  minConfidence: number
  /** Allow daily notes and meeting notes as append targets (off by default). */
  appendToMeetings: boolean
  /** Folder live meetings are saved to. '' = not chosen yet. */
  meetingsFolder: string
  /** Ask the configured AI provider (Settings › AI provider) to pick between the candidates. */
  useAiProvider: boolean
}

export const DEFAULT_ROUTING_PREFS: RoutingPrefs = {
  autoFile: true,
  defaultFolder: '',
  allowAppend: true,
  appendThreshold: 0.7,
  minConfidence: 0.45,
  appendToMeetings: false,
  meetingsFolder: '',
  useAiProvider: true
}

const clamp01 = (n: unknown, d: number): number => {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : d
}

const cleanFolder = (v: unknown): string =>
  typeof v === 'string'
    ? v
        .replace(/\.\.+/g, '')
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .slice(0, 120)
    : ''

export function sanitizeRoutingPrefs(raw: unknown): RoutingPrefs {
  const p = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof RoutingPrefs, unknown>>
  const d = DEFAULT_ROUTING_PREFS
  const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def)
  return {
    autoFile: bool(p.autoFile, d.autoFile),
    defaultFolder: cleanFolder(p.defaultFolder),
    allowAppend: bool(p.allowAppend, d.allowAppend),
    appendThreshold: clamp01(p.appendThreshold, d.appendThreshold),
    minConfidence: clamp01(p.minConfidence, d.minConfidence),
    appendToMeetings: bool(p.appendToMeetings, d.appendToMeetings),
    meetingsFolder: cleanFolder(p.meetingsFolder),
    useAiProvider: bool(p.useAiProvider, d.useAiProvider)
  }
}

// --- text ----------------------------------------------------------------------------

/** Common English filler. Generic language only — nothing vault- or folder-specific. */
const STOPWORDS = new Set(
  (
    'the and for are but not you all any can had her was one our out day get has him his how man new now old see ' +
    'two way who boy did its let put say she too use that with have this will your from they know want been good ' +
    'much some time very when come here just like long make many more only over such take than them well were what ' +
    'about after again also because before being below between both could does doing down during each even every ' +
    'few further into itself might most must myself need off once other ought own same should since still then there ' +
    'these thing things those through under until upon which while whom whose why would yours yourself yourselves ' +
    'yeah yes okay maybe really actually basically gonna wanna kinda sorta think thought going got gotta stuff lot ' +
    'lots something anything nothing everything someone anyone today tomorrow yesterday week note notes quick idea ' +
    'remember remind todo please thanks thank just able where their theirs ours mine none via per etc'
  ).split(' ')
)

/** Light stem so `meetings`/`meeting`, `tomatoes`/`tomato` meet. Same on both sides of every comparison. */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`
  if (w.length > 5 && w.endsWith('oes')) return w.slice(0, -2)
  if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) return w.slice(0, -1)
  return w
}

/** Lowercased, stemmed content words (markdown, links, front matter, markers and numbers dropped). */
export function tokenize(text: string): string[] {
  const clean = text
    .replace(/^---\n[\s\S]*?\n---\n?/, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\]\([^)]*\)/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .toLowerCase()
  const out: string[] = []
  for (const m of clean.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu)) {
    for (const part of m[0].split(/[-_']/)) {
      if (part.length < 3 || /^\d+$/.test(part) || STOPWORDS.has(part)) continue
      out.push(stem(part))
    }
  }
  return out
}

/** The capture's most telling terms, most frequent (then longest) first. */
export function keyTerms(raw: string, max = 12): string[] {
  const tf = new Map<string, number>()
  for (const t of tokenize(raw)) tf.set(t, (tf.get(t) ?? 0) + 1)
  return [...tf.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t)
}

/** FTS5 MATCH string: any key term, prefix-matched (stems), quoted so user text can't inject syntax. */
export function ftsQuery(terms: readonly string[]): string {
  return terms
    .map((t) => t.replace(/"/g, ''))
    .filter(Boolean)
    .map((t) => `"${t}"*`)
    .join(' OR ')
}

// --- tags ----------------------------------------------------------------------------

const tagKey = (t: string): string =>
  stem(
    t
      .toLowerCase()
      .replace(/^#+/, '')
      .replace(/[\s_]+/g, '-')
      .trim()
  )

function editDistance(a: string, b: string, cap = 2): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[b.length] ?? cap + 1
}

/** Map a tag onto the vault's own spelling when one is close (case, plural, `-`/`_`/space, one typo). */
export function normalizeToVocab(tag: string, vocab: ReadonlyMap<string, number>): string {
  const clean = tag.trim().replace(/^#+/, '').replace(/\s+/g, '-')
  if (!clean) return ''
  const k = tagKey(clean)
  let best: string | null = null
  let bestN = -1
  for (const [v, n] of vocab) {
    const vk = tagKey(v)
    const close = vk === k || (k.length >= 5 && vk.length >= 5 && editDistance(vk, k, 1) <= 1)
    if (close && n > bestN) {
      best = v
      bestN = n
    }
  }
  return best ?? clean.toLowerCase()
}

/** Tag vocabulary: every tag used in the vault with its note count. */
export function tagVocab(notes: ReadonlyArray<{ tags: readonly string[] }>): Map<string, number> {
  const out = new Map<string, number>()
  for (const n of notes) for (const t of n.tags) if (t) out.set(t, (out.get(t) ?? 0) + 1)
  return out
}

/**
 * Tags for a capture: explicit `#tags`, existing vault tags the text mentions (whole word/phrase), and
 * any extra (AI) tags, all normalized onto the vault's spelling when close. The kind tags non-text.
 */
export function inferTags(
  raw: string,
  kind: NoteKind,
  vocab: ReadonlyMap<string, number>,
  extra: readonly string[] = []
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (t: string): void => {
    const n = normalizeToVocab(t, vocab)
    const k = tagKey(n)
    if (!n || seen.has(k)) return
    seen.add(k)
    out.push(n)
  }
  for (const m of raw.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu)) if (m[1]) add(m[1])
  const words = ` ${tokenize(raw).join(' ')} `
  for (const v of vocab.keys()) {
    const phrase = tokenize(v.replace(/[-_]/g, ' ')).join(' ')
    if (phrase && words.includes(` ${phrase} `)) add(v)
  }
  for (const t of extra) add(t)
  if (kind !== 'text') add(kind)
  return out.slice(0, 8)
}

// --- candidates ------------------------------------------------------------------------

export interface RouteFolder {
  /** Project id (slug), when the caller has one: the picker may send it. */
  id?: string
  name: string
  /** Vault-relative top-level dir. */
  dir: string
}

/** Metadata for one vault note (folder profiles + vocabulary). */
export interface RouteNoteMeta {
  path: string
  kind: string
  tags: readonly string[]
}

/** A note that matched the capture's terms (full text when available, else a snippet). */
export interface RouteDoc extends RouteNoteMeta {
  title: string
  body: string
}

export interface FolderProfile {
  dir: string
  notes: number
  /** Meeting transcripts and day logs: they shouldn't pull ordinary captures. */
  meetingish: number
  tags: Map<string, number>
}

const DAILY_NAME = /(^|\/)\d{4}-\d{2}-\d{2}\.md$/

/** Day logs and meeting transcripts: never append targets by default, weak folder evidence. */
export function isMeetingish(n: { path: string; kind: string }): boolean {
  return n.kind === 'meeting' || n.path.startsWith('daily/') || DAILY_NAME.test(n.path)
}

function topDir(path: string, folders: readonly RouteFolder[]): string | null {
  if (!path.includes('/')) return null
  const low = (path.split('/')[0] ?? '').toLowerCase()
  return folders.find((f) => f.dir.toLowerCase() === low)?.dir ?? null
}

export function profileFolders(
  notes: readonly RouteNoteMeta[],
  folders: readonly RouteFolder[]
): Map<string, FolderProfile> {
  const out = new Map<string, FolderProfile>()
  for (const f of folders) out.set(f.dir, { dir: f.dir, notes: 0, meetingish: 0, tags: new Map() })
  for (const n of notes) {
    const dir = topDir(n.path, folders)
    const p = dir ? out.get(dir) : undefined
    if (!p) continue
    p.notes++
    if (isMeetingish(n)) p.meetingish++
    for (const t of n.tags) p.tags.set(tagKey(t), (p.tags.get(tagKey(t)) ?? 0) + 1)
  }
  return out
}

// --- decision --------------------------------------------------------------------------

export type RouteAction = 'new' | 'append' | 'review'

export interface ScoredNote {
  path: string
  title: string
  folder: string | null
  score: number
  tags: string[]
  snippet: string
  /** Can take an appended capture (not a day log / meeting unless allowed). */
  appendable: boolean
}

export interface ScoredFolder {
  dir: string
  score: number
  why: string[]
}

export interface RouteDecision {
  action: RouteAction
  /** Top-level folder; null when left for review. */
  folder: string | null
  /** Append target (vault rel) when action is append. */
  target: string | null
  targetTitle: string | null
  tags: string[]
  confidence: number
  /** One line for the inbox: why it went there (or didn't). */
  reason: string
  provider: 'picker' | 'rules' | 'apple' | 'local' | 'api'
  folders: ScoredFolder[]
  notes: ScoredNote[]
}

export interface RouteInput {
  raw: string
  kind: NoteKind
  folders: readonly RouteFolder[]
  /** Every vault note's metadata (for profiles + tag vocabulary). */
  notes: readonly RouteNoteMeta[]
  /** Notes matching the capture's key terms (FTS hits). */
  docs: readonly RouteDoc[]
  /** Total notes in the vault (idf). Defaults to notes.length. */
  totalDocs?: number
  prefs: RoutingPrefs
  /** Explicit picker / Move choice (folder name or id). Always wins. */
  hint?: string | null
  /** Extra tags (from an AI model) folded into the tag inference. */
  extraTags?: readonly string[]
}

const pct = (n: number): string => `${Math.round(n * 100)}%`

function matchFolder(name: string, folders: readonly RouteFolder[]): RouteFolder | null {
  const n = name
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase()
  if (!n) return null
  return (
    folders.find((f) => f.dir.toLowerCase() === n || f.name.toLowerCase() === n || f.id?.toLowerCase() === n) ?? null
  )
}

/** Folder hint from the picker: an existing folder (any case) or a new name to create as typed. */
function hintFolder(hint: string, folders: readonly RouteFolder[]): string {
  return matchFolder(hint, folders)?.dir ?? hint.trim().replace(/^\/+|\/+$/g, '')
}

// --- explicit overrides (capture picker / route preview) ---------------------------------------

/** Hint that keeps the capture in the inbox (route preview › "Keep in inbox"). */
export const KEEP_IN_INBOX = '@inbox'
const APPEND_PREFIX = '@append:'

/** Hint that appends the capture to one existing note (vault rel). */
export const appendHint = (rel: string): string => `${APPEND_PREFIX}${rel}`

export type RouteHint =
  { kind: 'auto' } | { kind: 'inbox' } | { kind: 'append'; rel: string } | { kind: 'folder'; name: string }

/** Picker hint → what the user asked for: let the router decide, a folder, a note to append to, or the inbox. */
export function parseRouteHint(hint: string | null | undefined): RouteHint {
  const h = (hint ?? '').trim()
  if (!h || h === 'auto') return { kind: 'auto' }
  if (h === KEEP_IN_INBOX) return { kind: 'inbox' }
  if (h.startsWith(APPEND_PREFIX)) {
    const rel = h.slice(APPEND_PREFIX.length).trim()
    return rel ? { kind: 'append', rel } : { kind: 'auto' }
  }
  return { kind: 'folder', name: h }
}

const noteName = (rel: string): string => (rel.split('/').pop() ?? rel).replace(/\.md$/i, '')

/**
 * Score folders and notes against the capture and decide: append to a related note, new note in a
 * folder, or leave it for review. Deterministic and offline.
 */
export function decideRoute(input: RouteInput): RouteDecision {
  const { raw, kind, folders, prefs } = input
  const vocab = tagVocab(input.notes)
  const tags = inferTags(raw, kind, vocab, input.extraTags ?? [])
  const tagKeys = new Set(tags.map(tagKey))
  const terms = keyTerms(raw, 16)
  const capture = new Set(tokenize(raw))
  const profiles = profileFolders(input.notes, folders)
  const meetingCapture = kind === 'meeting'

  // idf from the hit set; N = vault size.
  const docTerms = input.docs.map((d) => new Set(tokenize(`${d.title}\n${d.body}\n${d.tags.join(' ')}`)))
  const N = Math.max(input.totalDocs ?? input.notes.length, input.docs.length, 1)
  const weight = new Map<string, number>()
  const unseen: string[] = []
  for (const t of terms) {
    const df = docTerms.reduce((n, s) => n + (s.has(t) ? 1 : 0), 0)
    if (df === 0) unseen.push(t)
    else weight.set(t, Math.log(1 + (N + 1) / (df + 0.5)))
  }
  // Words the vault has never seen say little about where a note belongs: they count, but lightly.
  const maxW = Math.max(0, ...weight.values()) || 1
  for (const t of unseen) weight.set(t, 0.35 * maxW)
  const totalW = [...weight.values()].reduce((a, b) => a + b, 0) || 1

  const notes: ScoredNote[] = input.docs.map((d, i) => {
    const s = docTerms[i] ?? new Set<string>()
    let w = 0
    let hits = 0
    for (const t of terms) {
      if (s.has(t)) {
        w += weight.get(t) ?? 0
        hits++
      }
    }
    const coverage = w / totalW
    const titleTerms = [...new Set(tokenize(d.title))]
    const titleHit = titleTerms.length ? titleTerms.filter((t) => capture.has(t)).length / titleTerms.length : 0
    const shared = d.tags.filter((t) => tagKeys.has(tagKey(t))).length
    const tagScore = tagKeys.size ? Math.min(1, shared / tagKeys.size) : 0
    let score = 0.7 * coverage + 0.2 * titleHit + 0.1 * tagScore
    // One shared word is a coincidence, not a relation.
    if (hits < 2 && titleHit < 1) score *= 0.6
    const meetingish = isMeetingish(d)
    if (meetingish && !meetingCapture) score *= 0.6
    return {
      path: d.path,
      title: d.title,
      folder: topDir(d.path, folders),
      score: Math.min(1, score),
      tags: [...d.tags],
      snippet: d.body.replace(/\s+/g, ' ').trim().slice(0, 160),
      appendable: !d.path.startsWith('inbox/') && (prefs.appendToMeetings || !meetingish)
    }
  })
  notes.sort((a, b) => b.score - a.score)

  const meetingsDir = prefs.meetingsFolder ? (matchFolder(prefs.meetingsFolder, folders)?.dir ?? null) : null
  const scored: ScoredFolder[] = folders.map((f) => {
    const why: string[] = []
    const sims = notes.filter((n) => n.folder === f.dir).map((n) => n.score)
    let score = 0
    if (sims.length) {
      const top3 = sims.slice(0, 3)
      score = 0.7 * (sims[0] ?? 0) + (0.3 * top3.reduce((a, b) => a + b, 0)) / top3.length
      why.push(`${sims.length} related note${sims.length === 1 ? '' : 's'}`)
    }
    const prof = profiles.get(f.dir)
    const sharedTags = [...tagKeys].filter((t) => (prof?.tags.get(t) ?? 0) > 0).length
    if (sharedTags) {
      score += Math.min(0.2, 0.1 * sharedTags)
      why.push(`${sharedTags} shared tag${sharedTags === 1 ? '' : 's'}`)
    }
    // The folder's own name in the text is evidence too (whole word, stemmed) — not a lookup table.
    const nameTerms = tokenize(f.name)
    if (nameTerms.length && nameTerms.every((t) => capture.has(t))) {
      score += 0.5
      why.push('named in text')
    }
    const mostlyMeetings = prof && prof.notes > 0 && prof.meetingish / prof.notes >= 0.6
    if (!meetingCapture && (mostlyMeetings || f.dir === meetingsDir)) {
      score *= 0.5
      why.push('meeting folder')
    }
    return { dir: f.dir, score: Math.min(1, score), why }
  })
  scored.sort((a, b) => b.score - a.score || a.dir.localeCompare(b.dir))

  const base = { tags, folders: scored, notes: notes.slice(0, 8) }

  // 1. Explicit picker / Move / preview choice: always wins.
  const choice = parseRouteHint(input.hint)
  if (choice.kind === 'inbox') {
    return {
      ...base,
      action: 'review',
      folder: null,
      target: null,
      targetTitle: null,
      confidence: 1,
      reason: 'kept in inbox',
      provider: 'picker'
    }
  }
  if (choice.kind === 'append') {
    const meta = input.notes.find((n) => n.path === choice.rel)
    if (meta) {
      const title = input.docs.find((d) => d.path === choice.rel)?.title || noteName(choice.rel)
      return {
        ...base,
        action: 'append',
        folder: topDir(choice.rel, folders),
        target: choice.rel,
        targetTitle: title,
        confidence: 1,
        reason: `picked: add to "${title}"`,
        provider: 'picker'
      }
    }
    // The note is gone: a new note next to where it was, when that folder still exists.
  }
  const hint = choice.kind === 'folder' ? choice.name : choice.kind === 'append' ? topDir(choice.rel, folders) : null
  if (hint) {
    const dir = hintFolder(hint, folders)
    return {
      ...base,
      action: 'new',
      folder: dir,
      target: null,
      targetTitle: null,
      confidence: 1,
      reason: `picked ${dir}`,
      provider: 'picker'
    }
  }

  // 2. Meetings: their own folder when the user chose one.
  if (meetingCapture && meetingsDir) {
    return {
      ...base,
      action: 'new',
      folder: meetingsDir,
      target: null,
      targetTitle: null,
      confidence: 0.9,
      reason: `meeting → ${meetingsDir}`,
      provider: 'rules'
    }
  }

  // 3. Append to a closely related note.
  const best = notes.find((n) => n.appendable)
  const canAppend = prefs.allowAppend && (kind === 'text' || kind === 'voice')
  if (canAppend && best && best.score >= prefs.appendThreshold) {
    return {
      ...base,
      action: 'append',
      folder: best.folder,
      target: best.path,
      targetTitle: best.title,
      confidence: best.score,
      reason: `added to "${best.title}" (${pct(best.score)} match)`,
      provider: 'rules'
    }
  }

  // 4. New note in the best folder, if it clearly stands out.
  const s1 = scored[0]?.score ?? 0
  const s2 = scored[1]?.score ?? 0
  const confidence = s1 > 0 ? s1 * (0.7 + (0.3 * (s1 - s2)) / s1) : 0
  if (scored[0] && confidence >= prefs.minConfidence) {
    const top = scored[0]
    return {
      ...base,
      action: 'new',
      folder: top.dir,
      target: null,
      targetTitle: null,
      confidence,
      reason: `${top.dir}: ${top.why.join(', ') || 'best match'} (${pct(confidence)})`,
      provider: 'rules'
    }
  }

  // 5. Not sure: the user's default folder, else the inbox.
  const why = folders.length === 0 ? 'no folders yet' : s1 > 0 ? `not sure (${pct(confidence)})` : 'nothing related'
  if (prefs.defaultFolder) {
    const dir = hintFolder(prefs.defaultFolder, folders)
    return {
      ...base,
      action: 'new',
      folder: dir,
      target: null,
      targetTitle: null,
      confidence,
      reason: `${why} → default folder ${dir}`,
      provider: 'rules'
    }
  }
  return {
    ...base,
    action: 'review',
    folder: null,
    target: null,
    targetTitle: null,
    confidence,
    reason: `${why}, left in inbox`,
    provider: 'rules'
  }
}

// --- AI layer ------------------------------------------------------------------------------

export interface AiRouteAnswer {
  action: 'new' | 'append'
  folder: string
  targetNote: string | null
  title: string
  tags: string[]
  confidence: number
}

/** Folders + notes offered to a model: the top scored ones first, then the rest (capped). */
export function aiCandidates(
  d: RouteDecision,
  folders: readonly RouteFolder[],
  maxFolders = 8,
  maxNotes = 5
): { folders: string[]; notes: ScoredNote[] } {
  const order = [...d.folders.map((f) => f.dir), ...folders.map((f) => f.dir)]
  return {
    folders: [...new Set(order)].slice(0, maxFolders),
    notes: d.notes.filter((n) => n.appendable && n.score > 0).slice(0, maxNotes)
  }
}

/** A related note offered to the user as a one-click routing choice. */
export interface RouteCandidate {
  /** Vault rel of the note. */
  rel: string
  title: string
  /** Rules score, 0..1. */
  score: number
}

/** Top related notes worth offering (appendable, non-trivial score) — the same bar the AI gets. */
export function routeCandidates(d: RouteDecision, n = 3): RouteCandidate[] {
  return d.notes
    .filter((x) => x.appendable && x.score > 0)
    .slice(0, n)
    .map((x) => ({ rel: x.path, title: x.title, score: x.score }))
}

/** System + user prompt asking for one JSON object, constrained to the candidates. */
export function aiRoutePrompt(
  raw: string,
  cand: { folders: string[]; notes: ScoredNote[] },
  allowAppend: boolean
): { system: string; user: string } {
  const system =
    'You file a quick note into a personal notes vault. Reply with one JSON object only, no prose: ' +
    '{"action":"new"|"append","folder":string,"targetNote":string|null,"title":string,"tags":string[],"confidence":number}. ' +
    '"folder" must be exactly one of the listed folders, or the empty string to propose a new note in the vault root when no listed folder fits. ' +
    (allowAppend
      ? '"append" only when the note clearly continues one listed existing note; then "targetNote" is that note\'s exact path. '
      : 'Always use "new". ') +
    'If no existing note or folder is a good fit, use action "new" and folder "" rather than forcing an unrelated match. Prefer existing tags. Title: short, plain, max 8 words.'
  const notes = cand.notes.length
    ? cand.notes
        .map((n) => `- path: ${n.path}\n  title: ${n.title}\n  tags: ${n.tags.join(', ')}\n  snippet: ${n.snippet}`)
        .join('\n')
    : '(none)'
  const user =
    `Folders:\n${cand.folders.map((f) => `- ${f}`).join('\n') || '(none)'}\n\n` +
    `Existing notes:\n${notes}\n\nNote to file:\n"""\n${raw.slice(0, 4000)}\n"""`
  return { system, user }
}

/** Parse the model's JSON; anything outside the candidates (exact match only) is dropped → null. */
export function parseAiRoute(text: string, cand: { folders: string[]; notes: ScoredNote[] }): AiRouteAnswer | null {
  const m = /\{[\s\S]*\}/.exec(text)
  if (!m) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(m[0]) as Record<string, unknown>
  } catch {
    return null
  }
  const wanted = typeof j.folder === 'string' ? j.folder.trim() : ''
  const folder = wanted ? cand.folders.find((f) => f === wanted) : undefined
  if (wanted && !folder) return null
  let action: 'new' | 'append' = j.action === 'append' ? 'append' : 'new'
  let targetNote: string | null = null
  if (action === 'append') {
    const t = typeof j.targetNote === 'string' ? j.targetNote.trim() : ''
    targetNote = cand.notes.find((n) => n.path === t)?.path ?? null
    if (!targetNote) action = 'new'
  }
  if (!folder && !targetNote && action !== 'new') return null
  const conf = typeof j.confidence === 'number' ? j.confidence : Number(j.confidence)
  return {
    action,
    folder: folder ?? cand.notes.find((n) => n.path === targetNote)?.folder ?? '',
    targetNote,
    title: typeof j.title === 'string' ? j.title.trim().slice(0, 80) : '',
    tags: Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [],
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5
  }
}

/** Fold an AI answer into the rules decision (picker / meetings-folder decisions are never overridden). */
export function applyAiRoute(
  rules: RouteDecision,
  ai: AiRouteAnswer,
  provider: 'apple' | 'local' | 'api',
  prefs: RoutingPrefs,
  vocab: ReadonlyMap<string, number>
): RouteDecision {
  if (rules.provider === 'picker' || rules.reason.startsWith('meeting →')) return rules
  const tags = [...rules.tags]
  const seen = new Set(tags.map(tagKey))
  for (const t of ai.tags) {
    const n = normalizeToVocab(t, vocab)
    if (n && !seen.has(tagKey(n))) {
      seen.add(tagKey(n))
      tags.push(n)
    }
  }
  const out = { ...rules, tags: tags.slice(0, 8), provider }
  const who = provider === 'apple' ? 'Apple Intelligence' : provider === 'local' ? 'Local model' : 'AI'
  if (ai.action === 'new' && !ai.folder) {
    if (rules.reason.includes('default folder ')) return out
    return {
      ...out,
      action: 'new',
      folder: '',
      target: null,
      targetTitle: null,
      confidence: ai.confidence,
      reason: `${who}: propose a new note at the vault root (${pct(ai.confidence)})`
    }
  }
  if (ai.action === 'append' && ai.targetNote && prefs.allowAppend && ai.confidence >= prefs.appendThreshold) {
    const n = rules.notes.find((x) => x.path === ai.targetNote)
    return {
      ...out,
      action: 'append',
      folder: n?.folder ?? (ai.folder || null),
      target: ai.targetNote,
      targetTitle: n?.title ?? ai.targetNote,
      confidence: ai.confidence,
      reason: `${who}: added to "${n?.title ?? ai.targetNote}" (${pct(ai.confidence)})`
    }
  }
  if (ai.folder && ai.confidence >= prefs.minConfidence) {
    return {
      ...out,
      action: 'new',
      folder: ai.folder,
      target: null,
      targetTitle: null,
      confidence: ai.confidence,
      reason: `${who}: ${ai.folder} (${pct(ai.confidence)})`
    }
  }
  // Model unsure too: keep the rules call (review / default folder / rules folder).
  return out
}

/** The router's result as recorded on the raw inbox capture. */
export interface InboxRoute {
  action: RouteAction
  folder: string
  /** Vault rel of the written/proposed note or append target; '' only when kept for review. */
  rel: string
  reason: string
  confidence: number
  provider: string
  /** True when awaiting approval (auto-file off or a root-level proposal), not filed. */
  suggested: boolean
  /** Proposed note title, tags and content, retained so File applies this exact suggestion. */
  title?: string
  tags?: string[]
  markdown?: string
  /** Top related notes the user can re-route the capture into with one click. */
  candidates?: RouteCandidate[]
}

/** Short inbox label for a route result: where it went (or would go) and how. */
export function routeSummary(route: InboxRoute | undefined, status: string): string {
  if (!route) return ''
  if (route.action === 'review') return 'needs review'
  const name = (rel: string): string => (rel.split('/').pop() ?? rel).replace(/\.md$/i, '')
  const suggested = route.suggested && status !== 'ready'
  const where =
    route.action === 'append'
      ? `${suggested ? 'add' : 'added'} to ${name(route.rel) || route.folder}`
      : suggested
        ? route.title || route.rel
          ? `new note ${route.title ? `"${route.title}"` : name(route.rel)}${route.rel ? ` at ${route.rel}` : ''}`
          : `new note in ${route.folder || 'vault root'}`
        : `new note in ${route.folder || name(route.rel)}`
  return suggested ? `suggested: ${where}` : where
}

/**
 * Folder a new live meeting is saved to: the user's setting, else their earlier pick (legacy
 * localStorage), else wherever most of their existing meeting notes already live, else the vault
 * root (''). No folder name is invented.
 */
export function pickMeetingsFolder(pref: string, legacy: string | null, meetingPaths: readonly string[]): string {
  if (pref.trim()) return pref.trim()
  if (legacy?.trim()) return legacy.trim()
  const count = new Map<string, number>()
  for (const p of meetingPaths) {
    const dir = p.split('/').slice(0, -1).join('/')
    if (dir) count.set(dir, (count.get(dir) ?? 0) + 1)
  }
  let best = ''
  let n = 0
  for (const [d, c] of count) {
    if (c > n || (c === n && d.localeCompare(best) < 0)) {
      best = d
      n = c
    }
  }
  return best
}

// --- live preview (capture popover) ----------------------------------------------------------

/** Where a capture would go if saved now: the rules router's call on the same inputs as filing. */
export interface RoutePreview {
  action: 'new' | 'append' | 'inbox'
  /** Folder of the new note / append target ('' = vault root or none). */
  folder: string
  /** Append target (vault rel + title); null otherwise. */
  target: { rel: string; title: string } | null
  tags: string[]
  confidence: number
  reason: string
  /** The capture's hint decided it (picker / preview override). */
  override: boolean
  /** Settings › Routing auto-file is off: it would only be suggested, the capture waits in the inbox. */
  suggested: boolean
  /** An AI model may still refine this at filing time (provider / embedded intelligence). */
  aiMayRefine: boolean
  /** Quick switches for the preview menu. */
  alt: {
    /** "New note instead": the folder a new note would go to (when the call is append / inbox). */
    folder: string | null
    /** "Add to … instead": the best appendable note (when the call isn't an append). */
    append: { rel: string; title: string } | null
  }
  /** Top related notes, for the menu's "Add to … instead" choices. */
  candidates: RouteCandidate[]
}

/** Fold a rules decision into the preview the capture shows. */
export function toRoutePreview(d: RouteDecision, opts: { autoFile: boolean; aiMayRefine: boolean }): RoutePreview {
  const override = d.provider === 'picker'
  const action = d.action === 'review' ? 'inbox' : d.action
  const best = d.notes.find((n) => n.appendable && n.score > 0)
  const topFolder = d.folders.find((f) => f.score > 0)?.dir ?? null
  return {
    action,
    folder: d.folder ?? '',
    target: d.action === 'append' && d.target ? { rel: d.target, title: d.targetTitle ?? noteName(d.target) } : null,
    tags: [...d.tags],
    confidence: d.confidence,
    reason: d.reason,
    override,
    suggested: !opts.autoFile && action !== 'inbox',
    aiMayRefine: opts.aiMayRefine && !override && !d.reason.startsWith('meeting →'),
    alt: {
      folder: action === 'new' ? null : (d.folder ?? topFolder),
      append: action === 'append' || !best ? null : { rel: best.path, title: best.title }
    },
    candidates: routeCandidates(d)
  }
}

/** One compact line: "→ Garden · new note · 72%", "→ add to Tomato log · 81%", "→ inbox (not sure)". */
export function previewLabel(p: RoutePreview): string {
  const pre = p.suggested ? 'suggested ' : ''
  const conf = p.override ? '' : ` · ${pct(p.confidence)}`
  if (p.action === 'inbox') return p.override ? '→ keep in inbox' : '→ inbox (not sure)'
  if (p.action === 'append') return `${pre}→ add to ${p.target?.title ?? 'note'}${conf}`
  return `${pre}→ ${p.folder || 'vault root'} · new note${conf}`
}

/** Compact key for "where it went" (preview vs. filed): `new:Garden`, `append:Garden/Tomato log.md`, `review:`. */
export function routeKey(r: { action: string; folder: string; rel?: string }): string {
  if (r.action === 'append') return `append:${r.rel ?? ''}`
  if (r.action === 'review' || r.action === 'inbox') return 'review:'
  return `new:${r.folder}`
}

/** Human form of a routeKey, for "preview said …". */
export function routeKeyLabel(key: string): string {
  const i = key.indexOf(':')
  const action = i === -1 ? key : key.slice(0, i)
  const rest = i === -1 ? '' : key.slice(i + 1)
  if (action === 'append') return `add to ${noteName(rest)}`
  if (action === 'review') return 'inbox'
  return `new note in ${rest || 'vault root'}`
}
