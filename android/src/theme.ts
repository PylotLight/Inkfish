import { useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { usePrefs, type AccentId, type Prefs, type ThemeId } from './lib/prefs';

/**
 * Dynamic theme — Mac themes + accents, AMOLED pure black, text scaling.
 * Everything visual reads from here, so switching prefs re-skins the app
 * with no logic changes. `c` replaces the old static `dark` palette.
 */

export interface Colors {
  bg: string;
  card: string;
  card2: string;
  inset: string;
  text: string;
  muted: string;
  faint: string;
  accent: string;
  ink: string;
  danger: string;
  border: string;
  barBg: string;
  barSolid: string;
  tabOn: string;
}

const ACCENT_HEX: Record<AccentId, { accent: string; ink: string; tabOn: string }> = {
  mint: { accent: '#7ee2a8', ink: '#0d2317', tabOn: 'rgba(126,226,168,0.14)' },
  sky: { accent: '#6ea8fe', ink: '#0b1526', tabOn: 'rgba(110,168,254,0.16)' },
  violet: { accent: '#b79bff', ink: '#1c1033', tabOn: 'rgba(183,155,255,0.16)' },
  amber: { accent: '#f2c069', ink: '#2a1c07', tabOn: 'rgba(242,192,105,0.16)' },
  coral: { accent: '#f28b8b', ink: '#2b0e0e', tabOn: 'rgba(242,139,139,0.16)' }
};

type Base = Omit<Colors, 'accent' | 'ink' | 'tabOn'>;

const DARK_BASE: Base = {
  bg: '#08090c',
  card: 'rgba(255,255,255,0.055)',
  card2: 'rgba(255,255,255,0.10)',
  inset: 'rgba(0,0,0,0.30)',
  text: '#f2f4f6',
  muted: 'rgba(242,244,246,0.55)',
  faint: 'rgba(242,244,246,0.32)',
  danger: '#e5636f',
  border: 'rgba(255,255,255,0.10)',
  barBg: 'rgba(16,18,24,0.55)',
  barSolid: '#14161c'
};

function baseFor(theme: ThemeId): { base: Base; light: boolean } {
  switch (theme) {
    case 'abyss':
      return { base: { ...DARK_BASE, bg: '#06090f', barSolid: '#0a0f16' }, light: false };
    case 'forest':
      return { base: { ...DARK_BASE, bg: '#0e1a14', barSolid: '#122019' }, light: false };
    case 'plum':
      return { base: { ...DARK_BASE, bg: '#171222', barSolid: '#1d1729' }, light: false };
    case 'amoled':
      return {
        base: {
          ...DARK_BASE,
          bg: '#000000',
          card: 'rgba(255,255,255,0.04)',
          card2: 'rgba(255,255,255,0.08)',
          inset: 'rgba(255,255,255,0.05)',
          border: 'rgba(255,255,255,0.12)',
          barBg: 'rgba(0,0,0,0.55)',
          barSolid: '#0a0a0c'
        },
        light: false
      };
    case 'paper':
      return {
        base: {
          bg: '#f2efe8',
          card: 'rgba(255,255,255,0.65)',
          card2: 'rgba(0,0,0,0.05)',
          inset: 'rgba(0,0,0,0.05)',
          text: '#1b1e22',
          muted: 'rgba(27,30,34,0.60)',
          faint: 'rgba(27,30,34,0.35)',
          danger: '#c0454f',
          border: 'rgba(0,0,0,0.12)',
          barBg: 'rgba(250,248,243,0.60)',
          barSolid: '#e9e6dd'
        },
        light: true
      };
    case 'deep':
    default:
      return { base: DARK_BASE, light: false };
  }
}

export function buildTheme(p: Prefs): {
  c: Colors;
  ui: ReturnType<typeof buildUi>;
  md: ReturnType<typeof buildMd>;
  statusBar: 'light-content' | 'dark-content';
  blurTint: 'light' | 'dark';
} {
  const { base, light } = baseFor(p.theme);
  const a = ACCENT_HEX[p.accent];
  const c: Colors = { ...base, accent: a.accent, ink: a.ink, tabOn: a.tabOn };
  const scale = p.textSize === 'compact' ? 0.9 : p.textSize === 'large' ? 1.15 : 1;
  return {
    c,
    ui: buildUi(c, scale),
    md: buildMd(c, scale),
    statusBar: light ? 'dark-content' : 'light-content',
    blurTint: light ? 'light' : 'dark'
  };
}

function buildUi(c: Colors, s: number): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.bg,
      paddingHorizontal: 20,
      paddingTop: 0
    },
    // Scroll content padding: clears the floating toolbar.
    scrollPad: { paddingBottom: 132 },
    // Obsidian-mobile top bar: icon · title · icons.
    topBar: { flexDirection: 'row', alignItems: 'center', height: 52, marginHorizontal: -10, marginBottom: 4 },
    topTitle: { flex: 1, color: c.text, fontSize: 17 * s, fontWeight: '600', marginLeft: 2 },
    iconBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22 },
    // Large page title (Home only).
    display: { color: c.text, fontSize: 28 * s, fontWeight: '700', letterSpacing: -0.6 },
    // Quiet section label — sentence case, no all-caps shouting.
    label: { color: c.faint, fontSize: 13, fontWeight: '600', marginTop: 26, marginBottom: 4 },
    // Flat list row (Obsidian file list): icon · title/meta · trailing.
    listRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 11, gap: 14 },
    listText: { flex: 1, minWidth: 0 },
    // Inline composer line: text field with trailing icon actions, hairline under.
    inputLine: {
      flexDirection: 'row',
      alignItems: 'center',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      paddingVertical: 2
    },
    inputText: { flex: 1, color: c.text, fontSize: 16 * s, paddingVertical: 10 },
    chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999 },
    chipOn: { backgroundColor: c.tabOn },
    chipText: { color: c.muted, fontSize: 13.5, fontWeight: '500' },
    chipTextOn: { color: c.accent, fontWeight: '600' },
    // Keyboard-docked accessory row (capture/editor).
    dock: {
      flexDirection: 'row',
      alignItems: 'center',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      paddingHorizontal: 10,
      paddingVertical: 4,
      backgroundColor: c.bg
    },
    swatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: c.border },
    swatchOn: { borderWidth: 2, borderColor: c.text },
    center: { flex: 1, backgroundColor: c.bg, alignItems: 'center', justifyContent: 'center' },
    h1: {
      color: c.text,
      fontSize: 30 * s,
      fontWeight: '700',
      letterSpacing: -0.5,
      marginBottom: 2
    },
    sub: { color: c.muted, fontSize: 13.5, marginBottom: 16, lineHeight: 18 },
    section: { color: c.faint, fontSize: 13, fontWeight: '600', marginTop: 26, marginBottom: 6 },
    row: { flexDirection: 'row', alignItems: 'center' },
    segRow: { flexDirection: 'row', gap: 20, marginBottom: 8 },
    segWrap: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, rowGap: 2, marginBottom: 8 },
    seg: { paddingVertical: 6, borderBottomWidth: 1.5, borderBottomColor: 'transparent' },
    segText: { color: c.muted, fontSize: 14, fontWeight: '600' },
    segOn: { borderBottomColor: c.text },
    segTextOn: { color: c.text },
    composer: {
      color: c.text,
      fontSize: 17 * s,
      lineHeight: 26 * s,
      minHeight: 180,
      textAlignVertical: 'top',
      paddingVertical: 8
    },
    composerMono: { fontFamily: 'monospace', fontSize: 14.5 * s, lineHeight: 22 * s, minHeight: 380 },
    search: {
      backgroundColor: c.inset,
      color: c.text,
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 11,
      fontSize: 15,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: c.border
    },
    btn: {
      backgroundColor: c.accent,
      borderRadius: 12,
      paddingVertical: 13,
      alignItems: 'center',
      marginTop: 12
    },
    btnText: { color: c.ink, fontWeight: '700', fontSize: 15 },
    btnOff: { opacity: 0.35 },
    quiet: { paddingVertical: 8, paddingRight: 16 },
    quietText: { color: c.accent, fontSize: 14, fontWeight: '600' },
    quietMuted: { color: c.muted, fontSize: 14 },
    back: { alignSelf: 'flex-start', paddingVertical: 8, paddingRight: 16, marginBottom: 8 },
    backText: { color: c.muted, fontSize: 15 },
    rowItem: {
      paddingVertical: 13,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border
    },
    title: { color: c.text, fontSize: 16 * s, fontWeight: '600', lineHeight: 22 * s },
    meta: { color: c.muted, fontSize: 12.5 * s, marginTop: 3, lineHeight: 17 * s },
    status: { color: c.accent, fontSize: 12, fontWeight: '600', marginTop: 4 },
    statusDim: { color: c.muted, fontSize: 12, marginTop: 4 },
    err: { color: c.danger, fontSize: 13, marginBottom: 8 },
    notice: { color: c.accent, fontSize: 13, fontWeight: '600' },
    dismiss: { color: c.muted, fontSize: 13, textDecorationLine: 'underline', marginTop: 6 },
    // Floating glass toolbar.
    barWrap: { position: 'absolute', alignSelf: 'center' },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      borderRadius: 999,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: c.border,
      overflow: 'hidden',
      paddingVertical: 5,
      paddingHorizontal: 6,
      backgroundColor: c.barBg
    },
    tab: { width: 52, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 999 },
    tabAdd: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 22, backgroundColor: c.accent, marginHorizontal: 4 },
    tabOn: { backgroundColor: c.tabOn },
    glyph: { color: c.muted, fontSize: 21 },
    glyphOn: { color: c.accent },
    badge: { position: 'absolute', top: 9, right: 13, width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent }
  });
}

function buildMd(c: Colors, s: number): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    h: { color: c.text, fontWeight: '700', letterSpacing: -0.3, marginTop: 14, marginBottom: 6 },
    h1: { fontSize: 26 * s },
    h2: { fontSize: 20 * s },
    h3: { fontSize: 16 * s },
    p: { color: c.text, fontSize: 16.5 * s, lineHeight: 26 * s, marginVertical: 3 },
    bullet: { color: c.muted },
    bold: { fontWeight: '700' },
    mono: { fontFamily: 'monospace', backgroundColor: c.inset, borderRadius: 4 },
    italic: { fontStyle: 'italic' },
    strike: { textDecorationLine: 'line-through', color: c.muted },
    link: { color: c.accent, textDecorationLine: 'underline' },
    quote: { borderLeftWidth: 2, borderLeftColor: c.border, paddingLeft: 12, marginVertical: 4 },
    rule: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: 14 },
    check: { color: c.accent },
    codeBox: { backgroundColor: c.inset, borderRadius: 10, padding: 12, marginVertical: 8 },
    code: { color: c.text, fontFamily: 'monospace', fontSize: 13.5 * s, lineHeight: 20 * s },
    imgRef: { color: c.muted, fontSize: 13, marginVertical: 4 }
  });
}

export type AppTheme = ReturnType<typeof buildTheme>;

export function useTheme(): AppTheme {
  const { prefs } = usePrefs();
  return useMemo(() => buildTheme(prefs), [prefs]);
}

/** Swatch colours for the Settings pickers. */
export const THEME_SWATCH: Record<ThemeId, string> = {
  deep: '#08090c',
  abyss: '#06090f',
  forest: '#0e1a14',
  plum: '#171222',
  paper: '#f2efe8',
  amoled: '#000000'
};
export const ACCENT_SWATCH: Record<AccentId, string> = Object.fromEntries(
  Object.entries(ACCENT_HEX).map(([k, v]) => [k, v.accent])
) as Record<AccentId, string>;
