import { describe, expect, test } from 'bun:test'
import { editorPropsEqual, MARKDOWN_EDITOR_DOM_PROPS } from '../src/lib/editorHostProps'

describe('Android CodeMirror WebView host props', () => {
  test('identical editor inputs compare equal across unrelated screen renders', () => {
    const props = {
      dom: MARKDOWN_EDITOR_DOM_PROPS,
      markdown: '# Note\ntext',
      title: 'Note',
      files: ['assets/photo.png'],
      onChange: () => {},
      onFlush: () => {}
    }

    expect(editorPropsEqual(props, { ...props })).toBe(true)
  })

  test('Markdown and callback changes still reach the live editor', () => {
    const props = {
      dom: MARKDOWN_EDITOR_DOM_PROPS,
      markdown: '# Note\ntext',
      title: 'Note',
      onChange: () => {}
    }

    expect(editorPropsEqual(props, { ...props, markdown: '# Note\nupdated' })).toBe(false)
    expect(editorPropsEqual(props, { ...props, onChange: () => {} })).toBe(false)
  })

  test('a newly allocated DOM configuration is treated as a change, so production passes the stable constant', () => {
    const first = { dom: MARKDOWN_EDITOR_DOM_PROPS, markdown: 'text' }
    const second = { dom: { ...MARKDOWN_EDITOR_DOM_PROPS }, markdown: 'text' }

    expect(editorPropsEqual(first, second)).toBe(false)
  })
})
