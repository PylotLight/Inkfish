import React from 'react';
import { Pressable, Text, View } from 'react-native';
import { Menu, type LucideIcon } from 'lucide-react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';

export interface HeadAction {
  icon: LucideIcon;
  onPress: () => void;
  label: string;
  active?: boolean;
}

/**
 * Obsidian-mobile top bar: menu (file drawer) · title · actions. One compact
 * row instead of a 30pt title + subtitle on every screen — the content starts
 * a third of the way higher.
 */
export function ScreenHead({
  title,
  onMenu,
  actions = [],
  left
}: {
  title: string;
  onMenu?: () => void;
  actions?: HeadAction[];
  /** Replaces the menu button (e.g. a close/back action). */
  left?: HeadAction;
}): React.JSX.Element {
  const { ui, c } = useTheme();
  const lead = left ?? (onMenu ? { icon: Menu, onPress: onMenu, label: 'Open files' } : null);
  return (
    <View style={ui.topBar}>
      {lead ? (
        <Pressable onPress={lead.onPress} style={ui.iconBtn} hitSlop={6} accessibilityLabel={lead.label}>
          <Icon as={lead.icon} />
        </Pressable>
      ) : (
        <View style={ui.iconBtn} />
      )}
      <Text style={ui.topTitle} numberOfLines={1}>
        {title}
      </Text>
      <View style={ui.row}>
        {actions.map((a) => (
          <Pressable key={a.label} onPress={a.onPress} style={ui.iconBtn} hitSlop={6} accessibilityLabel={a.label}>
            <Icon as={a.icon} color={a.active ? c.accent : undefined} />
          </Pressable>
        ))}
      </View>
    </View>
  );
}
