// Single source of truth for app identity and window defaults.
// Used by main, preload types, and the renderer — change these when you
// clone this template for a real app.

/** Display name shown in the UI, tray, and notifications. */
export const APP_NAME = 'Inkfish'

/** One-liner shown under the brand in the sidebar. */
export const APP_TAGLINE = 'squirt ink fast · AI sorts it later'

/**
 * Reverse-DNS id used for setAppUserModelId (Windows notifications/tasks).
 * Change to your own id, e.g. 'com.yourname.yourapp'.
 */
export const APP_ID = 'com.pylotlight.inkfish'

/** Default BrowserWindow geometry. */
export const WINDOW = {
  width: 1240,
  height: 820,
  minWidth: 980,
  minHeight: 640
} as const

/** Tooltip for the system tray icon. */
export const TRAY_TOOLTIP = `${APP_NAME} — click for menu`
