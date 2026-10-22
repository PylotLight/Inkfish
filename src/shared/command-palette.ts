/**
 * Command palette (⌘K) + note quick switcher (⌘O): command descriptors, fuzzy matching and the
 * ranked result list. Pure, so it is unit tested and runs in the renderer.
 *
 * Fuzzy matcher, accelerator labels and recents are ported from Surffish
 * (src/shared/command-palette.ts, PR #67); the sources are Inkfish's: commands and vault notes.
 */

export type PaletteMode = 'all' | 'notes' | 'commands'

export interface PaletteCommand {
  id: string
  title: string
  /** Extra words that find this command ("journal" finds "Open Today"). */
  keywords?: string[]
  /** Electron-style accelerator (`CmdOrCtrl+Shift+M`) shown as a hint, or null. */
  accelerator?: string | null
  section: string
  enabled?: boolean
}

export interface PaletteNote {
  id: string
  title: string
  /** Vault-relative path. */
  path: string
  tags?: string[]
  updatedAt: number
}

export type PaletteItem =
  | {
      kind: 'command'
      key: string
      title: string
      subtitle: string
      shortcut: string | null
      commandId: string
      score: number
    }
  | { kind: 'note'; key: string; title: string; subtitle: string; noteId: string; score: number }

export const MAX_RECENT = 20
const MAX_RESULTS = 50
const EMPTY_QUERY_NOTES = 8

// ---------------------------------------------------------------------------
// Shortcut labels

const MAC_KEY_SYMBOLS: Record<string, string> = {
  CmdOrCtrl: '⌘',
  CommandOrControl: '⌘',
  Cmd: '⌘',
  Command: '⌘',
  Super: '⌘',
  Meta: '⌘',
  Ctrl: '⌃',
  Control: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧'
}
const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘']
const KEY_NAMES: Record<string, string> = {
  Plus: '+',
  Minus: '-',
  Equal: '=',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Enter: '↩',
  Return: '↩',
  Escape: 'Esc',
  Esc: 'Esc',
  Backspace: '⌫',
  Delete: '⌦',
  Tab: '⇥',
  Space: 'Space'
}

/** `CmdOrCtrl+Shift+P` -> `⇧⌘P` on macOS, `Ctrl+Shift+P` elsewhere. */
export function formatAccelerator(accelerator: string | null | undefined, platform: string): string | null {
  if (!accelerator) return null
  const plusKey = accelerator.endsWith('++')
  const parts = (plusKey ? accelerator.slice(0, -2) : accelerator).split('+').filter(Boolean)
  const rawKey = plusKey ? '+' : (parts.pop() ?? '')
  const key = KEY_NAMES[rawKey] ?? (rawKey.length === 1 ? rawKey.toUpperCase() : rawKey)
  if (platform === 'darwin') {
    const modifiers = parts.map((part) => MAC_KEY_SYMBOLS[part] ?? part)
    modifiers.sort((a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b))
    return `${modifiers.join('')}${key}`
  }
  const names = parts.map((part) =>
    /^(CmdOrCtrl|CommandOrControl|Ctrl|Control)$/.test(part)
      ? 'Ctrl'
      : /^(Cmd|Command|Super|Meta)$/.test(part)
        ? 'Win'
        : part === 'Option'
          ? 'Alt'
          : part
  )
  return [...names, key].join('+')
}

// ---------------------------------------------------------------------------
// Fuzzy matching

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1]!
  return /[\s\-_./:()[\]]/.test(previous) || (/[a-z]/.test(previous) && /[A-Z]/.test(text[index]!))
}

/**
 * Subsequence match with bonuses for word starts and runs; null when `query` isn't a
 * subsequence of `text`. Higher is better. Case-insensitive.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const needle = query.toLocaleLowerCase()
  if (!needle) return 0
  const haystack = text.toLocaleLowerCase()
  if (!haystack) return null
  const direct = haystack.indexOf(needle)
  if (direct >= 0) {
    // Contiguous hit: prefer the very start, then a word start, then anywhere.
    const base = direct === 0 ? 100 : isWordStart(text, direct) ? 80 : 50
    return base + needle.length * 4 - Math.min(direct, 30) * 0.5 - haystack.length * 0.05
  }
  let score = 0
  let position = 0
  let run = 0
  for (const char of needle) {
    if (char === ' ') continue
    const index = haystack.indexOf(char, position)
    if (index < 0) return null
    const gap = index - position
    run = gap === 0 && position > 0 ? run + 1 : 0
    score += 2 + run * 3 + (isWordStart(text, index) ? 6 : 0) - Math.min(gap, 10) * 0.4
    position = index + 1
  }
  return score - haystack.length * 0.05
}

/** Every space-separated term must match one of the fields; the score sums the best field per term. */
export function matchFields(query: string, fields: readonly string[], weights: readonly number[] = []): number | null {
  const terms = query.trim().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return 0
  let total = 0
  for (const term of terms) {
    let best: number | null = null
    fields.forEach((field, index) => {
      const score = fuzzyScore(term, field)
      if (score === null) return
      const weighted = score * (weights[index] ?? 1)
      if (best === null || weighted > best) best = weighted
    })
    if (best === null) return null
    total += best
  }
  // Also reward the whole query matching the first field in one piece ("open today").
  const whole = terms.length > 1 ? fuzzyScore(query.trim(), fields[0] ?? '') : null
  return whole !== null && whole >= 50 ? total + whole : total
}

// ---------------------------------------------------------------------------
// Recents (command ids and note ids share one list, prefixed `cmd:` / `note:`)

export function recordRecent(recent: readonly string[], key: string, limit = MAX_RECENT): string[] {
  return [key, ...recent.filter((candidate) => candidate !== key)].slice(0, limit)
}

export function parseRecent(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const keys: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 300 || seen.has(item)) continue
    seen.add(item)
    keys.push(item)
    if (keys.length >= MAX_RECENT) break
  }
  return keys
}

// ---------------------------------------------------------------------------
// Query + results

/** `>` forces commands only (VS Code style); otherwise the mode the palette opened in. */
export function parsePaletteQuery(input: string, mode: PaletteMode): { query: string; mode: PaletteMode } {
  const trimmed = input.trimStart()
  if (trimmed.startsWith('>')) return { query: trimmed.slice(1).trim(), mode: 'commands' }
  return { query: input.trim(), mode }
}

function noteFolder(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash > 0 ? path.slice(0, slash) : ''
}

export interface PaletteSources {
  input: string
  mode: PaletteMode
  commands: readonly PaletteCommand[]
  notes: readonly PaletteNote[]
  recent: readonly string[]
  platform: string
}

/** Recent entries get this added per rank (most recent = full boost). */
const RECENT_BOOST = 40
/** A command beats a note on a tie (commands are the rarer, more deliberate pick). */
const COMMAND_WEIGHT = 1.1

export function rankPalette(sources: PaletteSources): PaletteItem[] {
  const { query, mode } = parsePaletteQuery(sources.input, sources.mode)
  const recentRank = new Map(sources.recent.map((key, index) => [key, index]))
  const boost = (key: string): number => {
    const rank = recentRank.get(key)
    return rank === undefined ? 0 : RECENT_BOOST * (1 - rank / MAX_RECENT)
  }
  const items: PaletteItem[] = []

  if (mode !== 'notes') {
    for (const command of sources.commands) {
      if (command.enabled === false) continue
      const score = matchFields(query, [command.title, command.section, ...(command.keywords ?? [])], [1, 0.4])
      if (score === null) continue
      // Empty query: only recent commands (plus everything in commands-only mode).
      if (!query && mode === 'all' && !recentRank.has(`cmd:${command.id}`)) continue
      items.push({
        kind: 'command',
        key: `cmd:${command.id}`,
        title: command.title,
        subtitle: command.section,
        shortcut: formatAccelerator(command.accelerator, sources.platform),
        commandId: command.id,
        score: score * COMMAND_WEIGHT + boost(`cmd:${command.id}`)
      })
    }
  }

  if (mode !== 'commands') {
    if (!query) {
      // Empty query: recently picked notes first, then the most recently edited.
      const byRecent = [...sources.notes].sort((a, b) => {
        const ra = recentRank.get(`note:${a.id}`) ?? Infinity
        const rb = recentRank.get(`note:${b.id}`) ?? Infinity
        return ra !== rb ? ra - rb : b.updatedAt - a.updatedAt
      })
      const limit = mode === 'notes' ? MAX_RESULTS : EMPTY_QUERY_NOTES
      byRecent.slice(0, limit).forEach((note, index) => {
        items.push({
          kind: 'note',
          key: `note:${note.id}`,
          title: note.title,
          subtitle: note.path,
          noteId: note.id,
          score: 30 - index * 0.01
        })
      })
    } else {
      for (const note of sources.notes) {
        const score = matchFields(
          query,
          [note.title, note.path, noteFolder(note.path), ...(note.tags ?? []).map((t) => `#${t}`)],
          [1, 0.7, 0.5, 0.6]
        )
        if (score === null) continue
        items.push({
          kind: 'note',
          key: `note:${note.id}`,
          title: note.title,
          subtitle: note.path,
          noteId: note.id,
          score: score + boost(`note:${note.id}`)
        })
      }
    }
  }

  // Stable: equal scores keep source order (commands as registered, notes by recency).
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
    .slice(0, MAX_RESULTS)
    .map(({ item }) => item)
}
