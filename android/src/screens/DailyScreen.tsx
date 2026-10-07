import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { ArrowUp } from 'lucide-react-native';
import { useTheme } from '../theme';
import { ScreenHead } from '../components/ScreenHead';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { Markdown } from '../components/Markdown';
import { longDate } from '../lib/when';

/**
 * Today log — appends timestamped sections to `daily/YYYY-MM-DD.md`, like Mac.
 * Reads like a journal: date, the log, then a single add-line with an inline
 * send arrow (no block Append button).
 */
export function DailyScreen({ onMenu }: { onMenu: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  const { readDaily, appendDaily } = useStore();
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  async function load(): Promise<void> {
    const d = await readDaily();
    // The file's own `# YYYY-MM-DD` heading duplicates the page title.
    setBody(d.body.replace(/^#\s+\d{4}-\d{2}-\d{2}\s*\n+/, ''));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function append(): Promise<void> {
    if (!draft.trim()) return;
    try {
      await appendDaily(draft.trim(), 'text');
      setDraft('');
      setMsg(null);
      await load();
    } catch (e) {
      setMsg(`Couldn't save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const canAppend = !!draft.trim();

  return (
    <ScrollView style={ui.screen} contentContainerStyle={ui.scrollPad} keyboardShouldPersistTaps="handled">
      <ScreenHead title="Today" onMenu={onMenu} />
      <Text style={ui.display}>{longDate()}</Text>

      <View style={[ui.inputLine, { marginTop: 16, marginBottom: 8 }]}>
        <TextInput
          style={ui.inputText}
          value={draft}
          onChangeText={setDraft}
          placeholder="Add to today…"
          placeholderTextColor={c.faint}
          multiline
          onSubmitEditing={() => void append()}
        />
        <Pressable onPress={() => void append()} disabled={!canAppend} style={ui.iconBtn} accessibilityLabel="Add">
          <Icon as={ArrowUp} size={20} color={canAppend ? c.accent : c.faint} strokeWidth={2.25} />
        </Pressable>
      </View>
      {msg && <Text style={ui.err}>{msg}</Text>}

      {body.trim() ? <Markdown text={body} /> : <Text style={[ui.meta, { marginTop: 12 }]}>Nothing logged yet today.</Text>}
    </ScrollView>
  );
}
