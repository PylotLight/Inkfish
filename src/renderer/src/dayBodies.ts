import { useEffect, useState } from 'react'

/**
 * Lazily read daily-note bodies for the Journal + Home Daily cards. One `notes:get` per day,
 * only for days that are on screen, cached by (id, updatedAt) so scrolling back is free and an
 * edited day re-reads once. Concurrent asks for the same day share one IPC.
 */
const MAX = 500
const cache = new Map<string, { at: number; body: string }>()
const inflight = new Map<string, Promise<string | null>>()
const listeners = new Set<() => void>()

export function cachedBody(id: string, updatedAt: number): string | undefined {
  const hit = cache.get(id)
  return hit && hit.at === updatedAt ? hit.body : undefined
}

export function loadBody(id: string, updatedAt: number): Promise<string | null> {
  const have = cachedBody(id, updatedAt)
  if (have !== undefined) return Promise.resolve(have)
  const key = `${id}@${updatedAt}`
  const running = inflight.get(key)
  if (running) return running
  const p = window.api.notes
    .get(id)
    .then((doc) => {
      if (!doc) return null
      cache.delete(id)
      cache.set(id, { at: updatedAt, body: doc.markdown })
      if (cache.size > MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      for (const l of listeners) l()
      return doc.markdown
    })
    .catch(() => null)
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Re-render when any body lands (cheap: a counter, one render per frame for a burst of loads). */
export function useBodiesVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    let raf = 0
    const l = (): void => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setV((n) => n + 1)
      })
    }
    listeners.add(l)
    return () => {
      listeners.delete(l)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [])
  return v
}
