import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { BookOpen, ChevronLeft, Pencil } from 'lucide-react-native';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import type { NoteDoc } from '../lib/format';
import { Markdown } from '../components/Markdown';
import { Icon } from '../components/Icon';
import { folderOf } from '../lib/when';
import { followMoves } from '../lib/vault';

/** Show the title above the page unless the body already opens with that same `# H1`. */
function showTitle(title: string, body: string): boolean {
  const h1 = /^#\s+(.+)$/m.exec(body.trimStart().split('\n')[0] ?? '')?.[1]?.trim();
  return !h1 || h1 !== title.trim();
}

const AUTOSAVE_MS = 700;

/**
 * Note editor, Obsidian-style: back · folder breadcrumb · read/edit toggle,
 * then the page. Edits autosave (debounced, and on leave) — no Save button.
 */
export function EditorScreen({ noteId, onClose }: { noteId: string; onClose: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  const { openNote, saveNote, notes } = useStore();
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [loading, setLoading] = useState(true);
  const [state, setState] = useState<'clean' | 'dirty' | 'saving' | 'error'>('clean');
  /** Body as last read from / written to disk: the merge base for the next save. */
  const saved = useRef('');
  const docRef = useRef<NoteDoc | null>(null);
  const textRef = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  docRef.current = doc;
  textRef.current = text;

  useEffect(() => {
    let live = true;
    setLoading(true);
    void openNote(noteId).then((d) => {
      if (!live) return;
      setDoc(d);
      setText(d?.markdown ?? '');
      saved.current = d?.markdown ?? '';
      // Inbox raws and empty notes open straight into edit; others in reading view.
      setMode(d && (d.path.startsWith('inbox/') || !d.markdown.trim()) ? 'edit' : 'view');
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [noteId, openNote]);

  // Reading view follows the file: when sync (or anything else) changes or
  // moves the open note, reload it so the page never shows a stale copy.
  useEffect(() => {
    const d = docRef.current;
    if (!d || mode !== 'view' || timer.current || textRef.current !== saved.current) return;
    // Path-id notes lose their id when sync renames them: follow the recorded move.
    const e = notes.find((n) => n.id === d.id) ?? notes.find((n) => n.path === followMoves(d.path)) ?? notes.find((n) => n.path === d.path);
    if (!e || (e.updatedAt === d.updatedAt && e.path === d.path)) return;
    let live = true;
    void openNote(e.id).then((fresh) => {
      if (!live || !fresh || textRef.current !== saved.current) return;
      setDoc(fresh);
      setText(fresh.markdown);
      saved.current = fresh.markdown;
    });
    return () => {
      live = false;
    };
  }, [notes, mode, openNote]);

  async function flush(next = textRef.current): Promise<void> {
    const d = docRef.current;
    if (!d || next === saved.current) return;
    setState('saving');
    try {
      const r = await saveNote(d.id, next, { base: saved.current, path: d.path, head: d.head });
      if (!r) {
        setState('error');
        return;
      }
      setDoc(r);
      if (r.markdown.replace(/\s+$/, '') !== next.replace(/\s+$/, '')) {
        // Merged with a change sync brought in while the note was open.
        saved.current = r.markdown;
        if (textRef.current === next) setText(r.markdown);
      } else saved.current = next;
      setState(textRef.current === next ? 'clean' : 'dirty');
    } catch {
      setState('error');
    }
  }

  function onChange(next: string): void {
    setText(next);
    setState('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flush(next);
    }, AUTOSAVE_MS);
  }

  async function close(): Promise<void> {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    await flush();
    onClose();
  }

  if (loading) return <View style={ui.center}><ActivityIndicator color={c.accent} /></View>;

  const status = state === 'saving' ? 'Saving…' : state === 'dirty' ? 'Edited' : state === 'error' ? 'Not saved' : '';

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: c.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[ui.topBar, { marginHorizontal: 10 }]}>
        <Pressable onPress={() => void close()} style={ui.iconBtn} accessibilityLabel="Back">
          <Icon as={ChevronLeft} />
        </Pressable>
        <Text style={[ui.meta, { flex: 1, marginTop: 0 }]} numberOfLines={1}>
          {doc ? folderOf(doc.path) : ''}
          {status ? `  ·  ${status}` : ''}
        </Text>
        {doc && (
          <Pressable
            onPress={() => {
              if (mode === 'edit') void flush();
              setMode(mode === 'edit' ? 'view' : 'edit');
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
        <TextInput
          style={[ui.composer, { flex: 1, paddingHorizontal: 20, paddingBottom: 40 }]}
          value={text}
          onChangeText={onChange}
          multiline
          autoFocus
          placeholder="Start writing…"
          placeholderTextColor={c.faint}
        />
      ) : (
        <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 60 }}>
          <Pressable onPress={() => setMode('edit')}>
            {showTitle(doc.title, text) && <Text style={[ui.display, { marginBottom: 8 }]}>{doc.title}</Text>}
            <Markdown text={text || '_Empty note — tap to write._'} notePath={doc.path} />
            {doc.tags.length > 0 && (
              <Text style={[ui.meta, { marginTop: 20, color: c.accent }]}>{doc.tags.map((t) => `#${t}`).join('  ')}</Text>
            )}
          </Pressable>
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  );
}
