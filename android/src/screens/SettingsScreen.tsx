import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme, THEME_SWATCH, ACCENT_SWATCH } from '../theme';
import { ScreenHead } from '../components/ScreenHead';
import { ACCENTS, TEXT_SIZES, THEMES, usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';
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

      <Text style={ui.label}>Sync</Text>
      <Text style={ui.meta}>Not set up yet. Notes use the same files as the Mac app, ready to sync.</Text>

      <Text style={[ui.meta, { marginTop: 28, color: c.faint }]}>
        On this phone: voice memos are transcribed on Mac, search matches text, and routing uses folder keywords.
      </Text>
    </ScrollView>
  );
}
