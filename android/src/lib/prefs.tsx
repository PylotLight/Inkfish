import React, { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import * as FileSystem from 'expo-file-system/legacy';

/** Appearance prefs — the Android subset of the Mac prefs (theme + accent + text size + glass). */
export type ThemeId = 'deep' | 'abyss' | 'forest' | 'plum' | 'paper' | 'amoled';
export type AccentId = 'mint' | 'sky' | 'violet' | 'amber' | 'coral';
export type TextSizeId = 'compact' | 'default' | 'large';

export interface Prefs {
  theme: ThemeId;
  accent: AccentId;
  textSize: TextSizeId;
  /** Frosted-glass floating toolbar (off = solid). */
  blur: boolean;
  /** Check GitHub for a new APK on launch/foreground (every 6 h at most). */
  autoUpdate: boolean;
}

export const DEFAULT_PREFS: Prefs = { theme: 'deep', accent: 'mint', textSize: 'default', blur: true, autoUpdate: true };

export const THEMES: Array<{ id: ThemeId; name: string }> = [
  { id: 'deep', name: 'Deep' },
  { id: 'abyss', name: 'Abyss' },
  { id: 'forest', name: 'Forest' },
  { id: 'plum', name: 'Plum' },
  { id: 'paper', name: 'Paper' },
  { id: 'amoled', name: 'AMOLED' }
];

export const ACCENTS: Array<{ id: AccentId; name: string }> = [
  { id: 'mint', name: 'Mint' },
  { id: 'sky', name: 'Sky' },
  { id: 'violet', name: 'Violet' },
  { id: 'amber', name: 'Amber' },
  { id: 'coral', name: 'Coral' }
];

export const TEXT_SIZES: Array<{ id: TextSizeId; name: string }> = [
  { id: 'compact', name: 'Compact' },
  { id: 'default', name: 'Default' },
  { id: 'large', name: 'Large' }
];

const FILE = `${FileSystem.documentDirectory ?? ''}inkfish-prefs.json`;

function clean(raw: unknown): Partial<Prefs> {
  if (typeof raw !== 'object' || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const out: Partial<Prefs> = {};
  if (THEMES.some((t) => t.id === r['theme'])) out.theme = r['theme'] as ThemeId;
  if (ACCENTS.some((a) => a.id === r['accent'])) out.accent = r['accent'] as AccentId;
  if (TEXT_SIZES.some((s) => s.id === r['textSize'])) out.textSize = r['textSize'] as TextSizeId;
  if (typeof r['blur'] === 'boolean') out.blur = r['blur'];
  if (typeof r['autoUpdate'] === 'boolean') out.autoUpdate = r['autoUpdate'];
  return out;
}

interface PrefsCtx {
  prefs: Prefs;
  update: (patch: Partial<Prefs>) => void;
}

const Ctx = createContext<PrefsCtx>({ prefs: DEFAULT_PREFS, update: () => {} });

export function PrefsProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);

  useEffect(() => {
    FileSystem.readAsStringAsync(FILE)
      .then((text) => {
        try {
          setPrefs({ ...DEFAULT_PREFS, ...clean(JSON.parse(text)) });
        } catch {
          // corrupt prefs — stay on defaults
        }
      })
      .catch(() => {
        // first run — no file yet
      });
  }, []);

  const update = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      FileSystem.writeAsStringAsync(FILE, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrefs(): PrefsCtx {
  return useContext(Ctx);
}
