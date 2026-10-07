import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme, THEME_SWATCH, ACCENT_SWATCH } from '../theme';
import { ScreenHead } from '../components/ScreenHead';
import { ACCENTS, TEXT_SIZES, THEMES, usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';
import { useUpdates } from '../lib/updates';
import { when } from '../lib/when';
import { vaultRootUri } from '../lib/vault';

/**
 * Settings — Obsidian-style rows: label left, control right. Theme and accent
 * are colour swatches you can see, not a run of words to read.
 */
export function SettingsScreen({ onMenu }: { onMenu: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  const { prefs, update } = usePrefs();
  const { inbox, notes, projects, refresh, error } = useStore();
  const [scanned, setScanned] = useState(false);
  const upd = useUpdates();

  const seg = <T extends string | boolean>(
    opts: ReadonlyArray<{ id: T; name: string }>,
    value: T,
    set: (v: T) => void
  ): React.JSX.Element => (
    <View style={[ui.row, { gap: 2, flexWrap: 'wrap' }]}>
      {opts.map((o) => (
        <Pressable key={String(o.id)} onPress={() => set(o.id)} style={[ui.chip, value === o.id && ui.chipOn]}>
          <Text style={[ui.chipText, value === o.id && ui.chipTextOn]}>{o.name}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.scrollPad}>
      <ScreenHead title="Settings" onMenu={onMenu} />
      {error && <Text style={ui.err}>{error}</Text>}

      <Text style={[ui.label, { marginTop: 4 }]}>Appearance</Text>
      <Text style={[ui.title, { marginTop: 8 }]}>Theme</Text>
      <View style={[ui.row, { gap: 14, marginTop: 10, flexWrap: 'wrap' }]}>
        {THEMES.map((t) => (
          <Pressable key={t.id} onPress={() => update({ theme: t.id })} style={{ alignItems: 'center', gap: 6 }} accessibilityLabel={t.name}>
            <View style={[ui.swatch, { width: 40, height: 40, borderRadius: 12, backgroundColor: THEME_SWATCH[t.id] }, prefs.theme === t.id && ui.swatchOn]} />
            <Text style={[ui.meta, { marginTop: 0 }, prefs.theme === t.id && { color: c.text }]}>{t.name}</Text>
          </Pressable>
        ))}
      </View>

      <View style={[ui.row, { justifyContent: 'space-between', marginTop: 22 }]}>
        <Text style={ui.title}>Accent</Text>
        <View style={[ui.row, { gap: 12 }]}>
          {ACCENTS.map((a) => (
            <Pressable key={a.id} onPress={() => update({ accent: a.id })} hitSlop={6} accessibilityLabel={a.name}>
              <View style={[ui.swatch, { backgroundColor: ACCENT_SWATCH[a.id] }, prefs.accent === a.id && ui.swatchOn]} />
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[ui.row, { justifyContent: 'space-between', marginTop: 18 }]}>
        <Text style={ui.title}>Text size</Text>
        {seg(TEXT_SIZES, prefs.textSize, (v) => update({ textSize: v }))}
      </View>

      <View style={[ui.row, { justifyContent: 'space-between', marginTop: 14 }]}>
        <Text style={ui.title}>Toolbar</Text>
        {seg([{ id: true, name: 'Glass' }, { id: false, name: 'Solid' }] as const, prefs.blur, (v) => update({ blur: v }))}
      </View>

      <Text style={ui.label}>Vault</Text>
      <Text style={ui.title}>
        {notes.length} notes · {inbox.length} inbox · {projects.length} folders
      </Text>
      <Text style={[ui.meta, { marginTop: 4 }]} selectable numberOfLines={1} ellipsizeMode="middle">
        {vaultRootUri().replace(/^file:\/\//, '')}
      </Text>
      <Pressable
        onPress={() => void refresh().then(() => setScanned(true))}
        style={[ui.quiet, { marginTop: 4 }]}
      >
        <Text style={ui.quietText}>{scanned ? 'Re-scanned' : 'Re-scan files'}</Text>
      </Pressable>

      <Text style={ui.label}>Updates</Text>
      <View style={[ui.row, { justifyContent: 'space-between' }]}>
        <Text style={ui.title}>Version {upd.version}</Text>
        {upd.status === 'available' || upd.status === 'ready' ? (
          <Pressable onPress={() => void upd.update()} style={ui.quiet}>
            <Text style={ui.quietText}>{upd.status === 'ready' ? 'Install' : `Update to ${upd.release?.version}`}</Text>
          </Pressable>
        ) : upd.status === 'downloading' ? (
          <Text style={[ui.meta, { marginTop: 0, color: c.accent }]}>Downloading {Math.round(upd.progress * 100)}%</Text>
        ) : (
          <Pressable onPress={() => void upd.check()} disabled={upd.status === 'checking'} style={ui.quiet}>
            <Text style={ui.quietText}>{upd.status === 'checking' ? 'Checking…' : 'Check now'}</Text>
          </Pressable>
        )}
      </View>
      <Text style={[ui.meta, { marginTop: 0 }]}>
        {upd.status === 'error'
          ? `Couldn't update: ${upd.error}`
          : upd.status === 'current'
            ? `Up to date${upd.lastChecked ? ` · checked ${when(upd.lastChecked)}` : ''}`
            : upd.release && upd.status !== 'checking'
              ? `${Math.round(upd.release.apkSize / 1e6)} MB from GitHub · Android asks once to allow installs from Inkfish`
              : 'Updates come from GitHub releases'}
      </Text>
      {upd.release?.notes && (upd.status === 'available' || upd.status === 'ready') ? (
        <Text style={[ui.meta, { marginTop: 8 }]} numberOfLines={6}>{upd.release.notes}</Text>
      ) : null}
      <View style={[ui.row, { justifyContent: 'space-between', marginTop: 12 }]}>
        <Text style={ui.title}>Check automatically</Text>
        {seg([{ id: true, name: 'On' }, { id: false, name: 'Off' }] as const, prefs.autoUpdate, (v) => update({ autoUpdate: v }))}
      </View>

      <Text style={ui.label}>Sync</Text>
      <Text style={ui.meta}>Coming next: sync with your Mac over local Wi-Fi.</Text>

      <Text style={[ui.meta, { marginTop: 28, color: c.faint }]}>
        On this phone: voice memos are transcribed on Mac, search matches text, and routing uses folder keywords.
      </Text>
    </ScrollView>
  );
}
