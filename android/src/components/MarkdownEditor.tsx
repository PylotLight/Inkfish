'use dom'

import React, { useEffect, useRef, type CSSProperties, type Ref } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { useDOMImperativeHandle, type DOMImperativeFactory, type DOMProps } from 'expo/dom'
import { insertImageReference, toggleTaskLine } from '../lib/editorText'
import { liveMarkdownExtension, type LiveMarkdownOptions } from '../lib/liveMarkdown'

type JSONValue = boolean | number | string | null | JSONValue[] | { [key: string]: JSONValue | undefined }

export interface MarkdownEditorHandle extends DOMImperativeFactory {
  focus: () => void
  replaceMarkdown: (...args: JSONValue[]) => void
  insertImageReference: (...args: JSONValue[]) => void
  flush: () => void
}

interface Props {
  ref: Ref<MarkdownEditorHandle>
  dom?: DOMProps
  markdown: string
  title: string
  notePath: string
  files: string[]
  vaultRoot: string
  hideCompletedTasks: boolean
  background: string
  textColor: string
  mutedColor: string
  faintColor: string
  accentColor: string
  insetColor: string
  borderColor: string
  selectionColor: string
  fontSize: number
  lineHeight: number
  onChange: (markdown: string) => void
  onFlush: (markdown: string) => void
}

function applyMarkdown(view: EditorView, next: string, selection?: { start: number; end: number }): void {
  const before = view.state.doc.toString()
  if (before === next) return
  let from = 0
  const shared = Math.min(before.length, next.length)
  while (from < shared && before.charCodeAt(from) === next.charCodeAt(from)) from++
  let oldEnd = before.length
  let newEnd = next.length
  while (oldEnd > from && newEnd > from && before.charCodeAt(oldEnd - 1) === next.charCodeAt(newEnd - 1)) {
    oldEnd--
    newEnd--
  }
  view.dispatch({
    changes: { from, to: oldEnd, insert: next.slice(from, newEnd) },
    ...(selection
      ? { selection: { anchor: Math.min(selection.start, next.length), head: Math.min(selection.end, next.length) } }
      : {}),
    scrollIntoView: true
  })
}

export default function MarkdownEditor(props: Props): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const initialMarkdown = useRef(props.markdown)
  const previousExternalMarkdown = useRef(props.markdown)
  const liveCompartment = useRef(new Compartment())
  const callbacks = useRef({ onChange: props.onChange, onFlush: props.onFlush })
  callbacks.current = { onChange: props.onChange, onFlush: props.onFlush }
  const options = useRef<LiveMarkdownOptions>({
    notePath: props.notePath,
    files: props.files,
    vaultRoot: props.vaultRoot,
    title: props.title,
    hideCompletedTasks: props.hideCompletedTasks
  })
  options.current = {
    notePath: props.notePath,
    files: props.files,
    vaultRoot: props.vaultRoot,
    title: props.title,
    hideCompletedTasks: props.hideCompletedTasks
  }
  const toggleTask = useRef<(lineFrom: number) => void>(() => undefined)
  toggleTask.current = (lineFrom) => {
    const view = viewRef.current
    if (!view) return
    const line = view.state.doc.lineAt(Math.min(lineFrom, view.state.doc.length))
    const today = new Date()
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const next = toggleTaskLine(line.text, date)
    if (next !== null) view.dispatch({ changes: { from: line.from, to: line.to, insert: next } })
  }

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: initialMarkdown.current,
        extensions: [
          liveCompartment.current.of(
            liveMarkdownExtension(
              () => options.current,
              (from) => toggleTask.current(from)
            )
          ),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callbacks.current.onChange(update.state.doc.toString())
          })
        ]
      }),
      parent: host.current
    })
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: liveCompartment.current.reconfigure(
        liveMarkdownExtension(
          () => options.current,
          (from) => toggleTask.current(from)
        )
      )
    })
  }, [props.notePath, props.files, props.vaultRoot, props.title, props.hideCompletedTasks])

  useEffect(() => {
    if (props.markdown === previousExternalMarkdown.current) return
    previousExternalMarkdown.current = props.markdown
    const view = viewRef.current
    if (view) applyMarkdown(view, props.markdown)
  }, [props.markdown])

  const rootStyle = {
    '--md-bg': props.background,
    '--md-text': props.textColor,
    '--md-muted': props.mutedColor,
    '--md-faint': props.faintColor,
    '--md-accent': props.accentColor,
    '--md-inset': props.insetColor,
    '--md-border': props.borderColor,
    '--md-selection': props.selectionColor,
    '--md-code': props.accentColor,
    '--md-font-size': `${props.fontSize}px`,
    '--md-line-height': `${props.lineHeight}px`,
    width: '100%',
    height: '100%',
    overflow: 'hidden',
    backgroundColor: props.background
  } as CSSProperties

  useDOMImperativeHandle(
    props.ref,
    () => ({
      focus: () => viewRef.current?.focus(),
      replaceMarkdown: (...args) => {
        const next = args[0]
        if (typeof next !== 'string') return
        previousExternalMarkdown.current = next
        const view = viewRef.current
        if (view) applyMarkdown(view, next)
      },
      insertImageReference: (...args) => {
        const rel = args[0]
        if (typeof rel !== 'string') return
        const view = viewRef.current
        if (!view) return
        const selection = view.state.selection.main
        const current = view.state.doc.toString()
        const inserted = insertImageReference(current, { start: selection.from, end: selection.to }, rel)
        applyMarkdown(view, inserted.text, inserted.selection)
        view.focus()
      },
      flush: () => {
        const view = viewRef.current
        callbacks.current.onFlush(view?.state.doc.toString() ?? initialMarkdown.current)
      }
    }),
    []
  )

  return <div ref={host} className="inkfish-markdown-editor" style={rootStyle} aria-label="Markdown note editor" />
}
