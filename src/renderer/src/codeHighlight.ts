import type { Extension } from '@codemirror/state'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { LanguageDescription, LanguageSupport, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { classHighlighter } from '@lezer/highlight'

/**
 * Syntax highlighting for the note editor: a GFM markdown parser underneath the live preview, with
 * fenced code blocks highlighted in their own language (```ts, ```python, ```rust, ```sql, ```yaml …,
 * ~150 languages from @codemirror/language-data, each lazy-loaded as its own chunk the first time a
 * block uses it — bundled, no CDN).
 *
 * Tokens get stable `tok-*` classes (classHighlighter) coloured in index.css from theme vars, so every
 * theme (incl. paper) picks its own palette. The live preview keeps doing the markdown look (headings,
 * hidden markers); only code tokens and markdown chrome that's still visible get colour here.
 *
 * `addKeymap: false` — Enter / Backspace list handling stays with livePreview's `listKeys`.
 */

/** Extra fence names people actually type that language-data doesn't alias. */
const EXTRA_ALIASES: Record<string, string[]> = {
  Shell: ['console', 'shellsession', 'terminal', 'env', 'dotenv'],
  Python: ['py3', 'python3'],
  JavaScript: ['node', 'mjs', 'cjs'],
  YAML: ['yml'],
  Dockerfile: ['docker', 'containerfile'],
  'Properties files': ['ini', 'conf', 'cfg'],
  diff: ['patch'],
  Markdown: ['md', 'mdx'],
  'Objective-C': ['objc'],
  PowerShell: ['ps1', 'pwsh'],
  ProtoBuf: ['proto'],
  'C#': ['cs', 'csharp'],
  'F#': ['fs', 'fsharp'],
  'C++': ['cc', 'hpp', 'cxx']
}

/**
 * language-data, but every file extension also works as a fence name (```py, ```rs, ```kt …) — its
 * matcher only checks names/aliases — plus fish (not in language-data; shell mode is close enough).
 */
export const codeLanguages: LanguageDescription[] = [
  ...languages.map((l) =>
    LanguageDescription.of({
      name: l.name,
      alias: [...new Set([...l.alias, ...l.extensions, ...(EXTRA_ALIASES[l.name] ?? [])].map((a) => a.toLowerCase()))],
      extensions: l.extensions,
      filename: l.filename,
      load: () => l.load()
    })
  ),
  LanguageDescription.of({
    name: 'Fish',
    alias: ['fish', 'fishshell'],
    extensions: ['fish'],
    load: () =>
      import('@codemirror/legacy-modes/mode/shell').then((m) => new LanguageSupport(StreamLanguage.define(m.shell)))
  })
]

export function codeHighlight(): Extension {
  return [
    markdown({ base: markdownLanguage, codeLanguages, addKeymap: false, completeHTMLTags: false }),
    syntaxHighlighting(classHighlighter)
  ]
}

/** The language a fence info string (```ts, ```py, ```Dockerfile …) resolves to, if any. */
export function codeLanguageFor(info: string): LanguageDescription | null {
  const name = info.trim().split(/\s/)[0] ?? ''
  if (!name) return null
  return LanguageDescription.matchLanguageName(codeLanguages, name, false)
}
