import React, { useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import { CalendarDays, House, Inbox, Plus, Settings, type LucideIcon } from 'lucide-react-native';
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
import { HomeScreen } from './src/screens/HomeScreen';
import { Icon } from './src/components/Icon';
import { Drawer } from './src/components/Drawer';
import { EditorScreen } from './src/screens/EditorScreen';
import { DailyScreen } from './src/screens/DailyScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

type Tab = 'home' | 'inbox' | 'today' | 'settings';

// Lucide line icons (Obsidian's set). Capture is the centre +, not a tab:
// it opens as a full-screen sheet over whatever you were looking at.
// Notes live in the file drawer, not the toolbar.
const TABS: Array<{ id: Tab; icon: LucideIcon; label: string }> = [
  { id: 'home', icon: House, label: 'Home' },
  { id: 'inbox', icon: Inbox, label: 'Inbox' },
  { id: 'today', icon: CalendarDays, label: 'Today' },
  { id: 'settings', icon: Settings, label: 'Settings' }
];

function Shell(): React.JSX.Element {
  const { ready, error, inbox } = useStore();
  const { prefs } = usePrefs();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const [tab, setTab] = useState<Tab>('home');
  const [composing, setComposing] = useState<{ voice: boolean } | null>(null);
  // Selected doc id: a routed note id OR an inbox item id (editor handles both).
  const [openId, setOpenId] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
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
    setComposing({ voice: false });
  }, [hasShareIntent, shareIntent, resetShareIntent]);

  // Android back: drawer → capture sheet → editor → Home tab → exit.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (drawer) setDrawer(false);
      else if (composing) setComposing(null);
      else if (openId) setOpenId(null);
      else if (tab !== 'home') setTab('home');
      else return false;
      return true;
    });
    return () => sub.remove();
  }, [drawer, composing, openId, tab]);

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

  const tabBtn = (tb: (typeof TABS)[number]): React.JSX.Element => {
    const on = tab === tb.id;
    return (
      <Pressable
        key={tb.id}
        onPress={() => {
          setOpenId(null);
          setTab(tb.id);
        }}
        style={[t.ui.tab, on && t.ui.tabOn]}
        accessibilityLabel={tb.label}
      >
        <Icon as={tb.icon} color={on ? t.c.accent : t.c.muted} strokeWidth={on ? 2 : 1.75} />
        {tb.id === 'inbox' && pending > 0 && <View style={t.ui.badge} />}
      </Pressable>
    );
  };
  const tabs = [
    ...TABS.slice(0, 2).map(tabBtn),
    <Pressable key="add" onPress={() => setComposing({ voice: false })} style={t.ui.tabAdd} accessibilityLabel="New capture">
      <Icon as={Plus} color={t.c.ink} strokeWidth={2.25} />
    </Pressable>,
    ...TABS.slice(2).map(tabBtn)
  ];

  return (
    <View style={[styles.safe, { backgroundColor: t.c.bg }]}>
      <StatusBar barStyle={t.statusBar} backgroundColor={t.c.bg} />
      {error && (
        <View style={[styles.errBar, { paddingTop: insets.top }]}>
          <Text style={[styles.errText, { color: t.c.danger }]}>{error}</Text>
        </View>
      )}
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {composing ? (
          <CaptureScreen
            startVoice={composing.voice}
            onClose={() => {
              setComposing(null);
              if (shared) consumeShared();
            }}
            onSaved={() => setComposing(null)}
            shared={shared}
            onSharedConsumed={consumeShared}
          />
        ) : openId ? (
          <EditorScreen noteId={openId} onClose={() => setOpenId(null)} />
        ) : tab === 'home' ? (
          <HomeScreen
            onMenu={() => setDrawer(true)}
            onOpen={(id) => setOpenId(id)}
            onCompose={(o) => setComposing({ voice: !!o?.voice })}
            onInbox={() => setTab('inbox')}
            onToday={() => setTab('today')}
          />
        ) : tab === 'inbox' ? (
          <InboxScreen onOpen={(id) => setOpenId(id)} onMenu={() => setDrawer(true)} />
        ) : tab === 'today' ? (
          <DailyScreen onMenu={() => setDrawer(true)} />
        ) : (
          <SettingsScreen onMenu={() => setDrawer(true)} />
        )}
      </View>
      {/* Floating glass toolbar (Obsidian-style). Hidden in the editor and the
          capture sheet — both have their own close action. */}
      {!openId && !composing && (
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
      <Drawer
        open={drawer}
        onClose={() => setDrawer(false)}
        onOpenNote={(id) => {
          setDrawer(false);
          setOpenId(id);
        }}
      />
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
