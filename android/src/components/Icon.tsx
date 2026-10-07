import React from 'react';
import type { LucideIcon } from 'lucide-react-native';
import { useTheme } from '../theme';

/**
 * Lucide line icons — the same set Obsidian uses. One size, one stroke, so
 * every glyph in the app sits on the same optical grid (the old unicode
 * glyphs ✎ ▤ ◷ ⚙ rendered at four different weights and sizes on Android).
 */
export function Icon({
  as: Glyph,
  size = 22,
  color,
  strokeWidth = 1.75
}: {
  as: LucideIcon;
  size?: number;
  color?: string;
  strokeWidth?: number;
}): React.JSX.Element {
  const { c } = useTheme();
  return <Glyph size={size} color={color ?? c.muted} strokeWidth={strokeWidth} />;
}
