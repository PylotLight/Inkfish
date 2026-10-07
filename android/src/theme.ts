import { StyleSheet } from 'react-native';

/**
 * Obsidian-clean surfaces + Mac glass tokens.
 * Near-black stage, hairline dividers, translucent glass, mint accent (the
 * Mac default). Text is never boxed: composers and previews are borderless,
 * lists are plain rows — chrome lives only in the floating toolbar.
 */
export const dark = {
  bg: '#08090c',
  card: 'rgba(255,255,255,0.055)',
  card2: 'rgba(255,255,255,0.10)',
  inset: 'rgba(0,0,0,0.30)',
  text: '#f2f4f6',
  muted: 'rgba(242,244,246,0.55)',
  faint: 'rgba(242,244,246,0.32)',
  accent: '#7ee2a8',
  mint: '#7ee2a8',
  ink: '#0d2317',
  danger: '#e5636f',
  border: 'rgba(255,255,255,0.10)'
};

export const ui = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: dark.bg,
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 132
  },
  h1: {
    color: dark.text,
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.5,
    marginBottom: 2
  },
  sub: { color: dark.muted, fontSize: 13.5, marginBottom: 16, lineHeight: 18 },
  section: {
    color: dark.muted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginTop: 20,
    marginBottom: 4
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  // Underline segment tabs (Mac capture style) — no pills.
  segRow: { flexDirection: 'row', gap: 20, marginBottom: 8 },
  seg: { paddingVertical: 6, borderBottomWidth: 1.5, borderBottomColor: 'transparent' },
  segText: { color: dark.muted, fontSize: 14, fontWeight: '600' },
  segOn: { borderBottomColor: dark.text },
  segTextOn: { color: dark.text },
  // Borderless composer (Mac capture popover style).
  composer: {
    color: dark.text,
    fontSize: 17,
    lineHeight: 26,
    minHeight: 180,
    textAlignVertical: 'top',
    paddingVertical: 8
  },
  composerMono: { fontFamily: 'monospace', fontSize: 14.5, lineHeight: 22, minHeight: 380 },
  search: {
    backgroundColor: dark.inset,
    color: dark.text,
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 11,
    fontSize: 15,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: dark.border
  },
  btn: {
    backgroundColor: dark.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: 'center',
    marginTop: 12
  },
  btnText: { color: dark.ink, fontWeight: '700', fontSize: 15 },
  btnOff: { opacity: 0.35 },
  // Quiet text buttons.
  quiet: { paddingVertical: 8, paddingRight: 16 },
  quietText: { color: dark.accent, fontSize: 14, fontWeight: '600' },
  quietMuted: { color: dark.muted, fontSize: 14 },
  back: { alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 16, marginBottom: 8 },
  backText: { color: dark.muted, fontSize: 15 },
  // Borderless list rows with hairline dividers.
  rowItem: {
    paddingVertical: 13,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: dark.border
  },
  title: { color: dark.text, fontSize: 16, fontWeight: '600', lineHeight: 22 },
  meta: { color: dark.muted, fontSize: 12.5, marginTop: 3, lineHeight: 17 },
  status: { color: dark.mint, fontSize: 12, fontWeight: '600', marginTop: 4 },
  statusDim: { color: dark.muted, fontSize: 12, marginTop: 4 },
  err: { color: dark.danger, fontSize: 13, marginBottom: 8 },
  notice: { color: dark.accent, fontSize: 13, fontWeight: '600' },
  dismiss: { color: dark.muted, fontSize: 13, textDecorationLine: 'underline', marginTop: 6 }
});
