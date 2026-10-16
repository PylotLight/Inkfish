import { describe, expect, test } from 'bun:test'
import {
  AiProcessError,
  buildPrompt,
  cleanReply,
  contentHash,
  missingRefs,
  parseProcessedEntry,
  processText,
  protectedRefs,
  splitFrontMatter,
  type Complete,
  type PromptPair
} from './ai-process'

const NOTE = `---
title: Standup
tags: [work]
---
# standup
* ship settings page   thursday
* ask sam  about icons
![](assets/board.png)
see [the doc](https://example.com/doc?id=1) and https://inkfish.dev/x.
`

/** Mock provider: records the prompt and returns `reply` (or a function of the user text). */
function mock(reply: string | ((user: string) => string)): { complete: Complete; calls: PromptPair[] } {
  const calls: PromptPair[] = []
  const complete: Complete = async (prompt, onChunk) => {
    calls.push(prompt)
    const out = typeof reply === 'string' ? reply : reply(prompt.user)
    onChunk?.(out.slice(0, 5))
    onChunk?.(out)
    return out
  }
  return { complete, calls }
}

describe('front matter', () => {
  test('splits a leading YAML block', () => {
    const { frontMatter, body } = splitFrontMatter(NOTE)
    expect(frontMatter).toBe('---\ntitle: Standup\ntags: [work]\n---\n')
    expect(body.startsWith('# standup')).toBe(true)
  })
  test('no front matter: body is the whole text', () => {
    expect(splitFrontMatter('# hi\n---\nx')).toEqual({ frontMatter: '', body: '# hi\n---\nx' })
  })
})

describe('protected refs', () => {
  test('finds images, markdown links and bare URLs', () => {
    const r = protectedRefs(NOTE)
    expect(r.images).toEqual(['![](assets/board.png)'])
    expect(r.links).toContain('https://example.com/doc?id=1')
    expect(r.links).toContain('https://inkfish.dev/x')
  })
  test('image alt text may change, src may not', () => {
    expect(missingRefs('![](assets/a.png)', '![a board](assets/a.png)')).toEqual([])
    expect(missingRefs('![](assets/a.png)', 'no image')).toEqual(['![](assets/a.png)'])
  })
})

describe('processText (mocked provider)', () => {
  const tidy = `# Standup

- Ship settings page Thursday
- Ask Sam about icons

![](assets/board.png)

See [the doc](https://example.com/doc?id=1) and https://inkfish.dev/x.`

  test('never sends front matter, re-attaches it byte-for-byte, keeps image refs', async () => {
    const m = mock(tidy)
    const chunks: string[] = []
    const r = await processText({ action: 'tidy', text: NOTE, onChunk: (c) => chunks.push(c) }, m.complete)
    expect(m.calls[0]?.user).not.toContain('title: Standup')
    expect(m.calls[0]?.system).toContain('Tidy the formatting')
    expect(r.text.startsWith('---\ntitle: Standup\ntags: [work]\n---\n# Standup')).toBe(true)
    expect(r.text).toContain('![](assets/board.png)')
    expect(r.text.endsWith('\n')).toBe(true)
    expect(r.warnings).toEqual([])
    expect(chunks.length).toBe(2)
  })

  test('strips a wrapping code fence the model added', async () => {
    const r = await processText({ action: 'tidy', text: NOTE }, mock('```markdown\n' + tidy + '\n```').complete)
    expect(r.text).not.toContain('```')
  })

  test('strict action refuses a reply that dropped an image ref', async () => {
    const dropped = tidy.replace('![](assets/board.png)\n\n', '')
    const run = processText({ action: 'tidy', text: NOTE }, mock(dropped).complete)
    await expect(run).rejects.toBeInstanceOf(AiProcessError)
    await expect(run).rejects.toThrow(/dropped 1 image\/link/)
  })

  test('summarise may drop refs: they come back as warnings', async () => {
    const r = await processText({ action: 'summarize', text: NOTE }, mock('- Settings page Thursday; ask Sam.').complete)
    expect(r.warnings).toContain('![](assets/board.png)')
    expect(r.text.startsWith('---\ntitle: Standup')).toBe(true)
  })

  test('custom instruction goes into the system prompt', async () => {
    const m = mock(tidy)
    await processText({ action: 'custom', text: NOTE, instruction: 'Write it as a haiku' }, m.complete)
    expect(m.calls[0]?.system).toContain('Write it as a haiku')
  })

  test('selection keeps its surrounding whitespace', async () => {
    const m = mock((u) => u.toUpperCase())
    const r = await processText({ action: 'typos', text: '  teh cat\n', scope: 'selection' }, m.complete)
    expect(m.calls[0]?.system).toContain('selection from a larger note')
    expect(r.text).toBe('  TEH CAT\n')
  })

  test('empty body and empty reply are errors', async () => {
    await expect(processText({ action: 'tidy', text: '---\na: 1\n---\n  \n' }, mock('x').complete)).rejects.toThrow(/empty/)
    await expect(processText({ action: 'tidy', text: 'hello' }, mock('   ').complete)).rejects.toThrow(/empty reply/)
  })
})

describe('helpers', () => {
  test('cleanReply drops a "Here is" preamble', () => {
    expect(cleanReply("Here's the tidied note:\n\n# Hi")).toBe('# Hi')
  })
  test('buildPrompt differs per action', () => {
    expect(buildPrompt('checklist', 'x').system).toContain('- [ ]')
    expect(buildPrompt('typos', 'x').system).toContain('spelling')
  })
  test('contentHash is stable and changes with content', () => {
    expect(contentHash('abc')).toBe(contentHash('abc'))
    expect(contentHash('abc')).not.toBe(contentHash('abd'))
    expect(contentHash('')).toMatch(/^[0-9a-f]{8}$/)
  })
  test('parseProcessedEntry validates', () => {
    expect(parseProcessedEntry({ noteId: 'a', rawHash: 'h', text: 't' })?.action).toBe('tidy')
    expect(parseProcessedEntry({ noteId: 'a' })).toBeNull()
  })
})
