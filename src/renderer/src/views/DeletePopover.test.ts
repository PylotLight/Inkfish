import { describe, expect, test } from 'bun:test'
import { popoverPos } from './DeletePopover'

describe('delete glance position', () => {
  const row = { top: 200, bottom: 230, left: 10, right: 260 }
  test('sits right of the sidebar row', () => {
    expect(popoverPos(row, 1200, 800)).toEqual({ left: 268, top: 190 })
  })
  test('drops below the row when there is no room on the right', () => {
    expect(popoverPos(row, 500, 800)).toEqual({ left: 10, top: 236 })
  })
  test('stays on screen near the bottom', () => {
    expect(popoverPos({ ...row, top: 780, bottom: 800 }, 1200, 800, 240).top).toBe(552)
  })
})
