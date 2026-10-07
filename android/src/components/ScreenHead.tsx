import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../theme';

/** Screen header with hamburger (opens the file drawer) + title + sub. */
export function ScreenHead({ title, sub, onMenu }: { title: string; sub: string; onMenu: () => void }): React.JSX.Element {
  const { ui, c } = useTheme();
  return (
    <View style={{ marginBottom: 2 }}>
      <View style={s.row}>
        <Pressable onPress={onMenu} style={s.menu} hitSlop={8}>
          <Text style={[s.glyph, { color: c.muted }]}>☰</Text>
        </Pressable>
        <Text style={ui.h1}>{title}</Text>
      </View>
      <Text style={[ui.sub, { marginLeft: 44 }]}>{sub}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  menu: { width: 44, paddingVertical: 10, marginLeft: -8, alignItems: 'center' },
  glyph: { fontSize: 20 }
});
