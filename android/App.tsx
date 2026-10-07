import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import Constants from 'expo-constants';
import { ShareIntentProvider, useShareIntentContext } from 'expo-share-intent';
import { StoreProvider, useStore } from './src/lib/store';
import { PrefsProvider, usePrefs } from './src/lib/prefs';
import { toPendingShare, type PendingShare } from './src/lib/share';
import { useTheme } from './src/theme';
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
  const { prefs } = usePrefs();
  const t = useTheme();
  const insets = useSafeAreaInsets();
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
      <View style={[t.ui.center, { paddingTop: insets.top }]}>
        <Text style={{ color: t.c.muted }}>Opening vault…</Text>
      </View>
    );
  }

  const pending = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length;

  const tabs = TABS.map((tb) => {
    const on = tab === tb.id;
    return (
      <Pressable key={tb.id} onPress={() => setTab(tb.id)} style={[t.ui.tab, on && t.ui.tabOn]}>
        <Text style={[t.ui.glyph, on && t.ui.glyphOn]}>{tb.glyph}</Text>
        {tb.id === 'inbox' && pending > 0 && <Text style={t.ui.badge}>{pending}</Text>}
      </Pressable>
    );
  });

  return (
    <View style={[styles.safe, { backgroundColor: t.c.bg }]}>
      <StatusBar barStyle={t.statusBar} backgroundColor={t.c.bg} />
      {error && (
        <View style={[styles.errBar, { paddingTop: insets.top }]}>
          <Text style={[styles.errText, { color: t.c.danger }]}>{error}</Text>
        </View>
      )}
      <View style={{ flex: 1, paddingTop: insets.top }}>
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
        <View style={[t.ui.barWrap, { bottom: insets.bottom + 14 }]}>
          {prefs.blur ? (
            <BlurView intensity={70} tint={t.blurTint} style={t.ui.bar}>
              {tabs}
            </BlurView>
          ) : (
            <View style={[t.ui.bar, { backgroundColor: t.c.barSolid }]}>{tabs}</View>
          )}
        </View>
      )}
    </View>
  );
}

export default function App(): React.JSX.Element {
  // The share native module doesn't exist in Expo Go — disable it there so
  // day-to-day development keeps working; the release APK has it enabled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const disabled = (Constants as any).appOwnership === 'expo';
  return (
    <SafeAreaProvider>
      <PrefsProvider>
        <ShareIntentProvider options={{ disabled }}>
          <StoreProvider>
            <Shell />
          </StoreProvider>
        </ShareIntentProvider>
      </PrefsProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  errBar: { padding: 8 },
  errText: { fontSize: 12 }
});
