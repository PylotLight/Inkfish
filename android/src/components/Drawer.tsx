import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Dimensions, FlatList, Modal, Pressable, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChevronDown, ChevronRight, FilePlus, Folder, FolderPlus, Plus } from 'lucide-react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';
import { useStore } from '../lib/store';
import { fileLabel } from '../lib/vault';
import type { NoteEntry } from '../lib/format';
import { folderOf } from '../lib/when';

const WIDTH = Math.min(340, Dimensions.get('window').width * 0.85);

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

const fileName = (n: NoteEntry): string => fileLabel(n.path);

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
  const byFile = (a: NoteEntry, b: NoteEntry): number =>
    fileName(a).toLowerCase().localeCompare(fileName(b).toLowerCase());
  const freeze = (m: Mutable): DirNode => {
    const children = [...m.kids.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(freeze);
    return {
      name: m.name,
      rel: m.rel,
      files: [...m.files].sort(byFile),
      children,
      total: m.files.length + children.reduce((a, c) => a + c.total, 0)
    };
  };
  const roots = [...top.values()].sort((a, b) => a.name.localeCompare(b.name)).map(freeze);
  rootFiles.sort(byFile);
  return { roots, rootFiles };
}

type Row =
  | { kind: 'dir'; rel: string; name: string; depth: number; total: number; shut: boolean }
  | { kind: 'file'; id: string; rel: string; name: string; depth: number };

/** Flatten only the visible rows — collapsed subtrees cost nothing to toggle. */
function flatten(roots: DirNode[], rootFiles: NoteEntry[], collapsed: Set<string>): Row[] {
  const out: Row[] = [];
  const walk = (node: DirNode, depth: number): void => {
    const shut = collapsed.has(node.rel);
    out.push({ kind: 'dir', rel: node.rel, name: node.name, depth, total: node.total, shut });
    if (shut) return;
    for (const kid of node.children) walk(kid, depth + 1);
    for (const f of node.files) out.push({ kind: 'file', id: f.id, rel: f.path, name: fileName(f), depth: depth + 1 });
  };
  for (const r of roots) walk(r, 0);
  for (const f of rootFiles) out.push({ kind: 'file', id: f.id, rel: f.path, name: fileName(f), depth: 0 });
  return out;
}

const DirRow = memo(function DirRow({
  row,
  onToggle,
  onCreate,
  onMenu
}: {
  row: Extract<Row, { kind: 'dir' }>;
  onToggle: (rel: string) => void;
  onCreate: (dir: string) => void;
  onMenu: (rel: string, name: string) => void;
}): React.JSX.Element {
  const { ui, c } = useTheme();
  return (
    <View style={[ui.row, { justifyContent: 'space-between', paddingLeft: row.depth * 14 }]}>
      <Pressable
        onPress={() => onToggle(row.rel)}
        onLongPress={() => onMenu(row.rel, row.name)}
        delayLongPress={450}
        style={[ui.row, { flex: 1, gap: 6, paddingVertical: 8 }]}
        accessibilityLabel={row.shut ? `Expand ${row.rel}` : `Collapse ${row.rel}`}
      >
        <Icon as={row.shut ? ChevronRight : ChevronDown} size={16} color={c.faint} />
        <Icon as={Folder} size={17} />
        <Text style={[ui.title, { fontWeight: '600', fontSize: 15, flex: 1 }]} numberOfLines={1}>
          {row.name}
        </Text>
        {row.total > 0 && <Text style={[ui.meta, { marginTop: 0 }]}>{String(row.total)}</Text>}
      </Pressable>
      <Pressable onPress={() => onCreate(row.rel)} style={ui.iconBtn} accessibilityLabel={`New note in ${row.name}`}>
        <Icon as={Plus} size={16} color={c.faint} />
      </Pressable>
    </View>
  );
});

const FileRow = memo(function FileRow({
  row,
  onOpen,
  onMenu
}: {
  row: Extract<Row, { kind: 'file' }>;
  onOpen: (id: string) => void;
  onMenu: (id: string, rel: string, name: string) => void;
}): React.JSX.Element {
  const { ui, c } = useTheme();
  return (
    <Pressable
      onPress={() => onOpen(row.id)}
      onLongPress={() => onMenu(row.id, row.rel, row.name)}
      delayLongPress={450}
      style={{ paddingVertical: 7, paddingLeft: row.depth === 0 ? 0 : row.depth * 14 + 34 }}
    >
      <Text style={[ui.title, { fontSize: 14, fontWeight: '400', color: c.muted }]} numberOfLines={1}>
        {row.name}
      </Text>
    </Pressable>
  );
});

type NameModal =
  | { mode: 'folder'; parent: string }
  | { mode: 'renameFile'; rel: string; current: string }
  | { mode: 'renameDir'; rel: string; current: string };

/**
 * File sidebar (Obsidian-style left drawer): folder tree + all notes,
 * filter search, per-folder new-note. Slides over content with a scrim.
 * Rows are virtualized (FlatList) so opening a folder re-renders one row,
 * not the whole vault. Long-press a row for rename / delete / new folder.
 */
export function Drawer({ open, onClose, onOpenNote }: Props): React.JSX.Element {
  const { ui, c } = useTheme();
  const insets = useSafeAreaInsets();
  const { notes, projects, newNote, createDir, deleteFile, deleteDir, renameFile, renameDir } = useStore();
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<NameModal | null>(null);
  const [name, setName] = useState('');
  const x = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(x, { toValue: open ? 1 : 0, duration: 220, useNativeDriver: true }).start();
  }, [open, x]);

  const toggle = useCallback((rel: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }, []);

  /** Reveal a dir after create/rename: expand its ancestors, open it. */
  const reveal = useCallback((rel: string) => {
    if (!rel) return;
    setCollapsed((prev) => {
      const next = new Set(prev);
      const parts = rel.split('/');
      for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join('/'));
      next.delete(rel);
      return next;
    });
  }, []);

  /** Drop collapse state for a removed/renamed subtree. */
  const prune = useCallback((rel: string, nextRel?: string) => {
    setCollapsed((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const k of prev) {
        if (k === rel || k.startsWith(`${rel}/`)) {
          next.delete(k);
          changed = true;
        }
      }
      if (nextRel) {
        const parts = nextRel.split('/');
        for (let i = 1; i < parts.length; i++) {
          if (next.delete(parts.slice(0, i).join('/'))) changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

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

  const needle = q.trim().toLowerCase();
  const data: Row[] = useMemo(() => {
    if (needle) {
      return notes
        .filter(
          (n) =>
            fileName(n).toLowerCase().includes(needle) ||
            n.title.toLowerCase().includes(needle) ||
            n.snippet.toLowerCase().includes(needle)
        )
        .slice(0, 100)
        .map((n) => ({ kind: 'file', id: n.id, rel: n.path, name: fileName(n), depth: 0 }) as Row);
    }
    return flatten(tree.roots, tree.rootFiles, collapsed);
  }, [notes, needle, tree, collapsed]);

  const fail = useCallback((e: unknown) => {
    Alert.alert('Hmm', e instanceof Error ? e.message : String(e));
  }, []);

  const createIn = useCallback(
    async (dir: string): Promise<void> => {
      try {
        const id = await newNote(dir);
        if (id) onOpenNote(id);
      } catch (e) {
        fail(e);
      }
    },
    [newNote, onOpenNote, fail]
  );

  const submitName = useCallback(async (): Promise<void> => {
    if (!modal) return;
    const value = name.trim();
    if (!value) return;
    try {
      if (modal.mode === 'folder') {
        const rel = await createDir(modal.parent, value);
        reveal(rel);
      } else if (modal.mode === 'renameFile') {
        await renameFile(modal.rel, value);
      } else {
        const next = await renameDir(modal.rel, value);
        prune(modal.rel, next);
        reveal(next);
      }
      setModal(null);
      setName('');
    } catch (e) {
      fail(e);
    }
  }, [modal, name, createDir, renameFile, renameDir, reveal, prune, fail]);

  const askDeleteFile = useCallback(
    (rel: string, label: string) => {
      Alert.alert('Delete note?', `“${label}” moves to Trash — recoverable in Settings.`, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () =>
            void deleteFile(rel).catch((e: unknown) =>
              Alert.alert('Hmm', e instanceof Error ? e.message : String(e))
            )
        }
      ]);
    },
    [deleteFile]
  );

  const askDeleteDir = useCallback(
    (rel: string, label: string, total: number) => {
      Alert.alert(
        'Delete folder?',
        `“${label}”${total > 0 ? ` and its ${total} note${total === 1 ? '' : 's'}` : ''} move${total === 1 ? 's' : ''} to Trash — recoverable in Settings.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Delete',
            style: 'destructive',
            onPress: () =>
              void deleteDir(rel)
                .then(() => prune(rel))
                .catch((e: unknown) => Alert.alert('Hmm', e instanceof Error ? e.message : String(e)))
          }
        ]
      );
    },
    [deleteDir, prune]
  );

  const dirMenu = useCallback(
    (rel: string, label: string) => {
      const node = (function find(rs: DirNode[]): DirNode | null {
        for (const r of rs) {
          if (r.rel === rel) return r;
          const k = find(r.children);
          if (k) return k;
        }
        return null;
      })(tree.roots);
      Alert.alert(label, rel, [
        { text: 'New note here', onPress: () => void createIn(rel) },
        {
          text: 'New folder here',
          onPress: () => {
            setName('');
            setModal({ mode: 'folder', parent: rel });
          }
        },
        {
          text: 'Rename folder',
          onPress: () => {
            setName(label);
            setModal({ mode: 'renameDir', rel, current: label });
          }
        },
        { text: 'Delete folder', style: 'destructive', onPress: () => askDeleteDir(rel, label, node?.total ?? 0) },
        { text: 'Cancel', style: 'cancel' }
      ]);
    },
    [tree, createIn, askDeleteDir]
  );

  const fileMenu = useCallback(
    (_id: string, rel: string, label: string) => {
      Alert.alert(label, folderOf(rel), [
        {
          text: 'Rename',
          onPress: () => {
            setName(label);
            setModal({ mode: 'renameFile', rel, current: label });
          }
        },
        { text: 'Delete', style: 'destructive', onPress: () => askDeleteFile(rel, label) },
        { text: 'Cancel', style: 'cancel' }
      ]);
    },
    [askDeleteFile]
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) =>
      item.kind === 'dir' ? (
        <DirRow row={item} onToggle={toggle} onCreate={(d) => void createIn(d)} onMenu={dirMenu} />
      ) : (
        <FileRow row={item} onOpen={onOpenNote} onMenu={fileMenu} />
      ),
    [toggle, createIn, dirMenu, fileMenu, onOpenNote]
  );

  const keyOf = useCallback((r: Row) => (r.kind === 'dir' ? `d:${r.rel}` : `f:${r.id}`), []);

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
          <View style={[ui.row, { gap: 0 }]}>
            <Pressable
              onPress={() => {
                setName('');
                setModal({ mode: 'folder', parent: '' });
              }}
              style={ui.iconBtn}
              accessibilityLabel="New folder"
            >
              <Icon as={FolderPlus} size={20} />
            </Pressable>
            <Pressable onPress={() => void createIn('')} style={ui.iconBtn} accessibilityLabel="New note">
              <Icon as={FilePlus} size={20} />
            </Pressable>
          </View>
        </View>
        <TextInput
          value={q}
          onChangeText={setQ}
          placeholder="Search files"
          placeholderTextColor={c.faint}
          style={[ui.search, { marginBottom: 8, borderWidth: 0, borderRadius: 10, paddingVertical: 9 }]}
        />
        <FlatList
          data={data}
          keyExtractor={keyOf}
          renderItem={renderItem}
          initialNumToRender={40}
          maxToRenderPerBatch={30}
          windowSize={7}
          removeClippedSubviews
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={<Text style={ui.meta}>{needle ? 'No notes match.' : 'No notes yet.'}</Text>}
          contentContainerStyle={{ paddingBottom: 24 }}
        />
        <Text style={[ui.meta, { marginTop: 4 }]}>Long-press a row for rename · delete · new folder</Text>
      </Animated.View>
      <Modal visible={modal !== null} transparent animationType="fade" onRequestClose={() => setModal(null)}>
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center', padding: 32 }}
          onPress={() => setModal(null)}
        >
          <Pressable
            onPress={() => undefined}
            style={{
              width: '100%',
              backgroundColor: c.barSolid,
              borderWidth: 1,
              borderColor: c.border,
              borderRadius: 14,
              padding: 16
            }}
          >
            <Text style={[ui.title, { fontSize: 16 }]}>
              {modal?.mode === 'folder'
                ? 'New folder'
                : modal?.mode === 'renameFile'
                  ? 'Rename note'
                  : 'Rename folder'}
            </Text>
            {!!modal && modal.mode !== 'renameFile' && modal.mode !== 'renameDir' && (
              <Text style={[ui.meta, { marginTop: 2 }]} numberOfLines={1}>
                {modal.parent || 'Vault'}
              </Text>
            )}
            <TextInput
              value={name}
              onChangeText={setName}
              autoFocus
              autoCorrect={false}
              placeholder={modal?.mode === 'folder' ? 'Folder name' : 'Name'}
              placeholderTextColor={c.faint}
              onSubmitEditing={() => void submitName()}
              style={[ui.search, { marginTop: 12, marginBottom: 0 }]}
            />
            <View style={[ui.row, { justifyContent: 'flex-end', gap: 4, marginTop: 8 }]}>
              <Pressable
                onPress={() => {
                  setModal(null);
                  setName('');
                }}
                style={[ui.quiet, { paddingVertical: 10 }]}
              >
                <Text style={ui.quietMuted}>Cancel</Text>
              </Pressable>
              <Pressable onPress={() => void submitName()} style={[ui.quiet, { paddingVertical: 10 }]}>
                <Text style={ui.quietText}>{modal?.mode === 'folder' ? 'Create' : 'Rename'}</Text>
              </Pressable>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}
