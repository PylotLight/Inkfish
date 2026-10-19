import React from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { useSync } from '../lib/syncing';
import { progressLine, secs, summarize } from '../lib/sync';
import { agoText } from '../lib/syncstatus';

/**
 * Settings › Sync details: the paired Mac (name, address, protocol, last
 * seen), what a running sync is doing, and the last runs with their
 * durations / counts / errors. Read-only; everything comes from the sync loop.
 */
export function SyncDetails({ visible, onClose }: { visible: boolean; onClose: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  const sync = useSync();
  const now = Date.now();
  const runs = [...sync.log]
    .filter((e) => e.kind === 'sync' || e.kind === 'error' || e.kind === 'hold')
    .reverse()
    .slice(0, 10);
  const info = sync.macInfo;
  const row = (k: string, v: string): React.JSX.Element => (
    <View key={k} style={[ui.row, { justifyContent: 'space-between', paddingVertical: 4 }]}>
      <Text style={[ui.meta, { marginTop: 0 }]}>{k}</Text>
      <Text style={[ui.meta, { marginTop: 0, color: c.text, flexShrink: 1, textAlign: 'right' }]} selectable numberOfLines={1}>
        {v}
      </Text>
    </View>
  );
  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={onClose} accessibilityLabel="Close sync details" />
      <View style={{ maxHeight: '75%', backgroundColor: c.bg, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 18 }}>
        <Text style={ui.title}>Sync details</Text>
        <ScrollView style={{ marginTop: 8 }}>
          <Text style={ui.label}>Paired Mac</Text>
          {row('Name', sync.mac?.name ?? '—')}
          {row('Address', info ? `${info.host}:${info.port}` : sync.mac?.lastHost ? `${sync.mac.lastHost}:${sync.mac.port}` : '—')}
          {row('Protocol', info ? `v${info.protocol}${info.features.length ? ` · ${info.features.join(', ')}` : ''}` : '—')}
          {row('Last seen', info ? agoText(info.seenAt, now) : '—')}
          {row('Last synced', sync.lastSync ? agoText(sync.lastSync, now) : 'never')}
          {sync.progress && sync.phase === 'syncing' && (
            <>
              <Text style={ui.label}>Now</Text>
              <Text style={[ui.meta, { marginTop: 0 }]}>{progressLine(sync.progress, now)}</Text>
              {!!sync.progress.current && (
                <Text style={[ui.meta, { marginTop: 2 }]} numberOfLines={1} ellipsizeMode="head">
                  {sync.progress.current}
                </Text>
              )}
            </>
          )}
          <Text style={ui.label}>Last runs</Text>
          {runs.length === 0 && <Text style={[ui.meta, { marginTop: 0 }]}>No syncs yet</Text>}
          {runs.map((e, i) => (
            <View key={`${e.at}-${i}`} style={[ui.row, { justifyContent: 'space-between', paddingVertical: 5, gap: 8 }]}>
              <Text style={[ui.meta, { marginTop: 0, flex: 1, color: e.kind === 'sync' ? c.muted : c.danger }]} numberOfLines={2}>
                {summarize(e)}
              </Text>
              <Text style={[ui.meta, { marginTop: 0 }]}>
                {e.ms !== undefined ? `${secs(e.ms)} · ` : ''}
                {agoText(e.at, now)}
              </Text>
            </View>
          ))}
        </ScrollView>
        <Pressable onPress={onClose} style={[ui.quiet, { marginTop: 10, alignSelf: 'flex-end' }]}>
          <Text style={ui.quietText}>Done</Text>
        </Pressable>
      </View>
    </Modal>
  );
}
