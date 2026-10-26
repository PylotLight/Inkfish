import { useState } from 'react'
import type { MenuItem } from '../views/Dialogs'
import type { MenuState } from '../shell/types'
import { buildMenuItems, type CtxMenuContext } from '../shell/ctx-menu-items'

/** Right-click menu: where it is open, and the items for its target. */
export function useCtxMenu(ctx: CtxMenuContext): {
  menu: MenuState | null
  setMenu: (menu: MenuState | null) => void
  menuItems: (target: MenuState['target']) => MenuItem[]
} {
  const [menu, setMenu] = useState<MenuState | null>(null)
  const items = buildMenuItems({ ...ctx, menu })
  return { menu, setMenu, menuItems: (t) => items(t) }
}
