import { describe, expect, test } from 'bun:test'
import {
  AiProcessError,
  splitChunks,
  buildPrompt,
  cleanReply,
  contentHash,
  missingRefs,
  parseProcessedEntry,
  processText,
  protectedRefs,
  restoreImageSizes,
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
    const r = await processText(
      { action: 'summarize', text: NOTE },
      mock('- Settings page Thursday; ask Sam.').complete
    )
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
    await expect(processText({ action: 'tidy', text: '---\na: 1\n---\n  \n' }, mock('x').complete)).rejects.toThrow(
      /empty/
    )
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

describe('long notes vs the model limits', () => {
  const para = (i: number): string => `Paragraph ${i} ${'lorem ipsum '.repeat(30).trim()}`
  const long = Array.from({ length: 10 }, (_, i) => para(i)).join('\n\n')

  test('splitChunks: paragraph boundaries, never inside a code fence, nothing lost', () => {
    const fence = '```\ncode line\n\nstill code\n```'
    const text = `${para(1)}\n\n${fence}\n\n${para(2)}`
    const parts = splitChunks(text, 100)
    expect(parts.some((p) => p.includes(fence))).toBe(true)
    expect(parts.join('\n\n')).toBe(text)
    expect(splitChunks(long, 200).every((p) => p.length <= 800)).toBe(true)
    // One huge line still splits.
    expect(splitChunks('x'.repeat(1000), 50).length).toBeGreaterThan(1)
  })

  test('no limits known: one request, no notices (as before)', async () => {
    let calls = 0
    const r = await processText({ action: 'typos', text: long }, async (p) => (calls++, p.user))
    expect(calls).toBe(1)
    expect(r.notices).toEqual([])
  })

  test('rewrite action over the budget: processed in parts, joined in order, with a notice', async () => {
    const users: string[] = []
    const systems: string[] = []
    const r = await processText(
      { action: 'tidy', text: `---\nt: 1\n---\n${long}`, model: { contextWindow: 1500, maxOutputTokens: 400 } },
      async (p) => {
        users.push(p.user)
        systems.push(p.system)
        return p.user
      }
    )
    expect(users.length).toBeGreaterThan(2)
    expect(systems[0]).toContain('one consecutive part of a longer note')
    expect(r.text).toBe(`---\nt: 1\n---\n${long}\n`)
    expect(r.notices[0]).toMatch(/processed in \d+ parts/)
  })

  test('summarise over the budget: only the first part is sent, with a notice', async () => {
    let sent = ''
    const r = await processText(
      { action: 'summarize', text: long, model: { contextWindow: 1200, maxOutputTokens: 200 } },
      async (p) => {
        sent = p.user
        return '- summary'
      }
    )
    expect(sent.length).toBeLessThan(long.length)
    expect(long.startsWith(sent)).toBe(true)
    expect(r.notices[0]).toMatch(/Only the first part was sent/)
  })

  test('streaming across parts shows the finished parts plus the current one', async () => {
    const seen: string[] = []
    await processText(
      {
        action: 'typos',
        text: long,
        model: { contextWindow: 1500, maxOutputTokens: 400 },
        onChunk: (t) => seen.push(t)
      },
      async (p, onChunk) => {
        onChunk?.(p.user)
        return p.user
      }
    )
    expect(seen.length).toBeGreaterThan(1)
    expect(seen[1]!.startsWith(seen[0]!)).toBe(true)
  })

  test('image refs ride along only when asked', async () => {
    const refs: Array<string[] | undefined> = []
    const text = 'a ![](assets/x.png) b'
    await processText({ action: 'typos', text }, async (p) => (refs.push(p.imageRefs), p.user))
    await processText({ action: 'typos', text, includeImages: true }, async (p) => (refs.push(p.imageRefs), p.user))
    expect(refs).toEqual([undefined, ['assets/x.png']])
  })
})

describe('image refs with display widths (![alt|300](src))', () => {
  const sized = '# n\nsome text\n![board|300](assets/board.png)\n![|120x80](assets/b.png)\nend\n'
  test('protectedRefs counts sized refs as images, not links', () => {
    const r = protectedRefs(sized)
    expect(r.images).toEqual(['![board|300](assets/board.png)', '![|120x80](assets/b.png)'])
    expect(r.links).toEqual([])
  })
  test('missingRefs matches by src: width/alt may change, src may not', () => {
    expect(missingRefs(sized, 'x ![board](assets/board.png) ![|99](assets/b.png)')).toEqual([])
    expect(missingRefs(sized, '![board|300](assets/board.png)')).toEqual(['![|120x80](assets/b.png)'])
  })
  test('restoreImageSizes puts back stripped widths, leaves AI-sized and unknown refs alone', () => {
    expect(restoreImageSizes(sized, 'A\n![board](assets/board.png)\n![](assets/b.png)\n![](assets/c.png)')).toBe(
      'A\n![board|300](assets/board.png)\n![|120x80](assets/b.png)\n![](assets/c.png)'
    )
    expect(restoreImageSizes(sized, '![|50](assets/board.png)')).toBe('![|50](assets/board.png)')
    expect(restoreImageSizes('![](a.png)', '![](a.png)')).toBe('![](a.png)')
    // Same src at two sizes: ambiguous, left as the AI wrote it.
    expect(restoreImageSizes('![|1](a.png) ![|2](a.png)', '![](a.png)')).toBe('![](a.png)')
  })
  test('strict Tidy keeps a sized ref (and its width) even if the model drops the |300', async () => {
    const reply = '# N\n\nSome text.\n\n![board](assets/board.png)\n\n![](assets/b.png)\n\nEnd.'
    const r = await processText({ action: 'tidy', text: sized }, mock(reply).complete)
    expect(r.warnings).toEqual([])
    expect(r.text).toContain('![board|300](assets/board.png)')
    expect(r.text).toContain('![|120x80](assets/b.png)')
  })
  test('strict Tidy still refuses a reply that dropped a sized ref', async () => {
    const run = processText({ action: 'tidy', text: sized }, mock('# N\n\nSome text.\n\nEnd.').complete)
    await expect(run).rejects.toThrow(/dropped 2 image\/link/)
  })
})
