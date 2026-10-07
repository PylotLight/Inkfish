import React from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';

export function InboxScreen({ onOpen }: { onOpen: (inboxId: string) => void }): React.JSX.Element {
  const { ui } = useTheme();
  const { inbox, projects, routeInbox, undoInbox, refresh } = useStore();
  const pending = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing');

  return (
    <ScrollView style={ui.screen}>
      <Text style={ui.h1}>Inbox</Text>
      <Text style={ui.sub}>{pending.length > 0 ? `${pending.length} waiting` : 'Inbox zero'}</Text>
      {inbox.length === 0 && <Text style={ui.sub}>Nothing yet — capture something.</Text>}
      {inbox.map((item) => {
        const routing = item.status === 'processing';
        return (
        <View key={item.id} style={ui.rowItem}>
          <Pressable onPress={() => onOpen(item.id)}>
            <Text style={ui.meta}>{item.kind} · {new Date(item.createdAt).toLocaleDateString()}</Text>
            <Text style={ui.title} numberOfLines={2}>{item.raw.split('\n')[0]?.slice(0, 120) || '(empty)'}</Text>
            <Text style={routing ? ui.statusDim : ui.status}>
              {routing ? 'routing…' : item.status}
            </Text>
          </Pressable>
          {!routing && (
            <View style={[ui.row, { marginTop: 4 }]}>
              <Pressable onPress={() => void routeInbox(item.id).then(refresh)} style={ui.quiet}>
                <Text style={ui.quietText}>Route</Text>
              </Pressable>
              {item.status === 'ready' && (
                <Pressable onPress={() => void undoInbox(item.id)} style={ui.quiet}>
                  <Text style={ui.quietMuted}>Undo</Text>
                </Pressable>
              )}
            </View>
          )}
          {projects.length > 0 && !routing && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              <View style={ui.row}>
                {projects.map((p) => (
                  <Pressable key={p.id} onPress={() => void routeInbox(item.id, p.name).then(refresh)} style={ui.quiet}>
                    <Text style={ui.quietMuted}>→ {p.name}</Text>
                  </Pressable>
                ))}
              </View>
            </ScrollView>
          )}
        </View>
        );
      })}
    </ScrollView>
  );
}
