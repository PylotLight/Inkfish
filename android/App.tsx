import React, { useEffect, useRef, useState } from 'react';
import { Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
import { BlurView } from 'expo-blur';
import Constants from 'expo-constants';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { StoreProvider, useStore } from './src/lib/store';
import { toPendingShare, type PendingShare } from './src/lib/share';
import { dark } from './src/theme';
import { CaptureScreen } from './src/screens/CaptureScreen';
import { InboxScreen } from './src/screens/InboxScreen';
import { NotesScreen } from './src/screens/NotesScreen';
import { EditorScreen } from './src/screens/EditorScreen';
import { DailyScreen } from './src/screens/DailyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'capture' | 'inbox' | 'notes' | 'today' | 'settings';

// Monochrome text glyphs (no emoji): quiet like Obsidian's icon bar.
const TABS: Array<{ id: Tab; glyph: string }> = [
  { id: 'capture', glyph: '✎' },
  { id: 'inbox', glyph: '▤' },
  { id: 'notes', glyph: '☰' },
  { id: 'today', glyph: '◷' },
  { id: 'settings', glyph: '⚙' }
];

function Shell(): React.JSX.Element {
  const { ready, error, inbox } = useStore();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [tab, setTab] = useState<Tab>('capture');
  // Selected doc id: a routed note id OR an inbox item id (editor handles both).
  const [openId, setOpenId] = useState<string | null>(null);
  const [shared, setShared] = useState<PendingShare | null>(null);
  const shareSeen = useRef(false);

  // A fresh share jumps to Capture with the composer prefilled. Consuming
  // (save or dismiss) resets the native module so it isn't offered twice.
  useEffect(() => {
    if (!hasShareIntent || shareSeen.current) return;
    const pending = toPendingShare(
      {
        text: shareIntent?.text,
        webUrl: shareIntent?.webUrl,
        meta: shareIntent?.meta,
        files: shareIntent?.files
      },
      `${Date.now()}`
    );
    if (!pending) {
      resetShareIntent();
      return;
    }
    shareSeen.current = true;
    setShared(pending);
    setOpenId(null);
    setTab('capture');
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  const consumeShared = (): void => {
    shareSeen.current = false;
    setShared(null);
    resetShareIntent();
  };

  if (!ready) {
    return (
      <SafeAreaView style={styles.safe}>
        <View style={styles.loading}>
          <Text style={styles.muted}>Opening vault…</Text>
        </View>
      </SafeAreaView>
    );
  }

  const pending = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length;

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor={dark.bg} />
      {error && (
        <View style={styles.errBar}>
          <Text style={styles.errText}>{error}</Text>
        </View>
      )}
      <View style={styles.body}>
        {openId ? (
          <EditorScreen noteId={openId} onClose={() => setOpenId(null)} />
        ) : tab === 'capture' ? (
          <CaptureScreen onSaved={() => setTab('inbox')} shared={shared} onSharedConsumed={consumeShared} />
        ) : tab === 'inbox' ? (
          <InboxScreen onOpen={(id) => setOpenId(id)} />
        ) : tab === 'notes' ? (
          <NotesScreen onOpen={(id) => setOpenId(id)} />
        ) : tab === 'today' ? (
          <DailyScreen />
        ) : (
          <SettingsScreen />
        )}
      </View>
      {/* Floating glass toolbar (Obsidian-style). Hidden in the editor for
          distraction-free reading — the editor has its own back action. */}
      {!openId && (
        <View style={styles.barWrap}>
          <BlurView intensity={70} tint="dark" style={styles.bar}>
            {TABS.map((t) => {
              const on = tab === t.id;
              return (
                <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, on && styles.tabOn]}>
                  <Text style={[styles.glyph, on && styles.glyphOn]}>{t.glyph}</Text>
                  {t.id === 'inbox' && pending > 0 && <Text style={styles.badge}>{pending}</Text>}
                </Pressable>
              );
            })}
          </BlurView>
        </View>
      )}
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element {
  // The share native module doesn't exist in Expo Go — disable it there so
  // day-to-day development keeps working; the release APK has it enabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disabled = (Constants as any).appOwnership === 'expo';
  return (
    <ShareIntentProvider options={{ disabled }}>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ShareIntentProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: dark.bg },
  body: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  muted: { color: dark.muted },
  errBar: { backgroundColor: '#3a1d22', padding: 8 },
  errText: { color: dark.danger, fontSize: 12 },
  barWrap: {
    position: 'absolute',
    left: 52,
    right: 52,
    bottom: 22
  },
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: dark.border,
    overflow: 'hidden',
    paddingVertical: 6,
    backgroundColor: 'rgba(16,18,24,0.55)'
  },
  tab: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999
  },
  tabOn: { backgroundColor: 'rgba(126,226,168,0.14)' },
  glyph: { color: dark.muted, fontSize: 21 },
  glyphOn: { color: dark.accent },
  badge: { color: dark.accent, fontSize: 11, fontWeight: '700', marginLeft: 4 }
});
