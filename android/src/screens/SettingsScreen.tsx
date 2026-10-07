import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useTheme } from '../theme';
import { ScreenHead } from '../components/ScreenHead';
import { ACCENTS, TEXT_SIZES, THEMES, usePrefs } from '../lib/prefs';
import { useStore } from '../lib/store';
import { stagingUri, vaultRootUri } from '../lib/vault';

export function SettingsScreen({ onMenu }: { onMenu: () => void }): React.JSX.Element {
  const { ui } = useTheme();
  const { prefs, update } = usePrefs();
  const { inbox, notes, projects, refresh, error } = useStore();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <ScrollView style={ui.screen}>
      <ScreenHead title="Settings" sub="Local-only V1 · sync comes later" onMenu={onMenu} />
      {error && <Text style={ui.err}>{error}</Text>}

      <Text style={ui.section}>Appearance · theme</Text>
      <View style={ui.segWrap}>
        {THEMES.map((t) => (
          <Pressable key={t.id} onPress={() => update({ theme: t.id })} style={[ui.seg, prefs.theme === t.id && ui.segOn]}>
            <Text style={[ui.segText, prefs.theme === t.id && ui.segTextOn]}>{t.name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={ui.section}>Appearance · accent</Text>
      <View style={ui.segWrap}>
        {ACCENTS.map((a) => (
          <Pressable key={a.id} onPress={() => update({ accent: a.id })} style={[ui.seg, prefs.accent === a.id && ui.segOn]}>
            <Text style={[ui.segText, prefs.accent === a.id && ui.segTextOn]}>{a.name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={ui.section}>Appearance · text size</Text>
      <View style={ui.segWrap}>
        {TEXT_SIZES.map((s) => (
          <Pressable key={s.id} onPress={() => update({ textSize: s.id })} style={[ui.seg, prefs.textSize === s.id && ui.segOn]}>
            <Text style={[ui.segText, prefs.textSize === s.id && ui.segTextOn]}>{s.name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={ui.section}>Appearance · toolbar</Text>
      <View style={ui.segWrap}>
        {(
          [
            { id: true, name: 'Glass' },
            { id: false, name: 'Solid' }
          ] as const
        ).map((o) => (
          <Pressable key={o.name} onPress={() => update({ blur: o.id })} style={[ui.seg, prefs.blur === o.id && ui.segOn]}>
            <Text style={[ui.segText, prefs.blur === o.id && ui.segTextOn]}>{o.name}</Text>
          </Pressable>
        ))}
      </View>

      <Text style={ui.section}>Vault · on-device</Text>
      <Text style={ui.meta} selectable>{vaultRootUri()}</Text>
      <Text style={ui.meta} selectable>{stagingUri()}</Text>
      <Text style={[ui.meta, { marginTop: 6 }]}>
        {notes.length} notes · {inbox.length} inbox · {projects.length} folders
      </Text>
      <Pressable onPress={() => void refresh().then(() => setMsg('Re-scanned ✓'))} style={ui.quiet}>
        <Text style={ui.quietText}>Re-scan files</Text>
      </Pressable>

      <Text style={ui.section}>Sync · later</Text>
      <Text style={ui.meta}>
        Files already use the Mac format (same frontmatter, same project/YYYY-MM-DD-slug.md layout),
        so sync will be a plain file copy of the vault + staging folders. Nothing to configure yet.
      </Text>

      <Text style={ui.section}>Not in V1 yet</Text>
      <Text style={ui.meta}>
        • On-device transcription (voice memos attach as audio, Mac transcribes after sync){'\n'}
        • FTS search (substring only){'\n'}
        • Apple-Intelligence cleanup (rules router only)
      </Text>

      {msg && <Text style={[ui.meta, { marginTop: 8 }]}>{msg}</Text>}
      <View style={{ height: 24 }} />
    </ScrollView>
  );
}
