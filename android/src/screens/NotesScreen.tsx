import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import { searchNotesSync } from '../lib/vault';

export function NotesScreen({ onOpen }: { onOpen: (noteId: string) => void }): React.JSX.Element {
  const { ui, c: dark } = useTheme();
  const { notes, projects, newNote } = useStore();
  const [q, setQ] = useState('');
  const [proj, setProj] = useState<string | null>(null);

  const shown = useMemo(() => {
    let list = proj ? notes.filter((n) => n.projectId === proj) : notes;
    if (q.trim()) {
      const ids = new Set(searchNotesSync(notes, q).map((n) => n.id));
      list = list.filter((n) => ids.has(n.id));
    }
    return list.slice(0, 200);
  }, [notes, proj, q]);

  return (
    <ScrollView style={ui.screen} keyboardShouldPersistTaps="handled">
      <Text style={ui.h1}>Notes</Text>
      <Text style={ui.sub}>{notes.length} notes · {projects.length} folders</Text>
      <TextInput
        style={ui.search}
        value={q}
        onChangeText={setQ}
        placeholder="Search…"
        placeholderTextColor={dark.faint}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
        <View style={[ui.segRow, { marginBottom: 0 }]}>
          <Pressable onPress={() => setProj(null)} style={[ui.seg, proj === null && ui.segOn]}>
            <Text style={[ui.segText, proj === null && ui.segTextOn]}>All</Text>
          </Pressable>
          {projects.map((p) => (
            <Pressable key={p.id} onPress={() => setProj(proj === p.id ? null : p.id)} style={[ui.seg, proj === p.id && ui.segOn]}>
              <Text style={[ui.segText, proj === p.id && ui.segTextOn]}>{p.name}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <Pressable
        onPress={() => void newNote(proj ? (projects.find((p) => p.id === proj)?.dir ?? '') : '').then(() => {})}
        style={ui.quiet}
      >
        <Text style={ui.quietText}>+ New note{proj ? ` in ${projects.find((p) => p.id === proj)?.name}` : ''}</Text>
      </Pressable>
      <View style={{ height: 6 }} />
      {shown.map((n) => (
        <Pressable key={n.id} onPress={() => onOpen(n.id)} style={ui.rowItem}>
          <Text style={ui.title} numberOfLines={1}>{n.title}</Text>
          <Text style={ui.meta}>{n.path} · {n.tags.map((t) => `#${t}`).join(' ') || 'no tags'}</Text>
          {n.snippet ? <Text style={ui.meta} numberOfLines={2}>{n.snippet}</Text> : null}
        </Pressable>
      ))}
      {shown.length === 0 && <Text style={ui.sub}>No notes match.</Text>}
    </ScrollView>
  );
}
