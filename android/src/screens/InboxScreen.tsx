import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ui } from '../theme';
import { useStore } from '../lib/store';

export function InboxScreen({ onOpen }: { onOpen: (inboxId: string) => void }): React.JSX.Element {
  const { inbox, projects, routeInbox, undoInbox, refresh } = useStore();
  const pending = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing');

  return (
    <ScrollView style={ui.screen}>
      <Text style={ui.h1}>Inbox</Text>
      <Text style={ui.sub}>{pending.length > 0 ? `${pending.length} waiting` : 'Inbox zero 🎉'}</Text>
      {inbox.length === 0 && <Text style={ui.sub}>Nothing yet — capture something.</Text>}
      {inbox.map((item) => (
        <View key={item.id} style={ui.card}>
          <Pressable onPress={() => onOpen(item.id)}>
            <Text style={ui.meta}>{item.kind} · {new Date(item.createdAt).toLocaleDateString()}</Text>
            <Text style={ui.title} numberOfLines={2}>{item.raw.split('\n')[0]?.slice(0, 120) || '(empty)'}</Text>
            <Text style={ui.pill}>{item.status === 'processing' ? 'routing…' : item.status}</Text>
          </Pressable>
          <View style={[ui.row, { marginTop: 8, flexWrap: 'wrap', gap: 8 }]}>
            {item.status !== 'processing' && (
              <Pressable
                onPress={() => void routeInbox(item.id).then(refresh)}
                style={[ui.chip]}
              >
                <Text style={ui.chipText}>Route</Text>
              </Pressable>
            )}
            {item.status === 'ready' && (
              <Pressable onPress={() => void undoInbox(item.id)} style={[ui.chip]}>
                <Text style={ui.chipText}>Undo</Text>
              </Pressable>
            )}
          </View>
          {projects.length > 0 && item.status !== 'processing' && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
              {projects.map((p) => (
                <Pressable key={p.id} onPress={() => void routeInbox(item.id, p.name).then(refresh)} style={ui.chip}>
                  <Text style={ui.chipText}>→ {p.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      ))}
    </ScrollView>
  );
}
