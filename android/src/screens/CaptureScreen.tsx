import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import { saveAssetCopy } from '../lib/vault';
import type { PendingShare } from '../lib/share';
import type { NoteKind } from '../lib/format';

interface Props {
  onSaved: (noteId: string | null) => void;
  /** A share-target payload waiting to be captured (null = normal capture). */
  shared: PendingShare | null;
  onSharedConsumed: () => void;
}

/**
 * Quick capture — the Android answer to Opt-Space. Text + optional voice
 * memo, Inbox/Today destination, project hint. Voice V1 records an `.m4a`
 * asset and attaches it; transcription happens on Mac after sync (or a
 * future on-device engine) — the audio is never lost.
 *
 * Styled like the Mac capture popover: one surface, underline destinations,
 * borderless composer, accent only on Save and the live recording state.
 */
export function CaptureScreen({ onSaved, shared, onSharedConsumed }: Props): React.JSX.Element {
  const { ui, c: dark } = useTheme();
  const { projects, capture, captureDaily } = useStore();
  const [raw, setRaw] = useState('');
  const [dest, setDest] = useState<'inbox' | 'today'>('inbox');
  const [hint, setHint] = useState('auto');
  const [assets, setAssets] = useState<string[]>([]);
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const seenShare = useRef<string | null>(null);
  // expo-audio recorder (HIGH_QUALITY = .m4a). Instance is component-scoped.
  const voiceRecorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  // A fresh share prefills the composer (appended if the user already typed).
  useEffect(() => {
    if (!shared || seenShare.current === shared.key) return;
    seenShare.current = shared.key;
    setRaw((prev) => {
      if (!prev.trim()) return shared.text;
      if (!shared.text) return prev;
      return prev.includes(shared.text) ? prev : `${prev.replace(/\s+$/, '')}\n\n${shared.text}`;
    });
    setPendingImages((prev) => [...prev, ...shared.imageUris.filter((u) => !prev.includes(u))]);
  }, [shared]);

  const kind: NoteKind = assets.some((a) => /\.(m4a|wav|mp3|ogg)$/i.test(a))
    ? 'voice'
    : assets.some((a) => /\.(png|jpe?g|gif|webp)$/i.test(a)) || pendingImages.length > 0
      ? 'image'
      : 'text';

  /** Copy staged share images into assets/. Failures are reported, never fatal. */
  async function ingestPendingImages(): Promise<{ rels: string[]; failed: number }> {
    const rels: string[] = [];
    let failed = 0;
    for (const uri of pendingImages) {
      try {
        const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(uri)?.[1] ?? 'jpg';
        rels.push(await saveAssetCopy(uri, `.${ext.toLowerCase()}`));
      } catch {
        failed++;
      }
    }
    return { rels, failed };
  }

  async function save(): Promise<void> {
    if (!raw.trim() && assets.length === 0 && pendingImages.length === 0) return;
    setSaving(true);
    try {
      const { rels, failed } = await ingestPendingImages();
      const allAssets = [...assets, ...rels];
      const imgRefs = rels.map((r) => `![](${r})`).join('\n');
      if (dest === 'today') {
        const parts = [raw.trim(), assets.map((a) => `![](${a})`).join('\n'), imgRefs]
          .filter(Boolean)
          .join('\n');
        await captureDaily(parts, kind);
      } else {
        const withImgs = imgRefs && !raw.includes(imgRefs) ? `${raw.trim()}\n${imgRefs}`.trim() : raw.trim();
        await capture(withImgs, kind, hint, allAssets);
      }
      if (failed > 0) setMsg(`Saved ✓ (${failed} shared image${failed > 1 ? 's' : ''} couldn't be copied)`);
      else setMsg('Saved ✓');
      setRaw('');
      setAssets([]);
      setPendingImages([]);
      if (shared) onSharedConsumed();
      onSaved(null);
    } catch (e) {
      setMsg(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function toggleRec(): Promise<void> {
    try {
      if (recording) {
        await voiceRecorder.stop();
        const uri = voiceRecorder.uri;
        setRecording(false);
        if (uri) {
          const rel = await saveAssetCopy(uri, '.m4a');
          setAssets((p) => [...p, rel]);
          setMsg('Voice memo attached — transcribe later');
        }
        return;
      }
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) {
        Alert.alert('Mic blocked', 'Allow microphone access to record voice notes.');
        return;
      }
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await voiceRecorder.prepareToRecordAsync();
      voiceRecorder.record();
      setRecording(true);
    } catch (e) {
      setMsg(`Recording failed: ${e instanceof Error ? e.message : String(e)}`);
      setRecording(false);
    }
  }

  const canSave = !saving && (!!raw.trim() || assets.length > 0 || pendingImages.length > 0);

  return (
    <ScrollView style={ui.screen} keyboardShouldPersistTaps="handled">
      <Text style={ui.h1}>Capture</Text>
      <Text style={ui.sub}>Fast now, sorted later — same inbox as Mac.</Text>

      {shared && (
        <View style={{ marginBottom: 12 }}>
          <Text style={ui.notice}>Shared from another app{shared.label ? ` · ${shared.label}` : ''}</Text>
          <Pressable
            onPress={() => {
              setPendingImages([]);
              onSharedConsumed();
              setMsg('Share dismissed — nothing saved.');
            }}
          >
            <Text style={ui.dismiss}>Dismiss share</Text>
          </Pressable>
        </View>
      )}

      <View style={ui.segRow}>
        {(['inbox', 'today'] as const).map((d) => (
          <Pressable key={d} onPress={() => setDest(d)} style={[ui.seg, dest === d && ui.segOn]}>
            <Text style={[ui.segText, dest === d && ui.segTextOn]}>{d === 'inbox' ? 'Inbox' : 'Today'}</Text>
          </Pressable>
        ))}
      </View>

      {dest === 'inbox' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 4 }}>
          <View style={[ui.segRow, { marginBottom: 0 }]}>
            <Pressable onPress={() => setHint('auto')} style={[ui.seg, hint === 'auto' && ui.segOn]}>
              <Text style={[ui.segText, hint === 'auto' && ui.segTextOn]}>Auto-route</Text>
            </Pressable>
            {projects.map((p) => (
              <Pressable key={p.id} onPress={() => setHint(p.id)} style={[ui.seg, hint === p.id && ui.segOn]}>
                <Text style={[ui.segText, hint === p.id && ui.segTextOn]}>{p.name}</Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}

      <TextInput
        style={ui.composer}
        value={raw}
        onChangeText={setRaw}
        placeholder={dest === 'today' ? 'Add to today…' : 'Capture a thought…'}
        placeholderTextColor={dark.faint}
        multiline
        autoFocus
      />

      {assets.map((a) => (
        <Text key={a} style={ui.meta}>● {a}</Text>
      ))}
      {pendingImages.length > 0 && (
        <Text style={ui.meta}>{pendingImages.length} shared image{pendingImages.length > 1 ? 's' : ''} — copied on save</Text>
      )}

      <View style={[ui.row, { marginTop: 10 }]}>
        <Pressable onPress={() => void toggleRec()} style={ui.quiet}>
          <Text style={[ui.quietMuted, recording && { color: dark.danger, fontWeight: '700' }]}>
            <Text style={{ color: recording ? dark.danger : dark.muted }}>● </Text>
            {recording ? 'Stop' : 'Dictate'}
          </Text>
        </Pressable>
      </View>

      {msg && <Text style={[ui.meta, { marginTop: 8 }]}>{msg}</Text>}

      <Pressable onPress={() => void save()} disabled={!canSave} style={[ui.btn, !canSave && ui.btnOff]}>
        {saving ? <ActivityIndicator color={dark.ink} /> : <Text style={ui.btnText}>{dest === 'today' ? 'Append' : 'Save'}</Text>}
      </Pressable>
    </ScrollView>
  );
}
