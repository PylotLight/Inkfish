import { describe, expect, test } from 'bun:test'
import { findActionForInput } from './find-keys'

const k = (
  code: string,
  m: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean; type: string }> = {}
) => ({
  type: 'keyDown',
  code,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...m
})

describe('findActionForInput', () => {
  test('mac uses ⌘', () => {
    expect(findActionForInput(k('KeyF', { meta: true }), true)).toBe('find')
    expect(findActionForInput(k('KeyF', { meta: true, alt: true }), true)).toBe('replace')
    expect(findActionForInput(k('KeyG', { meta: true }), true)).toBe('next')
    expect(findActionForInput(k('KeyG', { meta: true, shift: true }), true)).toBe('prev')
    expect(findActionForInput(k('KeyF', { control: true }), true)).toBeNull()
  })
  test('others use Ctrl', () => {
    expect(findActionForInput(k('KeyF', { control: true }), false)).toBe('find')
    expect(findActionForInput(k('KeyF', { meta: true }), false)).toBeNull()
  })
  test('ignores other keys, keyUp, ⇧⌘F, ⌥⌘G', () => {
    expect(findActionForInput(k('KeyF', { meta: true, type: 'keyUp' }), true)).toBeNull()
    expect(findActionForInput(k('KeyF', { meta: true, shift: true }), true)).toBeNull()
    expect(findActionForInput(k('KeyG', { meta: true, alt: true }), true)).toBeNull()
    expect(findActionForInput(k('KeyS', { meta: true }), true)).toBeNull()
  })
})
