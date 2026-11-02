import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View
} from 'react-native'
import { ChevronLeft, ImagePlus } from 'lucide-react-native'
import * as Clipboard from 'expo-clipboard'
import { useTheme } from '../theme'
import { useStore } from '../lib/store'
import type { NoteDoc } from '../lib/format'
import MarkdownEditor, { type MarkdownEditorHandle } from '../components/MarkdownEditor'
import { editorPropsEqual, MARKDOWN_EDITOR_DOM_PROPS } from '../lib/editorHostProps'
import { Icon } from '../components/Icon'
import { folderOf } from '../lib/when'
import { followMoves, invalidateAttachments, listAttachments, saveAssetBase64, vaultRootUri } from '../lib/vault'
import { parseMarkdown } from '../lib/markdown'

const StableMarkdownEditor = React.memo(MarkdownEditor, editorPropsEqual)

/** Avoid repeating a leading H1 when the same title is already shown as the page heading. */
function bodyWithoutTitleHeading(title: string, body: string): string {
  const first = body.trimStart()
  const h1 = /^(#\s+[^\n]*)(?:\n|$)/.exec(first)
  if (!h1 || h1[1]!.slice(2).trim() !== title.trim()) return body
  return first.slice(h1[0].length).replace(/^\n/, '')
}

const AUTOSAVE_MS = 700

type RegisterClose = (close: (() => void) | null) => void

/**
 * A single, always-mounted Markdown surface: untouched source remains editable
 * in CodeMirror while its syntax is rendered inline. No edit/read-mode switch.
 */
export function EditorScreen({
  noteId,
  onClose,
  onRegisterClose
}: {
  noteId: string
  onClose: () => void
  onRegisterClose?: RegisterClose
}): React.JSX.Element {
  const { ui, c } = useTheme()
  const { openNote, saveNote, notes } = useStore()
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  /** Changes only for a newly opened note or an external merge, never per keystroke. */
  const [editorMarkdown, setEditorMarkdown] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [hideCompletedTasks, setHideCompletedTasks] = useState(false)
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'error'>('clean')
  /** Body as last read from / written to disk: the merge base for the next save. */
  const saved = useRef('')
  const savedTitle = useRef('')
  const docRef = useRef<NoteDoc | null>(null)
  const textRef = useRef('')
  const titleRef = useRef('')
  const editorRef = useRef<MarkdownEditorHandle>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  docRef.current = doc
  textRef.current = text
  titleRef.current = title

  useEffect(() => {
    let live = true
    setLoading(true)
    void openNote(noteId).then((d) => {
      if (!live) return
      setDoc(d)
      setTitle(d?.title ?? '')
      titleRef.current = d?.title ?? ''
      savedTitle.current = d?.title ?? ''
      setText(d?.markdown ?? '')
      textRef.current = d?.markdown ?? ''
      setEditorMarkdown(d?.markdown ?? '')
      saved.current = d?.markdown ?? ''
      setHideCompletedTasks(false)
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [noteId, openNote])

  useEffect(() => {
    let live = true
    setAttachments([])
    void listAttachments()
      .then((files) => {
        if (live) setAttachments(files)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [noteId])

  // Reading content follows sync when the user has no unsaved local edits.
  useEffect(() => {
    const d = docRef.current
    if (!d || timer.current || textRef.current !== saved.current || titleRef.current.trim() !== savedTitle.current)
      return
    const e =
      notes.find((n) => n.id === d.id) ??
      notes.find((n) => n.path === followMoves(d.path)) ??
      notes.find((n) => n.path === d.path)
    if (!e || (e.updatedAt === d.updatedAt && e.path === d.path)) return
    let live = true
    void openNote(e.id).then((fresh) => {
      if (!live || !fresh || textRef.current !== saved.current) return
      setDoc(fresh)
      setTitle(fresh.title)
      titleRef.current = fresh.title
      savedTitle.current = fresh.title
      textRef.current = fresh.markdown
      setText(fresh.markdown)
      setEditorMarkdown(fresh.markdown)
      saved.current = fresh.markdown
    })
    return () => {
      live = false
    }
  }, [notes, openNote])

  async function flush(next = textRef.current): Promise<void> {
    const d = docRef.current
    const nextTitle = titleRef.current.trim()
    const titleChanged = Boolean(nextTitle) && nextTitle !== savedTitle.current
    if (!d || (next === saved.current && !titleChanged)) return
    setState('saving')
    try {
      const r = await saveNote(d.id, next, {
        base: saved.current,
        path: d.path,
        head: d.head,
        ...(titleChanged ? { title: nextTitle } : {})
      })
      if (!r) {
        setState('error')
        return
      }
      setDoc(r)
      savedTitle.current = r.title
      if (titleRef.current.trim() === nextTitle) {
        setTitle(r.title)
        titleRef.current = r.title
      }
      if (r.markdown.replace(/\s+$/, '') !== next.replace(/\s+$/, '')) {
        // A sync conflict was merged into the Markdown source; update the live document in place.
        saved.current = r.markdown
        if (textRef.current === next) {
          textRef.current = r.markdown
          setText(r.markdown)
          setEditorMarkdown(r.markdown)
        }
      } else saved.current = next
      setState(textRef.current === next && titleRef.current.trim() === r.title ? 'clean' : 'dirty')
    } catch {
      setState('error')
    }
  }

  function scheduleFlush(next = textRef.current): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void flush(next)
    }, AUTOSAVE_MS)
  }

  function onChange(next: string): void {
    textRef.current = next
    setText(next)
    setState('dirty')
    scheduleFlush(next)
  }

  const editorChangeRef = useRef(onChange)
  editorChangeRef.current = onChange
  const handleEditorChange = useCallback((next: string) => editorChangeRef.current(next), [])

  function finishClose(next: string): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    textRef.current = next
    setText(next)
    void flush(next).finally(onClose)
  }
  const finishCloseRef = useRef(finishClose)
  finishCloseRef.current = finishClose
  const handleEditorFlush = useCallback((next: string) => finishCloseRef.current(next), [])
  const closeRef = useRef<() => void>(() => undefined)
  closeRef.current = () => {
    if (editorRef.current) editorRef.current.flush()
    else finishClose(textRef.current)
  }
  const closeEditor = useCallback(() => closeRef.current(), [])
  useEffect(() => {
    onRegisterClose?.(closeEditor)
    return () => onRegisterClose?.(null)
  }, [closeEditor, onRegisterClose])

  async function pasteImage(): Promise<void> {
    try {
      const image = await Clipboard.getImageAsync({ format: 'png' })
      if (!image?.data) {
        Alert.alert('No image in clipboard', 'Copy an image, then tap Paste image again.')
        return
      }
      const base64 = image.data.replace(/^data:image\/png;base64,/i, '')
      const rel = await saveAssetBase64(base64, '.png')
      invalidateAttachments()
      setAttachments((files) => (files.includes(rel) ? files : [...files, rel]))
      editorRef.current?.insertImageReference(rel)
    } catch (e) {
      Alert.alert("Couldn't paste image", e instanceof Error ? e.message : String(e))
    }
  }

  function onTitleChange(next: string): void {
    setTitle(next)
    titleRef.current = next
    setState('dirty')
    scheduleFlush()
  }

  function finishTitleEdit(): void {
    const next = titleRef.current.trim()
    if (!next) {
      setTitle(savedTitle.current)
      titleRef.current = savedTitle.current
      return
    }
    setTitle(next)
    titleRef.current = next
    void flush()
  }

  if (loading) {
    const known = notes.find((n) => n.id === noteId)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <View style={[ui.topBar, { marginHorizontal: 10 }]}>
          <Pressable onPress={onClose} style={ui.iconBtn} accessibilityLabel="Back">
            <Icon as={ChevronLeft} />
          </Pressable>
          <Text style={[ui.meta, { flex: 1, marginTop: 0 }]} numberOfLines={1}>
            {known ? folderOf(known.path) : ''}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 20 }}>
          {known ? <Text style={[ui.display, { marginBottom: 8 }]}>{known.title}</Text> : null}
          <ActivityIndicator color={c.accent} style={{ marginTop: 16, alignSelf: 'flex-start' }} />
        </View>
      </View>
    )
  }

  const status = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Edited' : state === 'error' ? 'Not saved' : ''
  const renderedBody = doc ? bodyWithoutTitleHeading(doc.title, text) : ''
  const completedTaskCount = parseMarkdown(renderedBody).filter((block) => block.t === 'task' && block.done).length
  const fontSize = Number(ui.composer.fontSize ?? 17)
  const lineHeight = Number(ui.composer.lineHeight ?? 26)

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[ui.topBar, { marginHorizontal: 10 }]}>
        <Pressable
          onPress={closeEditor}
          style={ui.iconBtn}
          accessibilityLabel="Back"
          accessibilityHint="Saves the note and returns"
        >
          <Icon as={ChevronLeft} />
        </Pressable>
        <Text style={[ui.meta, { flex: 1, marginTop: 0 }]} numberOfLines={1} accessibilityLiveRegion="polite">
          {doc ? folderOf(doc.path) : ''}
          {status ? `  ·  ${status}` : ''}
        </Text>
        {doc ? (
          <Pressable
            onPress={() => void pasteImage()}
            style={ui.iconBtn}
            accessibilityLabel="Paste image from clipboard"
          >
            <Icon as={ImagePlus} size={20} />
          </Pressable>
        ) : null}
      </View>

      {!doc ? (
        <Text style={[ui.meta, { paddingHorizontal: 20 }]}>Note not found.</Text>
      ) : (
        <View style={{ flex: 1 }}>
          <TextInput
            style={[ui.display, { marginHorizontal: 20, marginTop: 8, marginBottom: 8, padding: 0 }]}
            value={title}
            onChangeText={onTitleChange}
            onEndEditing={finishTitleEdit}
            accessibilityLabel="Note title"
            returnKeyType="done"
            placeholder="Note title"
            placeholderTextColor={c.faint}
          />
          {completedTaskCount > 0 ? (
            <Pressable
              onPress={() => setHideCompletedTasks((value) => !value)}
              style={[ui.quiet, { alignSelf: 'flex-start', marginHorizontal: 20, marginBottom: 4 }]}
              accessibilityRole="button"
              accessibilityLabel={
                hideCompletedTasks
                  ? `Show ${completedTaskCount} completed tasks`
                  : `Hide ${completedTaskCount} completed tasks`
              }
            >
              <Text style={ui.quietText}>
                {hideCompletedTasks ? `Show ${completedTaskCount} completed` : `Hide ${completedTaskCount} completed`}
              </Text>
            </Pressable>
          ) : null}
          <StableMarkdownEditor
            ref={editorRef}
            dom={MARKDOWN_EDITOR_DOM_PROPS}
            markdown={editorMarkdown}
            title={title}
            notePath={doc.path}
            files={attachments}
            vaultRoot={vaultRootUri()}
            hideCompletedTasks={hideCompletedTasks}
            background={c.bg}
            textColor={c.text}
            mutedColor={c.muted}
            faintColor={c.faint}
            accentColor={c.accent}
            insetColor={c.inset}
            borderColor={c.border}
            selectionColor={c.accent}
            fontSize={fontSize}
            lineHeight={lineHeight}
            onChange={handleEditorChange}
            onFlush={handleEditorFlush}
          />
          {doc.tags.length > 0 ? (
            <Text
              style={[ui.meta, { marginHorizontal: 20, marginBottom: 10, color: c.accent }]}
              accessibilityLabel={`Tags: ${doc.tags.join(', ')}`}
            >
              {doc.tags.map((tag) => `#${tag}`).join('  ')}
            </Text>
          ) : null}
        </View>
      )}
    </KeyboardAvoidingView>
  )
}
