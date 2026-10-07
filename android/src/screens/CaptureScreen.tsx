import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Check, Folder, Mic, Square, X } from 'lucide-react-native';
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import { saveAssetCopy } from '../lib/vault';
import type { PendingShare } from '../lib/share';
import type { NoteKind } from '../lib/format';
import { Icon } from '../components/Icon';

interface Props {
  onSaved: (noteId: string | null) => void;
  onClose: () => void;
  /** Start a voice memo as soon as the composer opens (Home mic). */
  startVoice?: boolean;
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
 * Full-screen sheet like Obsidian's new-note: close · destination · Save in
 * the top bar, a borderless composer, and a keyboard-docked row for mic and
 * folder. No block buttons — accent only on Save and the live recording.
 */
export function CaptureScreen({ onSaved, onClose, startVoice, shared, onSharedConsumed }: Props): React.JSX.Element {
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
  const [picker, setPicker] = useState(false);
  const insets = useSafeAreaInsets();
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
      else setMsg(null);
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
          setMsg(null);
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

  // Home's mic opens the sheet already recording.
  useEffect(() => {
    if (startVoice) void toggleRec();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startVoice]);

  const canSave = !saving && !recording && (!!raw.trim() || assets.length > 0 || pendingImages.length > 0);
  const hintName = hint === 'auto' ? 'Auto' : (projects.find((p) => p.id === hint)?.name ?? 'Auto');
  const voiceCount = assets.filter((a) => /\.(m4a|wav|mp3|ogg)$/i.test(a)).length;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: dark.bg }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[ui.topBar, { marginHorizontal: 10 }]}>
        <Pressable
          onPress={() => {
            if (recording) void voiceRecorder.stop().catch(() => {});
            onClose();
          }}
          style={ui.iconBtn}
          accessibilityLabel="Close"
        >
          <Icon as={X} />
        </Pressable>
        <View style={[ui.row, { flex: 1, justifyContent: 'center', gap: 2 }]}>
          {(['inbox', 'today'] as const).map((d) => (
            <Pressable key={d} onPress={() => setDest(d)} style={[ui.chip, dest === d && ui.chipOn]}>
              <Text style={[ui.chipText, dest === d && ui.chipTextOn]}>{d === 'inbox' ? 'Inbox' : 'Today'}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable onPress={() => void save()} disabled={!canSave} style={ui.iconBtn} accessibilityLabel="Save">
          {saving ? (
            <ActivityIndicator color={dark.accent} />
          ) : (
            <Icon as={Check} color={canSave ? dark.accent : dark.faint} strokeWidth={2.25} />
          )}
        </Pressable>
      </View>

      <ScrollView style={{ flex: 1, paddingHorizontal: 20 }} keyboardShouldPersistTaps="handled">
        {shared && (
          <View style={[ui.row, { justifyContent: 'space-between', marginBottom: 8 }]}>
            <Text style={ui.meta}>Shared{shared.label ? ` · ${shared.label}` : ''}</Text>
            <Pressable
              onPress={() => {
                setPendingImages([]);
                onSharedConsumed();
                onClose();
              }}
            >
              <Text style={ui.quietMuted}>Discard</Text>
            </Pressable>
          </View>
        )}
        <TextInput
          style={[ui.composer, { minHeight: 240 }]}
          value={raw}
          onChangeText={setRaw}
          placeholder={dest === 'today' ? 'Add to today…' : 'Capture a thought…'}
          placeholderTextColor={dark.faint}
          multiline
          autoFocus={!startVoice}
        />
        {(voiceCount > 0 || pendingImages.length > 0) && (
          <Text style={ui.meta}>
            {[
              voiceCount ? `${voiceCount} voice memo${voiceCount > 1 ? 's' : ''} · transcribed on Mac` : '',
              pendingImages.length ? `${pendingImages.length} image${pendingImages.length > 1 ? 's' : ''}` : ''
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
        )}
        {msg && <Text style={[ui.err, { marginTop: 8 }]}>{msg}</Text>}
      </ScrollView>

      {picker && dest === 'inbox' && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, paddingHorizontal: 12, paddingVertical: 6 }}>
          {[{ id: 'auto', name: 'Auto' }, ...projects].map((p) => (
            <Pressable
              key={p.id}
              onPress={() => {
                setHint(p.id);
                setPicker(false);
              }}
              style={[ui.chip, hint === p.id && ui.chipOn]}
            >
              <Text style={[ui.chipText, hint === p.id && ui.chipTextOn]}>{p.name}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={[ui.dock, { paddingBottom: insets.bottom + 4 }]}>
        <Pressable onPress={() => void toggleRec()} style={[ui.row, { paddingHorizontal: 10, height: 44, gap: 8 }]} accessibilityLabel={recording ? 'Stop recording' : 'Record voice memo'}>
          <Icon as={recording ? Square : Mic} size={20} color={recording ? dark.danger : undefined} />
          {recording && <Text style={{ color: dark.danger, fontWeight: '600' }}>Recording</Text>}
        </Pressable>
        {dest === 'inbox' && (
          <Pressable onPress={() => setPicker((v) => !v)} style={[ui.row, { paddingHorizontal: 10, height: 44, gap: 8 }]} accessibilityLabel="Choose folder">
            <Icon as={Folder} size={20} color={picker ? dark.accent : undefined} />
            <Text style={ui.quietMuted}>{hintName}</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}
