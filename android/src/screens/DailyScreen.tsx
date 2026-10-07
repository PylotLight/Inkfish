import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useTheme } from '../theme';
import { useStore } from '../lib/store';
import { Markdown } from '../components/Markdown';

/** Today log — appends timestamped sections to `daily/YYYY-MM-DD.md`, like Mac. */
export function DailyScreen(): React.JSX.Element {
  const { ui, c: dark } = useTheme();
  const { readDaily, appendDaily } = useStore();
  const [body, setBody] = useState('');
  const [rel, setRel] = useState('');
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function load(): Promise<void> {
    const d = await readDaily();
    setRel(d.rel);
    setBody(d.body);
  }

  useEffect(() => {
    void load();
  }, []);

  async function append(): Promise<void> {
    if (!draft.trim()) return;
    try {
      await appendDaily(draft.trim(), 'text');
      setDraft('');
      setMsg('Appended ✓');
      await load();
    } catch (e) {
      setMsg(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const canAppend = !!draft.trim();

  return (
    <ScrollView style={ui.screen} keyboardShouldPersistTaps="handled">
      <Text style={ui.h1}>Today</Text>
      <Text style={ui.sub}>{rel || 'daily log'}</Text>
      <TextInput
        style={[ui.composer, { minHeight: 90 }]}
        value={draft}
        onChangeText={setDraft}
        placeholder="Add to today…"
        placeholderTextColor={dark.faint}
        multiline
      />
      <Pressable onPress={() => void append()} disabled={!canAppend} style={[ui.btn, !canAppend && ui.btnOff]}>
        <Text style={ui.btnText}>Append</Text>
      </Pressable>
      {msg && <Text style={[ui.meta, { marginTop: 8 }]}>{msg}</Text>}
      <View style={{ height: 16 }} />
      <Markdown text={body || '_Nothing logged yet today._'} />
    </ScrollView>
  );
}
