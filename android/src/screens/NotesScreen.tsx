import React, { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { dark, ui } from '../theme';
import { useStore } from '../lib/store';
import { searchNotesSync } from '../lib/vault';

export function NotesScreen({ onOpen }: { onOpen: (noteId: string) => void }): React.JSX.Element {
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
        placeholderTextColor={dark.muted}
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }}>
        <Pressable onPress={() => setProj(null)} style={[ui.chip, proj === null && ui.chipOn]}>
          <Text style={[ui.chipText, proj === null && ui.chipTextOn]}>All</Text>
        </Pressable>
        {projects.map((p) => (
          <Pressable key={p.id} onPress={() => setProj(proj === p.id ? null : p.id)} style={[ui.chip, proj === p.id && ui.chipOn]}>
            <Text style={[ui.chipText, proj === p.id && ui.chipTextOn]}>{p.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Pressable
        onPress={() => void newNote(proj ? (projects.find((p) => p.id === proj)?.dir ?? '') : '').then(() => {})}
        style={ui.ghostBtn}
      >
        <Text style={ui.ghostText}>+ New note{proj ? ` in ${projects.find((p) => p.id === proj)?.name}` : ''}</Text>
      </Pressable>
      <View style={{ height: 10 }} />
      {shown.map((n) => (
        <Pressable key={n.id} onPress={() => onOpen(n.id)} style={ui.card}>
          <Text style={ui.title} numberOfLines={1}>{n.title}</Text>
          <Text style={ui.meta}>{n.path} · {n.tags.map((t) => `#${t}`).join(' ') || 'no tags'}</Text>
          {n.snippet ? <Text style={[ui.meta, { marginTop: 4 }]} numberOfLines={2}>{n.snippet}</Text> : null}
        </Pressable>
      ))}
      {shown.length === 0 && <Text style={ui.sub}>No notes match.</Text>}
    </ScrollView>
  );
}
