import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, FilePlus, Folder, Plus } from 'lucide-react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { useStore } from '../lib/store';

const WIDTH = Math.min(340, Dimensions.get('window').width * 0.85);

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
}

/**
 * File sidebar (Obsidian-style left drawer): folder tree + all notes,
 * filter search, per-folder new-note. Slides over content with a scrim.
 */
export function Drawer({ open, onClose, onOpenNote }: Props): React.JSX.Element {
  const { ui, c } = useTheme();
  const insets = useSafeAreaInsets();
  const { notes, projects, newNote } = useStore();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }).start();
  }, [open, x]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (t: string, s?: string): boolean =>
      !needle || t.toLowerCase().includes(needle) || (s ?? '').toLowerCase().includes(needle);
    const list = notes.filter((n) => match(n.title, n.snippet)).slice(0, 400);
    const byProj = new Map<string, typeof list>();
    const rest: typeof list = [];
    for (const n of list) {
      if (n.projectId && projects.some((p) => p.id === n.projectId)) {
        const arr = byProj.get(n.projectId) ?? [];
        arr.push(n);
        byProj.set(n.projectId, arr);
      } else rest.push(n);
    }
    return { byProj, rest, total: list.length };
  }, [notes, projects, q]);

  async function createIn(dir: string): Promise<void> {
    try {
      const id = await newNote(dir);
      if (id) onOpenNote(id);
    } catch {
      // store surfaces the error
    }
  }

  const translateX = x.interpolate({ inputRange: [0, 1], outputRange: [-WIDTH - 24, 0] });
  const scrimOpacity = x.interpolate({ inputRange: [0, 1], outputRange: [0, 0.5] });

  return (
    <View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 }} pointerEvents={open ? 'auto' : 'none'}>
      <Animated.View style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, backgroundColor: '#000', opacity: scrimOpacity }}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: 0,
          width: WIDTH,
          transform: [{ translateX }],
          backgroundColor: c.barSolid,
          borderRightWidth: 1,
          borderRightColor: c.border,
          paddingTop: insets.top + 8,
          paddingBottom: insets.bottom + 16,
          paddingHorizontal: 16
        }}
      >
        <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
          <Text style={[ui.title, { fontSize: 18 }]}>Inkfish</Text>
          <Pressable onPress={() => void createIn('')} style={ui.iconBtn} accessibilityLabel="New note">
            <Icon as={FilePlus} size={20} />
          </Pressable>
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search files"
          placeholderTextColor={c.faint}
          style={[ui.search, { marginBottom: 8, borderWidth: 0, borderRadius: 10, paddingVertical: 9 }]}
        />
        <ScrollView keyboardShouldPersistTaps="handled">
          {projects.map((p) => {
            const items = groups.byProj.get(p.id) ?? [];
            const shut = collapsed[p.id] ?? false;
            if (items.length === 0 && q.trim()) return null;
            return (
              <View key={p.id}>
                <View style={[ui.row, { justifyContent: 'space-between' }]}>
                  <Pressable
                    onPress={() => setCollapsed((m) => ({ ...m, [p.id]: !shut }))}
                    style={[ui.row, { flex: 1, gap: 6, paddingVertical: 8 }]}
                  >
                    <Icon as={shut ? ChevronRight : ChevronDown} size={16} color={c.faint} />
                    <Icon as={Folder} size={17} />
                    <Text style={[ui.title, { fontWeight: '500' }]}>{p.name}</Text>
                    <Text style={[ui.meta, { marginTop: 0 }]}>{items.length}</Text>
                  </Pressable>
                  <Pressable onPress={() => void createIn(p.dir)} style={ui.iconBtn} accessibilityLabel={`New note in ${p.name}`}>
                    <Icon as={Plus} size={16} color={c.faint} />
                  </Pressable>
                </View>
                {!shut &&
                  items.map((n) => (
                    <Pressable key={n.id} onPress={() => onOpenNote(n.id)} style={{ paddingVertical: 7, paddingLeft: 45 }}>
                      <Text style={[ui.title, { fontWeight: '400', color: c.muted }]} numberOfLines={1}>{n.title}</Text>
                    </Pressable>
                  ))}
              </View>
            );
          })}
          {groups.rest.length > 0 && (
            <View>
              <Text style={[ui.label, { marginTop: 14 }]}>Other notes</Text>
              {groups.rest.map((n) => (
                <Pressable key={n.id} onPress={() => onOpenNote(n.id)} style={{ paddingVertical: 7 }}>
                  <Text style={[ui.title, { fontWeight: '400', color: c.muted }]} numberOfLines={1}>{n.title}</Text>
                </Pressable>
              ))}
            </View>
          )}
          {groups.total === 0 && <Text style={ui.meta}>No notes match.</Text>}
          <View style={{ height: 24 }} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}
