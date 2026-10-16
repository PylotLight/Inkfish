/**
 * Note processing (Processed view + Process selection): the preset actions, how a note or a
 * selection becomes a prompt, and how the reply is checked before the user sees it.
 *
 * Pure and provider-agnostic: `processText` takes a `complete` function, which in the app is the
 * Prompt API (`LanguageModel`, see src/renderer/src/nativeAi.ts) and in tests is a mock.
 * Nothing here runs on its own; every call starts from an explicit user action.
 *
 * Guarantees:
 * - Front matter is never sent to the model and is re-attached byte-for-byte.
 * - Image refs (`![](assets/…)`) and link URLs must survive the "keep everything" actions
 *   (tidy, typos, checklist); if the model drops one the result is refused, not shown.
 *   Summarise / custom may legitimately drop them, so there they come back as warnings.
 */

export const AI_ACTIONS = ['tidy', 'typos', 'summarize', 'checklist', 'custom'] as const
export type AiAction = (typeof AI_ACTIONS)[number]

export interface AiActionInfo {
  id: AiAction
  label: string
  hint: string
  /** Every image ref and link in the input must be in the output. */
  strict: boolean
}

export const AI_ACTION_INFO: Record<AiAction, AiActionInfo> = {
  tidy: {
    id: 'tidy',
    label: 'Tidy formatting',
    hint: 'Headings, lists, checkboxes, spacing and typos. Same meaning, same words where possible.',
    strict: true
  },
  typos: { id: 'typos', label: 'Fix typos', hint: 'Spelling, grammar and punctuation only. Layout untouched.', strict: true },
  summarize: { id: 'summarize', label: 'Summarise', hint: 'A short markdown summary of the text.', strict: false },
  checklist: {
    id: 'checklist',
    label: 'Turn into checklist',
    hint: 'Action items as `- [ ]` tasks, keeping existing ticks.',
    strict: true
  },
  custom: { id: 'custom', label: 'Custom instruction…', hint: 'Your own instruction.', strict: false }
}

const BASE_RULES = [
  'You edit markdown notes for the Inkfish notes app.',
  'Reply with the resulting markdown only: no preamble, no explanation, no code fence around the whole reply.',
  'Keep every image reference like ![alt](assets/…) and every link URL exactly as written.',
  'Keep code blocks, inline code, tags (#tag) and [[wiki links]] unchanged.',
  'Keep the language and spelling variant of the original.'
].join('\n')

const ACTION_RULES: Record<Exclude<AiAction, 'custom'>, string> = {
  tidy: [
    'Tidy the formatting without changing the meaning:',
    '- consistent headings (#, ##) where the text already has sections; do not invent new content',
    '- consistent list markers (-), proper nesting, task lists as - [ ] / - [x] (keep existing ticks)',
    '- one blank line between blocks, no trailing spaces',
    '- fix obvious typos and punctuation',
    'Do not summarise, shorten, reorder or add facts.'
  ].join('\n'),
  typos: 'Fix spelling, grammar and punctuation only. Do not change formatting, structure, wording style or line breaks.',
  summarize: 'Write a concise markdown summary (a few bullets, or a short paragraph for short text). Keep names, dates and numbers exact.',
  checklist: [
    'Rewrite the text as a markdown checklist of action items (- [ ] item).',
    'Keep existing - [x] ticks. Keep non-action context as short plain lines above the list.',
    'Do not invent tasks.'
  ].join('\n')
}

export interface PromptPair {
  system: string
  user: string
}

/** The system + user prompt for one action on `text` (body only, never front matter). */
export function buildPrompt(action: AiAction, text: string, instruction = '', scope: 'note' | 'selection' = 'note'): PromptPair {
  const rules = action === 'custom' ? `Follow this instruction from the user:\n${instruction.trim() || 'Tidy the text.'}` : ACTION_RULES[action]
  const scopeLine =
    scope === 'selection'
      ? 'The input is a selection from a larger note; reply with the replacement for that selection only.'
      : 'The input is a whole note.'
  return { system: `${BASE_RULES}\n${scopeLine}\n\n${rules}`, user: text }
}

// --- front matter -------------------------------------------------------------------------

/** Split a leading YAML front matter block (`---\n…\n---\n`) off the body. */
export function splitFrontMatter(text: string): { frontMatter: string; body: string } {
  const m = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  if (!m) return { frontMatter: '', body: text }
  return { frontMatter: m[0], body: text.slice(m[0].length) }
}

// --- refs that must survive ------------------------------------------------------------------

/** Image refs (whole `![…](…)` token) and link URLs (`[…](url)`, bare http(s) URLs) in `text`. */
export function protectedRefs(text: string): { images: string[]; links: string[] } {
  const images = [...text.matchAll(/!\[[^\]\n]*\]\([^)\n]+\)/g)].map((m) => m[0])
  const withoutImages = text.replace(/!\[[^\]\n]*\]\([^)\n]+\)/g, ' ')
  const links = new Set<string>()
  for (const m of withoutImages.matchAll(/\[[^\]\n]*\]\(([^)\s\n]+)(?:\s+"[^"\n]*")?\)/g)) if (m[1]) links.add(m[1])
  for (const m of withoutImages.matchAll(/<?(https?:\/\/[^\s<>)\]]+)>?/g)) if (m[1]) links.add(m[1].replace(/[.,;:!?]+$/, ''))
  return { images: [...new Set(images)], links: [...links] }
}

/** Refs present in `input` but missing from `output`. Images match by their `(src)` part. */
export function missingRefs(input: string, output: string): string[] {
  const { images, links } = protectedRefs(input)
  const missing: string[] = []
  for (const img of images) {
    const src = /\]\(([^)]+)\)/.exec(img)?.[1] ?? img
    if (!output.includes(`(${src})`)) missing.push(img)
  }
  for (const url of links) if (!output.includes(url)) missing.push(url)
  return missing
}

// --- reply cleanup -------------------------------------------------------------------------

/** Strip a wrapping ``` fence or a "Here is…" preamble line some models add anyway. */
export function cleanReply(reply: string): string {
  let out = reply.replace(/\r\n/g, '\n').trim()
  const fence = /^```(?:markdown|md)?[ \t]*\n([\s\S]*?)\n```$/i.exec(out)
  if (fence) out = (fence[1] ?? '').trim()
  out = out.replace(/^(?:here(?:'s| is)[^\n]*:|sure[^\n]*:)\s*\n+/i, '')
  return out
}

/** Keep the input's leading/trailing whitespace shape (a selection's trailing newline, etc.). */
function keepEdges(input: string, out: string): string {
  const lead = /^\s*/.exec(input)?.[0] ?? ''
  const trail = /\s*$/.exec(input)?.[0] ?? ''
  return `${lead}${out}${trail}`
}

// --- the call -----------------------------------------------------------------------------

export type Complete = (prompt: PromptPair, onChunk?: (textSoFar: string) => void) => Promise<string>

export interface ProcessInput {
  action: AiAction
  text: string
  instruction?: string
  scope?: 'note' | 'selection'
  onChunk?: (textSoFar: string) => void
}

export interface ProcessResult {
  /** Full replacement text: for a note, front matter re-attached. */
  text: string
  /** Refs the model dropped on a non-strict action (shown to the user; they decide). */
  warnings: string[]
}

export class AiProcessError extends Error {
  constructor(
    message: string,
    readonly code: 'empty' | 'dropped-refs' | 'no-reply'
  ) {
    super(message)
    this.name = 'AiProcessError'
  }
}

/** Run one action. Throws `AiProcessError` when the reply can't be trusted. */
export async function processText(input: ProcessInput, complete: Complete): Promise<ProcessResult> {
  const scope = input.scope ?? 'note'
  const { frontMatter, body } = scope === 'note' ? splitFrontMatter(input.text) : { frontMatter: '', body: input.text }
  if (!body.trim()) throw new AiProcessError('Nothing to process: the note body is empty.', 'empty')
  const prompt = buildPrompt(input.action, body.trim(), input.instruction ?? '', scope)
  const reply = cleanReply(await complete(prompt, input.onChunk))
  if (!reply) throw new AiProcessError('The AI returned an empty reply.', 'no-reply')
  const missing = missingRefs(body, reply)
  if (missing.length && AI_ACTION_INFO[input.action].strict) {
    throw new AiProcessError(
      `Not applied: the AI dropped ${missing.length} image/link reference${missing.length > 1 ? 's' : ''} (${missing
        .slice(0, 3)
        .join(', ')}). Try again.`,
      'dropped-refs'
    )
  }
  const shaped = scope === 'selection' ? keepEdges(body, reply) : `${reply}\n`
  return { text: `${frontMatter}${shaped}`, warnings: missing }
}

// --- processed-view cache key --------------------------------------------------------------

/** FNV-1a 32-bit hex of `text`: the Processed view is stale when the raw note's hash changes. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** One cached Processed view, stored per note (src/main/ai-api.ts). */
export interface ProcessedEntry {
  noteId: string
  /** `contentHash` of the raw note it was made from. */
  rawHash: string
  action: AiAction
  instruction: string
  text: string
  warnings: string[]
  at: number
}

export function parseProcessedEntry(value: unknown): ProcessedEntry | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.noteId !== 'string' || typeof v.rawHash !== 'string' || typeof v.text !== 'string') return null
  return {
    noteId: v.noteId,
    rawHash: v.rawHash,
    action: AI_ACTIONS.includes(v.action as AiAction) ? (v.action as AiAction) : 'tidy',
    instruction: typeof v.instruction === 'string' ? v.instruction.slice(0, 2000) : '',
    text: v.text,
    warnings: Array.isArray(v.warnings) ? v.warnings.filter((w): w is string => typeof w === 'string') : [],
    at: typeof v.at === 'number' ? v.at : 0
  }
}
