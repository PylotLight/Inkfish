import { describe, expect, test } from 'bun:test'
import { parseMarkdown } from '../src/lib/markdown'

describe('Markdown list indentation', () => {
  test('preserves each nested unordered-list level and returns to the parent level', () => {
    expect(parseMarkdown('- parent\n  - child\n    - grandchild\n- sibling')).toEqual([
      { t: 'li', text: 'parent', depth: 0 },
      { t: 'li', text: 'child', depth: 1 },
      { t: 'li', text: 'grandchild', depth: 2 },
      { t: 'li', text: 'sibling', depth: 0 }
    ])
  })

  test('preserves indentation for numbered and task items, including tabs', () => {
    expect(parseMarkdown('1. first\n    2. second\n- [ ] todo\n\t- [x] done')).toEqual([
      { t: 'li', text: 'first', depth: 0 },
      { t: 'li', text: 'second', depth: 2 },
      { t: 'task', done: false, text: 'todo', depth: 0 },
      { t: 'task', done: true, text: 'done', depth: 1 }
    ])
  })

  test('keeps indented list syntax inside code fences as code', () => {
    expect(parseMarkdown('```md\n- parent\n  - child\n```')).toEqual([{ t: 'code', text: '- parent\n  - child' }])
  })
})
