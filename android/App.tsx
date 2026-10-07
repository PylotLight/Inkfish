import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View } from 'react-native';
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

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'capture', label: '✎' },
  { id: 'inbox', label: '📥' },
  { id: 'notes', label: '🗂' },
  { id: 'today', label: '📅' },
  { id: 'settings', label: '⚙' }
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
          <ActivityIndicator color={dark.accent} />
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
      {!openId && (
        <View style={styles.tabs}>
          {TABS.map((t) => (
            <Pressable key={t.id} onPress={() => setTab(t.id)} style={[styles.tab, tab === t.id && styles.tabOn]}>
              <Text style={[styles.tabText, tab === t.id && styles.tabTextOn]}>
                {t.label}
                {t.id === 'inbox' && pending > 0 ? ` ${pending}` : ''}
              </Text>
            </Pressable>
          ))}
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
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 8 },
  muted: { color: dark.muted },
  errBar: { backgroundColor: '#3a1d22', padding: 8 },
  errText: { color: dark.danger, fontSize: 12 },
  tabs: { flexDirection: 'row', borderTopWidth: 1, borderTopColor: dark.border, backgroundColor: dark.card },
  tab: { flex: 1, paddingVertical: 14, alignItems: 'center' },
  tabOn: { backgroundColor: dark.card2 },
  tabText: { color: dark.muted, fontSize: 20 },
  tabTextOn: { color: dark.text }
});
