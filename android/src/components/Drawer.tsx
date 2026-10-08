import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Dimensions, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, FilePlus, Folder, Plus } from 'lucide-react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import type { NoteEntry } from '../lib/format';
import { folderOf } from '../lib/when';

const WIDTH = Math.min(340, Dimensions.get('window').width * 0.85);

/** File rows sit under a folder header (chevron + folder icon) — indent to
 *  the folder label so notes read as children, not siblings. */
const FILE_INDENT = 45;

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenNote: (noteId: string) => void;
}

interface DirNode {
  name: string;
  /** Vault-relative dir, e.g. `personal/cairns-2026`. */
  rel: string;
  files: NoteEntry[];
  children: DirNode[];
  total: number;
}

/** Nested dir tree from vault-relative paths — mirrors desktop `buildTree`. */
function buildTree(notes: NoteEntry[]): { roots: DirNode[]; rootFiles: NoteEntry[] } {
  interface Mutable {
    name: string;
    rel: string;
    files: NoteEntry[];
    kids: Map<string, Mutable>;
  }
  const top = new Map<string, Mutable>();
  const rootFiles: NoteEntry[] = [];
  for (const n of notes) {
    const parts = n.path.split('/');
    if (parts.length <= 1) {
      rootFiles.push(n);
      continue;
    }
    let level = top;
    let rel = '';
    let node: Mutable | undefined;
    for (const d of parts.slice(0, -1)) {
      rel = rel ? `${rel}/${d}` : d;
      node = level.get(d);
      if (!node) {
        node = { name: d, rel, files: [], kids: new Map() };
        level.set(d, node);
      }
      level = node.kids;
    }
    node?.files.push(n);
  }
  const freeze = (m: Mutable): DirNode => {
    const children = [...m.kids.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(freeze);
    const files = [...m.files].sort((a, b) => a.title.localeCompare(b.title));
    return {
      name: m.name,
      rel: m.rel,
      files,
      children,
      total: m.files.length + children.reduce((a, c) => a + c.total, 0)
    };
  };
  const roots = [...top.values()].sort((a, b) => a.name.localeCompare(b.name)).map(freeze);
  rootFiles.sort((a, b) => a.title.localeCompare(b.title));
  return { roots, rootFiles };
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

  const needle = q.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!needle) return null;
    return notes
      .filter((n) => n.title.toLowerCase().includes(needle) || n.snippet.toLowerCase().includes(needle))
      .slice(0, 400);
  }, [notes, needle]);

  const tree = useMemo(() => {
    const t = buildTree(notes.slice(0, 2000));
    // Empty top-level projects still get a header so they don't vanish.
    const have = new Set(t.roots.map((r) => r.rel));
    for (const p of projects) {
      if (!have.has(p.dir)) {
        t.roots.push({ name: p.name, rel: p.dir, files: [], children: [], total: 0 });
        have.add(p.dir);
      }
    }
    t.roots.sort((a, b) => a.name.localeCompare(b.name));
    return t;
  }, [notes, projects]);

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
          {searchResults !== null ? (
            <>
              {searchResults.length === 0 && <Text style={ui.meta}>No notes match.</Text>}
              {searchResults.map((n) => (
                <Pressable key={n.id} onPress={() => onOpenNote(n.id)} style={{ paddingVertical: 7 }}>
                  <Text style={[ui.title, { fontSize: 15, fontWeight: '400' }]} numberOfLines={1}>{n.title}</Text>
                  <Text style={ui.meta} numberOfLines={1}>{folderOf(n.path)}</Text>
                </Pressable>
              ))}
            </>
          ) : (
            <>
              {tree.roots.map((r) => (
                <DirView
                  key={r.rel}
                  node={r}
                  collapsed={collapsed}
                  onToggle={(rel) => setCollapsed((m) => ({ ...m, [rel]: !m[rel] }))}
                  onOpenNote={onOpenNote}
                  onCreateIn={createIn}
                />
              ))}
              {tree.rootFiles.map((n) => (
                <Pressable key={n.id} onPress={() => onOpenNote(n.id)} style={{ paddingVertical: 7 }}>
                  <Text style={[ui.title, { fontWeight: '400', color: c.muted }]} numberOfLines={1}>{n.title}</Text>
                </Pressable>
              ))}
              {tree.roots.length === 0 && tree.rootFiles.length === 0 && (
                <Text style={ui.meta}>No notes yet.</Text>
              )}
            </>
          )}
          <View style={{ height: 24 }} />
        </ScrollView>
      </Animated.View>
    </View>
  );
}

function DirView({
  node,
  collapsed,
  onToggle,
  onOpenNote,
  onCreateIn
}: {
  node: DirNode;
  collapsed: Record<string, boolean>;
  onToggle: (rel: string) => void;
  onOpenNote: (id: string) => void;
  onCreateIn: (dir: string) => void;
}): React.JSX.Element {
  const { ui, c } = useTheme();
  const shut = collapsed[node.rel] ?? false;
  return (
    <View>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Pressable
          onPress={() => onToggle(node.rel)}
          style={[ui.row, { flex: 1, gap: 6, paddingVertical: 8 }]}
          accessibilityLabel={shut ? `Expand ${node.rel}` : `Collapse ${node.rel}`}
        >
          <Icon as={shut ? ChevronRight : ChevronDown} size={16} color={c.faint} />
          <Icon as={Folder} size={17} />
          <Text style={[ui.title, { fontWeight: '600', fontSize: 15, flex: 1 }]} numberOfLines={1}>{node.name}</Text>
          <Text style={[ui.meta, { marginTop: 0 }]}>{node.total > 0 ? String(node.total) : ''}</Text>
        </Pressable>
        <Pressable onPress={() => void onCreateIn(node.rel)} style={ui.iconBtn} accessibilityLabel={`New note in ${node.name}`}>
          <Icon as={Plus} size={16} color={c.faint} />
        </Pressable>
      </View>
      {!shut && (
        <View style={{ marginLeft: 11, paddingLeft: 8, borderLeftWidth: 1, borderLeftColor: c.border }}>
          {node.children.map((kid) => (
            <DirView
              key={kid.rel}
              node={kid}
              collapsed={collapsed}
              onToggle={onToggle}
              onOpenNote={onOpenNote}
              onCreateIn={onCreateIn}
            />
          ))}
          {node.files.map((n) => (
            <Pressable key={n.id} onPress={() => onOpenNote(n.id)} style={{ paddingVertical: 7, paddingLeft: FILE_INDENT }}>
              <Text style={[ui.title, { fontSize: 14, fontWeight: '400', color: c.muted }]} numberOfLines={1}>{n.title}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}
