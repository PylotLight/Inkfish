import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ui } from '../theme';
import { dark } from '../theme';
import { useStore } from '../lib/store';
import type { NoteDoc } from '../lib/format';
import { Markdown } from '../components/Markdown';

/** Full editor: raw markdown source + rendered preview, same file as Mac edits. */
export function EditorScreen({ noteId, onClose }: { noteId: string; onClose: () => void }): React.JSX.Element {
  const { openNote, saveNote } = useStore();
  const [doc, setDoc] = useState<NoteDoc | null>(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'view' | 'edit'>('view');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    void openNote(noteId).then((d) => {
      if (!live) return;
      setDoc(d);
      setText(d?.markdown ?? '');
      // Inbox raws open straight into edit; routed notes open in preview.
      setMode(d && d.path.startsWith('inbox/') ? 'edit' : 'view');
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [noteId, openNote]);

  async function save(): Promise<void> {
    if (!doc) return;
    setSaving(true);
    try {
      const d = await saveNote(doc.id, text);
      if (d) {
        setDoc(d);
        setMsg('Saved ✓');
      }
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <View style={ui.screen}><ActivityIndicator color={dark.accent} /></View>;
  if (!doc) {
    return (
      <View style={ui.screen}>
        <Text style={ui.sub}>Note not found.</Text>
        <Pressable onPress={onClose} style={ui.ghostBtn}><Text style={ui.ghostText}>Back</Text></Pressable>
      </View>
    );
  }

  return (
    <ScrollView style={ui.screen} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onClose} style={[ui.chip, { alignSelf: 'flex-start', marginBottom: 10 }]}>
        <Text style={ui.chipText}>← Back</Text>
      </Pressable>
      <Text style={ui.h1}>{doc.title}</Text>
      <Text style={ui.sub}>{doc.path} · {doc.tags.map((t) => `#${t}`).join(' ') || 'no tags'}</Text>

      <View style={[ui.row, { marginBottom: 10 }]}>
        {(['view', 'edit'] as const).map((m) => (
          <Pressable key={m} onPress={() => setMode(m)} style={[ui.chip, mode === m && ui.chipOn]}>
            <Text style={[ui.chipText, mode === m && ui.chipTextOn]}>{m === 'view' ? 'Preview' : 'Edit'}</Text>
          </Pressable>
        ))}
      </View>

      {mode === 'edit' ? (
        <TextInput
          style={[ui.input, { minHeight: 320, fontFamily: 'monospace' }]}
          value={text}
          onChangeText={setText}
          multiline
          placeholderTextColor={dark.muted}
        />
      ) : (
        <View style={ui.card}>
          <Markdown text={text || '_Empty note._'} />
        </View>
      )}

      {msg && <Text style={[ui.meta, { marginTop: 8 }]}>{msg}</Text>}
      <Pressable onPress={() => void save()} disabled={saving} style={ui.btn}>
        {saving ? <ActivityIndicator color="#0b0b10" /> : <Text style={ui.btnText}>Save</Text>}
      </Pressable>
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}
