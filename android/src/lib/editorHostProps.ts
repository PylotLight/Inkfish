export const MARKDOWN_EDITOR_DOM_PROPS = {
  scrollEnabled: false,
  style: { flex: 1 }
}

/** Same-value editor props mean the Expo DOM WebView should not receive a host update. */
export function editorPropsEqual(previous: object, next: object): boolean {
  if (Object.is(previous, next)) return true
  const previousKeys = Object.keys(previous)
  const nextKeys = Object.keys(next)
  if (previousKeys.length !== nextKeys.length) return false
  const before = previous as Record<string, unknown>
  const after = next as Record<string, unknown>
  return previousKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(after, key) && Object.is(before[key], after[key])
  )
}
