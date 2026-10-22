import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MENU_BAR_SETTINGS,
  MENU_BAR_GAP,
  MENU_BAR_MARGIN,
  menuBarPopoutBounds,
  parseMenuBarSettings
} from './menubar'

const mac = { bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 38, width: 1512, height: 944 } }

describe('menu bar settings', () => {
  test("defaults keep today's behaviour (icon on, click = quick capture, Dock shown)", () => {
    expect(parseMenuBarSettings(undefined)).toEqual(DEFAULT_MENU_BAR_SETTINGS)
    expect(DEFAULT_MENU_BAR_SETTINGS).toMatchObject({ showIcon: true, hideDock: false, click: 'capture' })
  })
  test('hiding the Dock needs the icon (never both gone)', () => {
    expect(parseMenuBarSettings({ showIcon: false, hideDock: true }).hideDock).toBe(false)
    expect(parseMenuBarSettings({ showIcon: true, hideDock: true }).hideDock).toBe(true)
  })
  test('junk falls back', () => {
    expect(parseMenuBarSettings({ click: 'nope', showIcon: 'yes' })).toEqual(DEFAULT_MENU_BAR_SETTINGS)
    expect(parseMenuBarSettings({ click: 'window', anchorWindow: true })).toMatchObject({
      click: 'window',
      anchorWindow: true
    })
  })
})

describe('popout placement', () => {
  test('centred under the icon, below the (notched) menu bar', () => {
    const icon = { x: 1200, y: 0, width: 24, height: 24 }
    const { bounds, side } = menuBarPopoutBounds(icon, { x: 0, y: 0 }, { width: 380, height: 300 }, mac)
    expect(side).toBe('below')
    expect(bounds).toEqual({ x: 1212 - 190, y: 38 + MENU_BAR_GAP, width: 380, height: 300 })
  })
  test('kept inside the screen near the right edge', () => {
    const { bounds } = menuBarPopoutBounds(
      { x: 1490, y: 0, width: 22, height: 24 },
      { x: 0, y: 0 },
      { width: 380, height: 300 },
      mac
    )
    expect(bounds.x + bounds.width).toBe(1512 - MENU_BAR_MARGIN)
  })
  test('bottom taskbar: opens above the icon', () => {
    const win = {
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 }
    }
    const { bounds, side } = menuBarPopoutBounds(
      { x: 1800, y: 1044, width: 32, height: 32 },
      { x: 0, y: 0 },
      { width: 380, height: 300 },
      win
    )
    expect(side).toBe('above')
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(1040)
  })
  test('no tray bounds (Linux): the cursor stands in', () => {
    const { bounds } = menuBarPopoutBounds(null, { x: 700, y: 10 }, { width: 380, height: 300 }, mac)
    expect(bounds.x).toBe(700 - 190)
  })
})
