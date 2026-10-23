import { describe, expect, it } from 'bun:test'
import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { classHighlighter, highlightTree } from '@lezer/highlight'
import { codeHighlight, codeLanguageFor } from './codeHighlight'

/** `text=classes` for every highlighted span, after loading the fence's language. */
async function tokens(doc: string, lang: string): Promise<string[]> {
  await codeLanguageFor(lang)!.load()
  const state = EditorState.create({ doc, extensions: [codeHighlight()] })
  const tree = ensureSyntaxTree(state, state.doc.length, 5000)!
  const out: string[] = []
  highlightTree(tree, classHighlighter, (f, t, c) => void out.push(`${state.sliceDoc(f, t)}=${c}`))
  return out
}

describe('codeHighlight', () => {
  it('resolves names, aliases and file extensions as fence names', () => {
    const cases: Array<[string, string]> = [
      ['ts', 'TypeScript'],
      ['typescript', 'TypeScript'],
      ['tsx', 'TSX'],
      ['js', 'JavaScript'],
      ['py', 'Python'],
      ['python', 'Python'],
      ['rs', 'Rust'],
      ['go', 'Go'],
      ['sql', 'SQL'],
      ['yaml', 'YAML'],
      ['yml', 'YAML'],
      ['json', 'JSON'],
      ['bash', 'Shell'],
      ['sh', 'Shell'],
      ['zsh', 'Shell'],
      ['console', 'Shell'],
      ['fish', 'Fish'],
      ['swift', 'Swift'],
      ['kt', 'Kotlin'],
      ['java', 'Java'],
      ['c', 'C'],
      ['cpp', 'C++'],
      ['css', 'CSS'],
      ['html', 'HTML'],
      ['md', 'Markdown'],
      ['Dockerfile', 'Dockerfile'],
      ['toml', 'TOML'],
      ['diff', 'diff'],
      ['rb', 'Ruby'],
      ['cs', 'C#']
    ]
    for (const [info, want] of cases) expect([info, codeLanguageFor(info)?.name]).toEqual([info, want])
    expect(codeLanguageFor('')).toBeNull()
    expect(codeLanguageFor('not-a-lang-xyz')).toBeNull()
  })

  it('parses a note as GFM', () => {
    const state = EditorState.create({ doc: '# Title\n\n- [ ] task\n', extensions: [codeHighlight()] })
    const names = new Set<string>()
    ensureSyntaxTree(state, state.doc.length, 5000)!.iterate({ enter: (n) => void names.add(n.name) })
    expect(names.has('ATXHeading1')).toBe(true)
    expect(names.has('Task')).toBe(true)
  })

  it('highlights inside a ts fence', async () => {
    const t = await tokens('```ts\nconst answer: number = 42\n```\n', 'ts')
    expect(t).toContain('ts=tok-labelName')
    expect(t).toContain('const=tok-keyword')
    expect(t).toContain('42=tok-number')
  })

  it('highlights python and fish fences', async () => {
    expect(await tokens('```py\ndef f():\n    return "hi"\n```\n', 'py')).toContain('def=tok-keyword')
    const fish = await tokens("```fish\necho 'hi' # note\n```\n", 'fish')
    expect(fish.some((s) => s.startsWith("'hi'=") && s.includes('tok-string'))).toBe(true)
  })
})
