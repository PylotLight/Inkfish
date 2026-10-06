/**
 * Inkfish prefs — mirrors the Blobfish settings shape (single validated JSON
 * blob, preset + custom accents, density, motion) plus Inkfish-only reading /
 * editor / vault-ui prefs. Applied to <html> dataset + inline accent vars.
 */

export type ThemeId = 'deep' | 'abyss' | 'forest' | 'plum' | 'paper'
export type AccentId = 'mint' | 'sky' | 'violet' | 'amber' | 'coral' | 'custom'
export type DensityId = 'comfortable' | 'compact'
export type MotionId = 'full' | 'reduced'
export type FontId = 'compact' | 'default' | 'large'
/**
 * Center view: `live` = rendered note with click-to-edit blocks (default),
 * `raw` = full markdown source. The old `read`/`edit`/`split` split is gone —
 * `read`+`split` migrate to `live`, `edit` migrates to `raw`.
 */
export type EditMode = 'live' | 'raw'

export interface Prefs {
  theme: ThemeId
  accent: AccentId
  /** Custom accent hex (`#rrggbb`) used when `accent === 'custom'`. */
  customAccent: string
  density: DensityId
  motion: MotionId
  /** Legacy preset — migrated to `fontSize` on load. Kept for back-compat. */
  font: FontId
  /** Content font size (px) for reading + editing views. UI chrome unaffected. */
  fontSize: number
  /** Font-family stacks. Empty = system default. */
  interfaceFont: string
  textFont: string
  monoFont: string
  /** Ctrl+Scroll / pinch adjusts `fontSize` when inside the note stage. */
  quickZoom: boolean
  mode: EditMode
  /** macOS vibrancy blur. */
  blur: boolean
}

export const DEFAULT_PREFS: Prefs = {
  theme: 'deep',
  accent: 'mint',
  customAccent: '#7ee2a8',
  density: 'comfortable',
  motion: 'full',
  font: 'default',
  fontSize: 14,
  interfaceFont: '',
  textFont: '',
  monoFont: '',
  quickZoom: true,
  mode: 'live',
  blur: true
}

export interface ThemeDef {
  id: ThemeId
  name: string
  blurb: string
  swatch: string
}

export const THEMES: ThemeDef[] = [
  { id: 'deep', name: 'Deep', blurb: 'Default dark slate.', swatch: '#1c222b' },
  { id: 'abyss', name: 'Abyss', blurb: 'Deeper black, low-glare.', swatch: '#06090f' },
  { id: 'forest', name: 'Forest', blurb: 'Dark green tint.', swatch: '#0e1a14' },
  { id: 'plum', name: 'Plum', blurb: 'Dark purple tint.', swatch: '#171222' },
  { id: 'paper', name: 'Paper', blurb: 'Light reading theme.', swatch: '#f2efe8' }
]

export interface AccentDef {
  id: Exclude<AccentId, 'custom'>
  name: string
  desc: string
  hex: string
  ink: string
}

export const ACCENTS: AccentDef[] = [
  { id: 'mint', name: 'Mint', desc: 'Default green.', hex: '#7ee2a8', ink: '#0d2317' },
  { id: 'sky', name: 'Sky', desc: 'Cool blue.', hex: '#6ea8fe', ink: '#0b1526' },
  { id: 'violet', name: 'Violet', desc: 'Soft purple.', hex: '#b79bff', ink: '#1c1033' },
  { id: 'amber', name: 'Amber', desc: 'Warm gold.', hex: '#f2c069', ink: '#2a1c07' },
  { id: 'coral', name: 'Coral', desc: 'Warm red-orange.', hex: '#f28b8b', ink: '#2b0e0e' }
]

const KEY = 'inkfish.prefs.v1'

function isTheme(v: unknown): v is ThemeId {
  return typeof v === 'string' && (THEMES as ThemeDef[]).some((t) => t.id === v)
}

function isAccent(v: unknown): v is AccentId {
  return typeof v === 'string' && ['mint', 'sky', 'violet', 'amber', 'coral', 'custom'].includes(v)
}

function isHex(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

function clampFontSize(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return DEFAULT_PREFS.fontSize
  return Math.min(28, Math.max(11, Math.round(n)))
}

function cleanFontStack(v: unknown): string {
  return typeof v === 'string' ? v.slice(0, 300).trim() : ''
}

export const FONT_SIZE_FROM_PRESET: Record<FontId, number> = {
  compact: 12.5,
  default: 14,
  large: 16
}

/** Relative luminance → readable button text for any chosen color. */
export function inkFor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
  return lum > 0.45 ? '#10141a' : '#f2f4f6'
}

/** Accent → CSS variable overrides applied inline on <html>. */
export function accentVars(prefs: Prefs): Record<string, string> {
  if (prefs.accent === 'custom') {
    if (!isHex(prefs.customAccent)) return {}
    const hex = prefs.customAccent
    const ink = inkFor(hex)
    return { '--accent': hex, '--accent-ink': ink, '--mint': hex, '--mint-ink': ink }
  }
  const a = ACCENTS.find((x) => x.id === prefs.accent) ?? ACCENTS[0]
  if (!a) return {}
  return { '--accent': a.hex, '--accent-ink': a.ink, '--mint': a.hex, '--mint-ink': a.ink }
}

function loadBlob(): Partial<Prefs> {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return {}
    return JSON.parse(raw) as Partial<Prefs>
  } catch {
    return {}
  }
}

/** One-shot migration from the old per-key settings. */
function legacy(): Partial<Prefs> {
  const get = (k: string): string | null => {
    try {
      return localStorage.getItem(k)
    } catch {
      return null
    }
  }
  const out: Partial<Prefs> = {}
  const theme = get('inkfish.theme')
  if (isTheme(theme)) out.theme = theme
  const accent = get('inkfish.accent')
  if (isAccent(accent)) out.accent = accent
  const font = get('inkfish.font')
  if (font === 'compact' || font === 'default' || font === 'large') out.font = font
  const mode = get('inkfish.editmode')
  if (mode === 'live' || mode === 'raw') out.mode = mode
  else if (mode === 'read' || mode === 'split') out.mode = 'live'
  else if (mode === 'edit') out.mode = 'raw'
  const motion = get('inkfish.motion')
  if (motion === 'on') out.motion = 'full'
  else if (motion === 'off') out.motion = 'reduced'
  const blur = get('inkfish.blur')
  if (blur === 'on') out.blur = true
  else if (blur === 'off') out.blur = false
  return out
}

export function loadPrefs(): Prefs {
  const base = { ...legacy(), ...loadBlob() }
  const font = base.font === 'compact' || base.font === 'large' ? base.font : 'default'
  // Migrate legacy 3-step preset → numeric size when no explicit size stored.
  const fontSize =
    typeof base.fontSize === 'number' && Number.isFinite(base.fontSize)
      ? clampFontSize(base.fontSize)
      : (base as { fontSize?: unknown }).fontSize !== undefined
        ? clampFontSize((base as { fontSize?: unknown }).fontSize)
        : FONT_SIZE_FROM_PRESET[font] ?? DEFAULT_PREFS.fontSize
  return {
    theme: isTheme(base.theme) ? base.theme : DEFAULT_PREFS.theme,
    accent: isAccent(base.accent) ? base.accent : DEFAULT_PREFS.accent,
    customAccent: isHex(base.customAccent) ? base.customAccent : DEFAULT_PREFS.customAccent,
    density: base.density === 'compact' ? 'compact' : 'comfortable',
    motion: base.motion === 'reduced' ? 'reduced' : 'full',
    font,
    fontSize,
    interfaceFont: cleanFontStack((base as Partial<Prefs>).interfaceFont),
    textFont: cleanFontStack((base as Partial<Prefs>).textFont),
    monoFont: cleanFontStack((base as Partial<Prefs>).monoFont),
    quickZoom: (base as Partial<Prefs>).quickZoom !== false,
    mode: base.mode === 'raw' ? 'raw' : base.mode === 'live' ? 'live'
      // Migrate the old read/edit/split split: rendered views → live, source → raw.
      : (base.mode as unknown) === 'edit' ? 'raw' : 'live',
    blur: base.blur !== false
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    // Private mode etc. — prefs just won't persist.
  }
}

/** Apply prefs to <html>: dataset hooks for CSS + accent vars. */
export function applyPrefs(p: Prefs): void {
  const el = document.documentElement
  el.dataset['theme'] = p.theme
  el.dataset['density'] = p.density
  el.dataset['motion'] = p.motion
  el.dataset['font'] = p.font
  const vars = accentVars(p)
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v)
  // Content type scale — editing + reading views only, UI chrome untouched.
  el.style.setProperty('--ed-fs', `${clampFontSize(p.fontSize)}px`)
  if (p.interfaceFont) el.style.setProperty('--ui-font', p.interfaceFont)
  else el.style.removeProperty('--ui-font')
  if (p.textFont) el.style.setProperty('--text-font', p.textFont)
  else el.style.removeProperty('--text-font')
  if (p.monoFont) el.style.setProperty('--mono-font', p.monoFont)
  else el.style.removeProperty('--mono-font')
  savePrefs(p)
}
