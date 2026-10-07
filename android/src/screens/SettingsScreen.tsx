import React, { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { ui } from '../theme';
import { useStore } from '../lib/store';
import { stagingUri, vaultRootUri } from '../lib/vault';

export function SettingsScreen(): React.JSX.Element {
  const { inbox, notes, projects, refresh, error } = useStore();
  const [msg, setMsg] = useState<string | null>(null);

  return (
    <ScrollView style={ui.screen}>
      <Text style={ui.h1}>Settings</Text>
      <Text style={ui.sub}>Local-only V1 · sync comes later</Text>
      {error && <Text style={ui.err}>{error}</Text>}

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
