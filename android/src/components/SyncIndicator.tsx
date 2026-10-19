import React, { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, Pressable, Text, View } from 'react-native';
import { CloudAlert, CloudCheck, CloudOff, RefreshCw, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '../theme';
import { useSync } from '../lib/syncing';
import { syncIndicator, type IndicatorState, type SyncIndicator as Indicator } from '../lib/syncstatus';
import { Icon } from './Icon';

/** Opens the sync screen (Settings tab). Provided by the app shell. */
export const OpenSyncContext = createContext<(() => void) | null>(null);

const GLYPH: Record<Exclude<IndicatorState, 'hidden'>, LucideIcon> = {
  connecting: RefreshCw,
  syncing: RefreshCw,
  synced: CloudCheck,
  idle: CloudCheck,
  offline: CloudOff,
  held: CloudAlert,
  error: CloudAlert
};

/** Derived indicator for the current sync loop state. */
export function useSyncIndicator(): Indicator {
  const sync = useSync();
  return useMemo(
    () =>
      syncIndicator({
        phase: sync.phase,
        macName: sync.mac?.name ?? null,
        lastSync: sync.lastSync,
        error: sync.error,
        heldCount: sync.held ? sync.held.local.length + sync.held.remote.length : 0
      }),
    // lastSync / phase changes are what move it; `when()` text refreshes with them.
    [sync.phase, sync.mac?.name, sync.lastSync, sync.error, sync.held]
  );
}

function useTap(ind: Indicator): { onPress: () => void; onLongPress: () => void } {
  const sync = useSync();
  const open = useContext(OpenSyncContext);
  return {
    onPress: () => {
      if (ind.tap === 'sync') void sync.syncNow();
      else if (ind.tap === 'open') open?.();
    },
    onLongPress: () => open?.()
  };
}

function Spinner({ spinning, children }: { spinning: boolean; children: React.ReactNode }): React.JSX.Element {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!spinning) {
      v.stopAnimation();
      v.setValue(0);
      return;
    }
    // Native-driver loop only while a sync is actually running.
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1100, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [spinning, v]);
  const rotate = v.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return <Animated.View style={spinning ? { transform: [{ rotate }] } : undefined}>{children}</Animated.View>;
}

/** Compact header badge: glyph + a few chars. Tap = sync now (or review), long-press = sync settings. Hidden until paired. */
export function SyncBadge(): React.JSX.Element | null {
  const { ui, c } = useTheme();
  const ind = useSyncIndicator();
  const tap = useTap(ind);
  if (ind.state === 'hidden') return null;
  const color = c[ind.tone];
  return (
    <Pressable
      {...tap}
      delayLongPress={400}
      hitSlop={6}
      style={[ui.row, { height: 44, paddingHorizontal: 8, gap: 5 }]}
      accessibilityRole="button"
      accessibilityLabel={`${ind.label}. ${ind.tap === 'sync' ? 'Tap to sync now. ' : ''}Long-press for sync settings`}
    >
      <Spinner spinning={ind.spinning}>
        <Icon as={GLYPH[ind.state]} size={18} color={color} />
      </Spinner>
      {!!ind.short && (
        <Text style={{ color: ind.tone === 'danger' ? c.danger : c.muted, fontSize: 12 }} numberOfLines={1}>
          {ind.short}
        </Text>
      )}
    </Pressable>
  );
}

/** Full-sentence row for the file drawer. */
export function SyncRow(): React.JSX.Element | null {
  const { ui, c } = useTheme();
  const ind = useSyncIndicator();
  const tap = useTap(ind);
  if (ind.state === 'hidden') return null;
  return (
    <Pressable
      {...tap}
      delayLongPress={400}
      style={[ui.row, { gap: 8, paddingVertical: 8 }]}
      accessibilityRole="button"
      accessibilityLabel={ind.label}
    >
      <Spinner spinning={ind.spinning}>
        <Icon as={GLYPH[ind.state]} size={16} color={c[ind.tone]} />
      </Spinner>
      <View style={{ flex: 1 }}>
        <Text style={[ui.meta, { marginTop: 0 }, ind.tone === 'danger' && { color: c.danger }]} numberOfLines={2}>
          {ind.label}
        </Text>
      </View>
    </Pressable>
  );
}
