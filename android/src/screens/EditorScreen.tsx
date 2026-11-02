import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  type TextInputInstance
} from 'react-native'
import { BookOpen, ChevronLeft, ImagePlus, Pencil } from 'lucide-react-native'
import * as Clipboard from 'expo-clipboard'
import { useTheme } from '../theme'
import { useStore } from '../lib/store'
import type { NoteDoc } from '../lib/format'
import { Markdown } from '../components/Markdown'
import { Icon } from '../components/Icon'
import { folderOf } from '../lib/when'
import { followMoves, invalidateAttachments, saveAssetBase64 } from '../lib/vault'
import { parseMarkdown } from '../lib/markdown'
import { insertImageReference, toggleTaskLine } from '../lib/editorText'

/** Avoid repeating a leading H1 when the same title is already shown as the page heading. */
function bodyWithoutTitleHeading(title: string, body: string): string {
  const first = body.trimStart()
  const h1 = /^(#\s+[^\n]*)(?:\n|$)/.exec(first)
  if (!h1 || h1[1]!.slice(2).trim() !== title.trim()) return body
  return first.slice(h1[0].length).replace(/^\n/, '')
}

const AUTOSAVE_MS = 700

/**
 * Note editor, Obsidian-style: back · folder breadcrumb · read/edit toggle,
 * then the page. Edits autosave (debounced, and on leave) — no Save button.
 */
export function EditorScreen({ noteId, onClose }: { noteId: string; onClose: () => void }): React.JSX.Element {
  const { ui, c } = useTheme()
  const { openNote, saveNote, notes } = useStore()
  const [doc, setDoc] = useState<NoteDoc | null>(null)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [selection, setSelection] = useState({ start: 0, end: 0 })
  const [hideCompletedTasks, setHideCompletedTasks] = useState(false)
  const [mode, setMode] = useState<'view' | 'edit'>('view')
  const [loading, setLoading] = useState(true)
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'error'>('clean')
  /** Body as last read from / written to disk: the merge base for the next save. */
  const saved = useRef('')
  const savedTitle = useRef('')
  const docRef = useRef<NoteDoc | null>(null)
  const textRef = useRef('')
  const titleRef = useRef('')
  const selectionRef = useRef(selection)
  const inputRef = useRef<TextInputInstance>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  docRef.current = doc
  textRef.current = text
  titleRef.current = title
  selectionRef.current = selection

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
      saved.current = d?.markdown ?? ''
      const initialSelection = { start: d?.markdown.length ?? 0, end: d?.markdown.length ?? 0 }
      setSelection(initialSelection)
      selectionRef.current = initialSelection
      setHideCompletedTasks(false)
      // Inbox raws and empty notes open straight into edit; others in reading view.
      setMode(d && (d.path.startsWith('inbox/') || !d.markdown.trim()) ? 'edit' : 'view')
      setLoading(false)
    })
    return () => {
      live = false
    }
  }, [noteId, openNote])

  useEffect(() => {
    if (loading || mode !== 'edit') return
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [loading, mode])

  // Reading view follows the file: when sync (or anything else) changes or
  // moves the open note, reload it so the page never shows a stale copy.
  useEffect(() => {
    const d = docRef.current
    if (
      !d ||
      mode !== 'view' ||
      timer.current ||
      textRef.current !== saved.current ||
      titleRef.current.trim() !== savedTitle.current
    )
      return
    // Path-id notes lose their id when sync renames them: follow the recorded move.
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
      setText(fresh.markdown)
      saved.current = fresh.markdown
    })
    return () => {
      live = false
    }
  }, [notes, mode, openNote])

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
        // Merged with a change sync brought in while the note was open.
        saved.current = r.markdown
        if (textRef.current === next) setText(r.markdown)
      } else saved.current = next
      setState(textRef.current === next && titleRef.current.trim() === r.title ? 'clean' : 'dirty')
    } catch {
      setState('error')
    }
  }

  function onChange(next: string): void {
    setText(next)
    setState('dirty')
    scheduleFlush(next)
  }

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
      const inserted = insertImageReference(textRef.current, selectionRef.current, rel)
      onChange(inserted.text)
      setSelection(inserted.selection)
      selectionRef.current = inserted.selection
      requestAnimationFrame(() => inputRef.current?.focus())
    } catch (e) {
      Alert.alert("Couldn't paste image", e instanceof Error ? e.message : String(e))
    }
  }

  function scheduleFlush(next = textRef.current): void {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      void flush(next)
    }, AUTOSAVE_MS)
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

  async function close(): Promise<void> {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
    await flush()
    onClose()
  }

  if (loading) {
    // Show the page frame + title from the index right away; the body fills in.
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
  const renderedPrefixLength = text.length - renderedBody.length
  const renderedLineOffset = (text.slice(0, renderedPrefixLength).match(/\n/g) ?? []).length
  const completedTaskCount = parseMarkdown(renderedBody).filter((block) => block.t === 'task' && block.done).length

  function toggleTask(line: number): void {
    const lines = textRef.current.split('\n')
    const index = line + renderedLineOffset
    if (index < 0 || index >= lines.length) return
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const updated = toggleTaskLine(lines[index] ?? '', date)
    if (updated === null) return
    lines[index] = updated
    onChange(lines.join('\n'))
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: c.bg }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={[ui.topBar, { marginHorizontal: 10 }]}>
        <Pressable onPress={() => void close()} style={ui.iconBtn} accessibilityLabel="Back">
          <Icon as={ChevronLeft} />
        </Pressable>
        <Text style={[ui.meta, { flex: 1, marginTop: 0 }]} numberOfLines={1}>
          {doc ? folderOf(doc.path) : ''}
          {status ? `  ·  ${status}` : ''}
        </Text>
        {doc && (
          mode === 'edit' && (
            <Pressable onPress={() => void pasteImage()} style={ui.iconBtn} accessibilityLabel="Paste image from clipboard">
              <Icon as={ImagePlus} size={20} />
            </Pressable>
          )
        )}
        {doc && (
          <Pressable
            onPress={() => {
              if (mode === 'edit') void flush()
              setMode(mode === 'edit' ? 'view' : 'edit')
            }}
            style={ui.iconBtn}
            accessibilityLabel={mode === 'edit' ? 'Reading view' : 'Edit'}
          >
            <Icon as={mode === 'edit' ? BookOpen : Pencil} size={20} />
          </Pressable>
        )}
      </View>

      {!doc ? (
        <Text style={[ui.meta, { paddingHorizontal: 20 }]}>Note not found.</Text>
      ) : mode === 'edit' ? (
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
          <TextInput
            ref={inputRef}
            style={[ui.composer, { flex: 1, paddingHorizontal: 20, paddingBottom: 40 }]}
            value={text}
            onChangeText={onChange}
            selection={selection}
            onSelectionChange={(event) => {
              const next = event.nativeEvent.selection
              selectionRef.current = next
              setSelection(next)
            }}
            multiline
            placeholder="Start writing…"
            placeholderTextColor={c.faint}
          />
        </View>
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}>
          <Pressable onPress={() => setMode('edit')}>
            <Text style={[ui.display, { marginBottom: 8 }]}>{doc.title}</Text>
          </Pressable>
          {completedTaskCount > 0 && (
            <Pressable onPress={() => setHideCompletedTasks((v) => !v)} style={[ui.quiet, { alignSelf: 'flex-start', marginBottom: 6 }]}>
              <Text style={ui.quietText}>
                {hideCompletedTasks ? `Show ${completedTaskCount} completed` : `Hide ${completedTaskCount} completed`}
              </Text>
            </Pressable>
          )}
          <Markdown
            text={renderedBody || '_Empty note — tap Edit to write._'}
            notePath={doc.path}
            onToggleTask={toggleTask}
            hideCompletedTasks={hideCompletedTasks}
          />
          {doc.tags.length > 0 && (
            <Text style={[ui.meta, { marginTop: 20, color: c.accent }]}>
              {doc.tags.map((t) => `#${t}`).join('  ')}
            </Text>
          )}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  )
}
