import React, { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { AudioLines, ArrowDownToLine, ChevronRight, FileText, Image as ImageIcon, Inbox, Mic, Search, Sun, X } from 'lucide-react-native';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import { useUpdates } from '../lib/updates';
import { searchNotesSync } from '../lib/vault';
import { folderOf, longDate, when } from '../lib/when';
import type { NoteKind } from '../lib/format';
import { ScreenHead } from '../components/ScreenHead';
import { Icon } from '../components/Icon';

interface Props {
  onMenu: () => void;
  onOpen: (id: string) => void;
  onCompose: (opts?: { voice?: boolean }) => void;
  onInbox: () => void;
  onToday: () => void;
  onUpdates: () => void;
}

const KIND_ICON: Record<NoteKind, typeof FileText> = {
  text: FileText,
  voice: AudioLines,
  image: ImageIcon,
  meeting: AudioLines
};

/**
 * Home — the landing page. One glance: today's date, a capture line, what's
 * waiting in the inbox, today's log, and recently edited notes. Flat rows
 * and quiet labels (Obsidian's file list), accent only on the live bits.
 * Search lives in the top bar and swaps the page for results in place.
 */
export function HomeScreen({ onMenu, onOpen, onCompose, onInbox, onToday, onUpdates }: Props): React.JSX.Element {
  const { ui, c } = useTheme();
  const { inbox, notes, readDaily } = useStore();
  const upd = useUpdates();
  const [query, setQuery] = useState<string | null>(null);
  const [todayLines, setTodayLines] = useState<string[]>([]);

  const pending = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing');
  const recent = useMemo(() => notes.slice(0, 8), [notes]);
  const results = useMemo(() => (query ? searchNotesSync(notes, query) : []), [notes, query]);

  // Today preview: the last few logged entries (section bodies, newest last).
  useEffect(() => {
    void readDaily().then(({ body }) => {
      const entries = body
        .split(/^##\s+/m)
        .slice(1)
        .map((sec) => {
          const [head, ...rest] = sec.split('\n');
          const text = rest.join(' ').replace(/\s+/g, ' ').trim();
          return `${(head ?? '').trim()}  ${text}`;
        });
      setTodayLines(entries.slice(-3));
    });
  }, [readDaily, notes, inbox]);

  if (query !== null) {
    return (
      <View style={ui.screen}>
        <View style={[ui.topBar, { marginHorizontal: -10 }]}>
          <Pressable onPress={() => setQuery(null)} style={ui.iconBtn} accessibilityLabel="Close search">
            <Icon as={X} />
          </Pressable>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search notes"
            placeholderTextColor={c.faint}
            style={[ui.inputText, { fontSize: 17 }]}
            autoFocus
            returnKeyType="search"
          />
        </View>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={ui.scrollPad}>
          {query.trim() && results.length === 0 && <Text style={[ui.meta, { marginTop: 12 }]}>No matches.</Text>}
          {results.map((n) => (
            <Pressable key={n.id} onPress={() => onOpen(n.id)} style={ui.listRow}>
              <Icon as={KIND_ICON[n.kind] ?? FileText} size={18} color={c.faint} />
              <View style={ui.listText}>
                <Text style={ui.title} numberOfLines={1}>{n.title}</Text>
                <Text style={ui.meta} numberOfLines={1}>{n.snippet || folderOf(n.path)}</Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.scrollPad} keyboardShouldPersistTaps="handled">
      <ScreenHead title="" onMenu={onMenu} actions={[{ icon: Search, label: 'Search', onPress: () => setQuery('') }]} />

      <Text style={ui.display}>{longDate()}</Text>
      {upd.release && (upd.status === 'available' || upd.status === 'ready' || upd.status === 'downloading') && (
        <Pressable onPress={onUpdates} style={[ui.row, { gap: 6, marginTop: 6 }]} accessibilityLabel="Update available">
          <Icon as={ArrowDownToLine} size={14} color={c.accent} />
          <Text style={[ui.meta, { marginTop: 0, color: c.accent }]}>Inkfish {upd.release.version} is available</Text>
        </Pressable>
      )}

      {/* Capture line — opens the full composer; the mic starts a voice memo. */}
      <View style={[ui.inputLine, { marginTop: 18 }]}>
        <Pressable style={{ flex: 1 }} onPress={() => onCompose()} accessibilityLabel="New capture">
          <Text style={[ui.inputText, { color: c.faint }]}>Capture a thought…</Text>
        </Pressable>
        <Pressable onPress={() => onCompose({ voice: true })} style={ui.iconBtn} accessibilityLabel="Record voice memo">
          <Icon as={Mic} size={20} />
        </Pressable>
      </View>

      {/* Inbox */}
      <Pressable onPress={onInbox} style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.label}>Inbox</Text>
        <Text style={[ui.label, { color: pending.length ? c.accent : c.faint }]}>
          {pending.length ? `${pending.length} waiting` : 'All sorted'}
        </Text>
      </Pressable>
      {pending.slice(0, 3).map((i) => (
        <Pressable key={i.id} onPress={() => onOpen(i.id)} style={ui.listRow}>
          <Icon as={Inbox} size={18} color={c.faint} />
          <View style={ui.listText}>
            <Text style={ui.title} numberOfLines={1}>{i.raw.split('\n')[0] || 'Untitled'}</Text>
          </View>
          <Text style={ui.meta}>{when(i.createdAt)}</Text>
        </Pressable>
      ))}

      {/* Today */}
      <Pressable onPress={onToday} style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.label}>Today</Text>
        <Icon as={ChevronRight} size={16} color={c.faint} />
      </Pressable>
      {todayLines.length === 0 ? (
        <Pressable onPress={onToday} style={ui.listRow}>
          <Icon as={Sun} size={18} color={c.faint} />
          <Text style={[ui.meta, { marginTop: 0 }]}>Nothing logged yet</Text>
        </Pressable>
      ) : (
        todayLines.map((l, k) => (
          <Pressable key={k} onPress={onToday} style={[ui.listRow, { paddingVertical: 7 }]}>
            <Text style={[ui.meta, { marginTop: 0, width: 40, fontVariant: ['tabular-nums'] }]}>{l.slice(0, 5)}</Text>
            <Text style={[ui.title, { flex: 1, fontWeight: '400' }]} numberOfLines={1}>{l.slice(5).trim()}</Text>
          </Pressable>
        ))
      )}

      {/* Recent */}
      <Text style={ui.label}>Recent</Text>
      {recent.length === 0 && <Text style={ui.meta}>Notes you write or route show up here.</Text>}
      {recent.map((n) => (
        <Pressable key={n.id} onPress={() => onOpen(n.id)} style={ui.listRow}>
          <Icon as={KIND_ICON[n.kind] ?? FileText} size={18} color={c.faint} />
          <View style={ui.listText}>
            <Text style={ui.title} numberOfLines={1}>{n.title}</Text>
            <Text style={[ui.meta, { marginTop: 1 }]} numberOfLines={1}>{folderOf(n.path)}</Text>
          </View>
          <Text style={ui.meta}>{when(n.updatedAt)}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
