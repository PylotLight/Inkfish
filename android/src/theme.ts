import { StyleSheet } from 'react-native';

/** Dark-first palette matching the Mac glass UI accent. */
export const dark = {
  bg: '#101014',
  card: '#1b1b22',
  card2: '#23232c',
  text: '#f2f2f5',
  muted: '#9a9aa5',
  accent: '#6ea8fe',
  mint: '#7ee2a8',
  danger: '#e5636f',
  border: '#2c2c36'
};

export const ui = StyleSheet.create({
  screen: { flex: 1, backgroundColor: dark.bg, padding: 16 },
  h1: { color: dark.text, fontSize: 24, fontWeight: '700', marginBottom: 4 },
  sub: { color: dark.muted, fontSize: 13, marginBottom: 12 },
  card: { backgroundColor: dark.card, borderRadius: 12, padding: 12, marginBottom: 10, borderWidth: 1, borderColor: dark.border },
  input: {
    backgroundColor: dark.card,
    color: dark.text,
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 120,
    textAlignVertical: 'top',
    borderWidth: 1,
    borderColor: dark.border
  },
  search: {
    backgroundColor: dark.card,
    color: dark.text,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: dark.border
  },
  btn: { backgroundColor: dark.accent, borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 10 },
  btnText: { color: '#0b0b10', fontWeight: '700', fontSize: 15 },
  ghostBtn: { borderRadius: 10, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: dark.border, marginTop: 8 },
  ghostText: { color: dark.text, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center' },
  chip: { borderRadius: 16, paddingHorizontal: 12, paddingVertical: 7, marginRight: 8, backgroundColor: dark.card2, borderWidth: 1, borderColor: dark.border },
  chipOn: { backgroundColor: dark.accent, borderColor: dark.accent },
  chipText: { color: dark.text, fontSize: 13 },
  chipTextOn: { color: '#0b0b10', fontWeight: '700' },
  title: { color: dark.text, fontSize: 16, fontWeight: '600' },
  meta: { color: dark.muted, fontSize: 12, marginTop: 2 },
  pill: { color: dark.mint, fontSize: 11, fontWeight: '700', marginTop: 4 },
  err: { color: dark.danger, fontSize: 13, marginBottom: 8 }
});
