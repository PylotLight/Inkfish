/**
 * Crisp 24-grid stroke icons for the app chrome (sidebar, ribbon, titlebar toggle).
 * Hand-drawn in the Lucide style (1.75 stroke, round caps) so they stay sharp at any size —
 * replaces the old emoji/unicode glyphs (☀ 🎙 ⚙ ⏻ « ») which rendered blurry or as tofu.
 */
import type { SVGProps } from 'react'

export type IconName =
  | 'panel-left'
  | 'search'
  | 'notes'
  | 'home'
  | 'inbox'
  | 'sun'
  | 'journal'
  | 'mic'
  | 'record'
  | 'settings'
  | 'power'
  | 'folder'
  | 'chevron-right'
  | 'note-new'
  | 'folder-new'
  | 'sort-az'
  | 'sort-time'
  | 'collapse-all'
  | 'expand-all'
  | 'pencil'
  | 'trash'
  | 'more'
  | 'sync'

const PATHS: Record<IconName, React.JSX.Element> = {
  'panel-left': (
    <>
      <rect x="3" y="3.5" width="18" height="17" rx="3" />
      <path d="M9.5 3.5v17" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  notes: (
    <>
      <path d="M14.5 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z" />
      <path d="M14 2.5V7h5M9 12.5h6M9 16.5h4" />
    </>
  ),
  home: (
    <>
      <path d="M3.5 10 12 3.5l8.5 6.5V19a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M9.5 21v-6.5h5V21" />
    </>
  ),
  inbox: (
    <>
      <path d="M21.5 12.5H16l-1.8 2.7H9.8L8 12.5H2.5" />
      <path d="M5.5 5.2 2.5 12.5V18a2 2 0 0 0 2 2h15a2 2 0 0 0 2-2v-5.5l-3-7.3A2 2 0 0 0 16.6 4H7.4a2 2 0 0 0-1.9 1.2z" />
    </>
  ),
  journal: (
    <>
      <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H18a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6.5A1.5 1.5 0 0 1 5 18.5z" />
      <path d="M5 17.5A1.5 1.5 0 0 1 6.5 16H19M9 7.5h6M9 11h4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2.5" width="6" height="12" rx="3" />
      <path d="M18.5 11a6.5 6.5 0 0 1-13 0M12 17.5v4" />
    </>
  ),
  record: <circle cx="12" cy="12" r="5" fill="currentColor" stroke="none" />,
  settings: (
    <>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  power: (
    <>
      <path d="M12 2.5v9" />
      <path d="M17.7 6.3a8 8 0 1 1-11.4 0" />
    </>
  ),
  folder: (
    <path d="M20 19.5a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 4H4a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2z" />
  ),
  'chevron-right': <path d="m9.5 6 6 6-6 6" />,
  'note-new': (
    <>
      <path d="M12 3.5H6a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 6 20.5h12a2.5 2.5 0 0 0 2.5-2.5v-6" />
      <path d="M17.6 3.1a1.9 1.9 0 0 1 2.7 2.7l-7.6 7.6-3.4.9.9-3.4z" />
    </>
  ),
  'folder-new': (
    <>
      <path d="M20 19.5a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 4H4a2 2 0 0 0-2 2v11.5a2 2 0 0 0 2 2z" />
      <path d="M12 10.5v6M9 13.5h6" />
    </>
  ),
  'sort-az': (
    <>
      <path d="m3 16 4 4 4-4M7 20V4" />
      <path d="M14.5 10 17 4l2.5 6M15.3 8h3.4M14.5 14h5l-5 6h5" />
    </>
  ),
  'sort-time': (
    <>
      <path d="m3 16 4 4 4-4M7 20V4" />
      <circle cx="17" cy="9" r="5" />
      <path d="M17 6.5V9l1.6 1.2" />
    </>
  ),
  'collapse-all': <path d="m7 20 5-5 5 5M7 4l5 5 5-5" />,
  'expand-all': <path d="m7 15 5 5 5-5M7 9l5-5 5 5" />,
  pencil: <path d="M16.9 3.6a2.1 2.1 0 0 1 3 3L8.5 18l-4 1 1-4z" />,
  trash: (
    <>
      <path d="M4 6.5h16M9.5 6.5V4.8a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.7" />
      <path d="M6.2 6.5l.9 12.2a2 2 0 0 0 2 1.8h5.8a2 2 0 0 0 2-1.8l.9-12.2M10 10.5v6M14 10.5v6" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="18.5" cy="12" r="1" />
    </>
  ),
  sync: (
    <>
      <path d="M20 11.5A8 8 0 0 0 6.2 6.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 12.5a8 8 0 0 0 13.8 5.2l2.2-2.2" />
      <path d="M20 20v-4.5h-4.5" />
    </>
  )
}

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & Omit<SVGProps<SVGSVGElement>, 'name'>): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...rest}
    >
      {PATHS[name]}
    </svg>
  )
}
