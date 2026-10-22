import { describe, expect, test } from 'bun:test'
import { popoverKeyAction, popoverPos } from './DeletePopover'

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

describe('delete glance keys', () => {
  const el = (tag: string, cls: string[] = []): Element =>
    ({ tagName: tag, classList: { contains: (c: string) => cls.includes(c) } }) as unknown as Element
  const cancel = el('BUTTON', ['btn', 'ghost'])
  const del = el('BUTTON', ['btn', 'danger'])
  const pop = { contains: (n: unknown) => n === cancel || n === del } as unknown as Element
  test('Enter on a focused Cancel presses Cancel, not Delete', () => {
    expect(popoverKeyAction({ key: 'Enter' }, cancel, pop)).toBe('native')
  })
  test('Enter on Delete, or with focus elsewhere, deletes; Esc / ⌘⌫ are always ours', () => {
    expect(popoverKeyAction({ key: 'Enter' }, del, pop)).toBe('ours')
    expect(popoverKeyAction({ key: 'Enter' }, el('DIV'), pop)).toBe('ours')
    expect(popoverKeyAction({ key: 'Escape' }, cancel, pop)).toBe('ours')
    expect(popoverKeyAction({ key: 'Backspace' }, cancel, pop)).toBe('ours')
  })
})
