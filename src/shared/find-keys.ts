/** Which find action the focused note should run. */
export type FindAction = 'find' | 'replace' | 'next' | 'prev'

/** The bits of Electron's before-input-event Input this needs. */
export interface FindKeyInput {
  type: string
  code: string
  meta: boolean
  control: boolean
  alt: boolean
  shift: boolean
}

/** The find action a keyDown asks for, or null. ⌘ on macOS, Ctrl elsewhere; matched on code (⌥⌘F reports 'ƒ'). */
export function findActionForInput(input: FindKeyInput, isMac = process.platform === 'darwin'): FindAction | null {
  if (input.type !== 'keyDown') return null
  if (!(isMac ? input.meta : input.control)) return null
  if (input.code === 'KeyF' && !input.shift) return input.alt ? 'replace' : 'find'
  if (input.code === 'KeyG' && !input.alt) return input.shift ? 'prev' : 'next'
  return null
}
