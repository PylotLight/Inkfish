import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { AudioLines, CheckCircle2, Circle, Ellipsis, Image as ImageIcon, Loader } from 'lucide-react-native';
import { useTheme } from '../theme';
import { ScreenHead } from '../components/ScreenHead';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { when } from '../lib/when';
import type { InboxItem } from '../lib/format';

/**
 * Inbox — two quiet groups (Waiting, Filed). Each row is one line of text
 * with a status glyph; the routing actions hide behind ⋯ instead of
 * sitting under every item as a wall of links.
 */
export function InboxScreen({ onOpen, onMenu }: { onOpen: (inboxId: string) => void; onMenu: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  const { inbox, projects, routeInbox, undoInbox, refresh } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const waiting = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing');
  const filed = inbox.filter((i) => i.status === 'ready');

  const row = (item: InboxItem): React.JSX.Element => {
    const routing = item.status === 'processing';
    const done = item.status === 'ready';
    const glyph = routing ? Loader : done ? CheckCircle2 : item.kind === 'voice' ? AudioLines : item.kind === 'image' ? ImageIcon : Circle;
    const expanded = open === item.id;
    return (
      <View key={item.id}>
        <View style={ui.listRow}>
          <Icon as={glyph} size={18} color={done ? c.faint : c.accent} />
          <Pressable style={ui.listText} onPress={() => onOpen(item.id)}>
            <Text style={[ui.title, done && { color: c.muted, fontWeight: '500' }]} numberOfLines={1}>
              {item.raw.split('\n')[0]?.slice(0, 120) || 'Untitled'}
            </Text>
            <Text style={[ui.meta, { marginTop: 1 }]}>
              {[item.kind !== 'text' ? item.kind : '', when(item.createdAt), routing ? 'routing…' : ''].filter(Boolean).join(' · ')}
            </Text>
          </Pressable>
          {!routing && (
            <Pressable onPress={() => setOpen(expanded ? null : item.id)} style={ui.iconBtn} accessibilityLabel="Actions">
              <Icon as={Ellipsis} size={18} color={expanded ? c.accent : c.faint} />
            </Pressable>
          )}
        </View>
        {expanded && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginLeft: 26, marginBottom: 8 }}>
            <Pressable
              onPress={() => {
                setOpen(null);
                void routeInbox(item.id).then(refresh);
              }}
              style={ui.chip}
            >
              <Text style={ui.chipTextOn}>Auto-route</Text>
            </Pressable>
            {projects.map((p) => (
              <Pressable
                key={p.id}
                onPress={() => {
                  setOpen(null);
                  void routeInbox(item.id, p.name).then(refresh);
                }}
                style={ui.chip}
              >
                <Text style={ui.chipText}>{p.name}</Text>
              </Pressable>
            ))}
            {done && (
              <Pressable
                onPress={() => {
                  setOpen(null);
                  void undoInbox(item.id);
                }}
                style={ui.chip}
              >
                <Text style={[ui.chipText, { color: c.danger }]}>Undo</Text>
              </Pressable>
            )}
          </ScrollView>
        )}
      </View>
    );
  };

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.scrollPad}>
      <ScreenHead title="Inbox" onMenu={onMenu} />
      {inbox.length === 0 && <Text style={[ui.meta, { marginTop: 12 }]}>Nothing captured yet.</Text>}
      {waiting.length > 0 && <Text style={[ui.label, { marginTop: 4 }]}>Waiting · {waiting.length}</Text>}
      {waiting.map(row)}
      {filed.length > 0 && <Text style={[ui.label, waiting.length === 0 && { marginTop: 4 }]}>Filed</Text>}
      {filed.map(row)}
    </ScrollView>
  );
}
