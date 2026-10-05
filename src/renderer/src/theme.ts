export type ThemeId = 'deep' | 'abyss' | 'forest' | 'plum' | 'paper'
export type AccentId = 'mint' | 'sky' | 'violet' | 'amber' | 'coral'
export type FontId = 'compact' | 'default' | 'large'
export type EditMode = 'read' | 'edit' | 'split'

export interface ThemeDef {
  id: ThemeId
  name: string
  blurb: string
  swatch: string
}

export const THEMES: ThemeDef[] = [
  { id: 'deep', name: 'Deep', blurb: 'Default dark slate', swatch: '#1c222b' },
  { id: 'abyss', name: 'Abyss', blurb: 'Near-black blue', swatch: '#06090f' },
  { id: 'forest', name: 'Forest', blurb: 'Dark green tint', swatch: '#0e1a14' },
  { id: 'plum', name: 'Plum', blurb: 'Dark purple tint', swatch: '#171222' },
  { id: 'paper', name: 'Paper', blurb: 'Light reading theme', swatch: '#f2efe8' }
]

export interface AccentDef {
  id: AccentId
  name: string
  hex: string
  ink: string
}

export const ACCENTS: AccentDef[] = [
  { id: 'mint', name: 'Mint', hex: '#7ee2a8', ink: '#0d2317' },
  { id: 'sky', name: 'Sky', hex: '#6ea8fe', ink: '#0b1526' },
  { id: 'violet', name: 'Violet', hex: '#b79bff', ink: '#1c1033' },
  { id: 'amber', name: 'Amber', hex: '#f2c069', ink: '#2a1c07' },
  { id: 'coral', name: 'Coral', hex: '#f28b8b', ink: '#2b0e0e' }
]

const K = {
  theme: 'inkfish.theme',
  accent: 'inkfish.accent',
  font: 'inkfish.font',
  mode: 'inkfish.editmode',
  motion: 'inkfish.motion',
  blur: 'inkfish.blur'
} as const

function read<T extends string>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key)
    return (v as T) ?? fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // private mode — styling just won't persist
  }
}

export interface ThemeState {
  theme: ThemeId
  accent: AccentId
  font: FontId
  mode: EditMode
  motion: boolean
  blur: boolean
}

export function loadTheme(): ThemeState {
  return {
    theme: read<ThemeId>(K.theme, 'deep'),
    accent: read<AccentId>(K.accent, 'mint'),
    font: read<FontId>(K.font, 'default'),
    mode: read<EditMode>(K.mode, 'read'),
    motion: read<string>(K.motion, 'on') !== 'off',
    blur: read<string>(K.blur, 'on') !== 'off'
  }
}

/** Apply theme state to <html>: dataset hooks for CSS + accent vars. */
export function applyTheme(s: ThemeState): void {
  const el = document.documentElement
  el.dataset['theme'] = s.theme
  el.dataset['font'] = s.font
  if (s.motion) delete el.dataset['motion']
  else el.dataset['motion'] = 'off'
  const accent = ACCENTS.find((a) => a.id === s.accent) ?? ACCENTS[0]
  if (accent) {
    el.style.setProperty('--mint', accent.hex)
    el.style.setProperty('--mint-ink', accent.ink)
  }
  write(K.theme, s.theme)
  write(K.accent, s.accent)
  write(K.font, s.font)
  write(K.mode, s.mode)
  write(K.motion, s.motion ? 'on' : 'off')
  write(K.blur, s.blur ? 'on' : 'off')
}
