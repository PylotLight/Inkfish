/**
 * Obsidian-style autosave: every local edit is written to disk after a short idle, and any
 * pending text is flushed immediately on tab switch, new note, tab close, window blur/close and
 * app quit. There is no manual save and no "unsaved" state for the user to manage.
 *
 * Pure (no DOM / Electron) so the renderer and the tests share it. Per note:
 *  - `schedule` keeps only the newest text and (re)starts the debounce timer;
 *  - saves for one note never overlap — a save that lands while another is in flight waits and
 *    then writes the NEWEST text, so an older write can never land after a newer one;
 *  - text already known to be on disk is skipped (no churn on no-op edits);
 *  - a failed save keeps its text pending (unless newer text arrived) so the next flush retries.
 */

export const AUTOSAVE_DEBOUNCE_MS = 400

export type Timer = unknown

export interface AutosaveOptions<R> {
  /** Write `markdown` for note `id`. Resolves to what the backend returned (null = not saved). */
  save: (id: string, markdown: string) => Promise<R | null>
  /** A save landed. `id` is the id the text was queued under. */
  onSaved?: (id: string, markdown: string, result: R) => void
  onError?: (id: string, error: unknown) => void
  delayMs?: number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (t: Timer) => void
}

export interface Autosave {
  /** Queue the newest local text for `id`; written after the debounce (or on flush). */
  schedule: (id: string, markdown: string) => void
  /** Write `id`'s pending text now (waits for an in-flight save first). */
  flush: (id: string) => Promise<void>
  /** Write every pending note now — tab switch, new note, blur, quit. */
  flushAll: () => Promise<void>
  /** Drop `id`'s pending text without writing (another window owns the newer text). */
  cancel: (id: string) => void
  /** Record text known to be on disk for `id` (loaded or saved elsewhere). */
  noteSaved: (id: string, markdown: string) => void
  /**
   * A save/rename moved the note: carry pending text and baseline to the new id. Pending text is
   * always (re)scheduled there — text that missed its save while a rename was in flight (no timer
   * left) must not sit unsaved until the next blur.
   */
  rename: (from: string, to: string) => void
  /** Pending (unsaved) text for `id`, if any. */
  pending: (id: string) => string | undefined
  /** Anything queued or in flight? */
  busy: () => boolean
  /** Snapshot of every pending note — for a synchronous last-chance save (beforeunload). */
  drain: () => Array<{ id: string; markdown: string }>
}

export function createAutosave<R>(opts: AutosaveOptions<R>): Autosave {
  const delay = opts.delayMs ?? AUTOSAVE_DEBOUNCE_MS
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const pendingText = new Map<string, string>()
  const timers = new Map<string, Timer>()
  const inflight = new Map<string, Promise<void>>()
  const onDisk = new Map<string, string>()

  const stopTimer = (id: string): void => {
    const t = timers.get(id)
    if (t !== undefined) clearTimer(t)
    timers.delete(id)
  }

  const runOne = async (id: string): Promise<void> => {
    const text = pendingText.get(id)
    if (text === undefined) return
    pendingText.delete(id)
    if (onDisk.get(id) === text) return
    try {
      const result = await opts.save(id, text)
      if (result === null) {
        // Backend refused (note gone / not a file) — keep the text so it's never silently lost.
        if (!pendingText.has(id)) pendingText.set(id, text)
        opts.onError?.(id, new Error('note could not be saved'))
        return
      }
      onDisk.set(id, text)
      opts.onSaved?.(id, text, result)
    } catch (err) {
      if (!pendingText.has(id)) pendingText.set(id, text)
      opts.onError?.(id, err)
    }
  }

  const flush = (id: string): Promise<void> => {
    stopTimer(id)
    const prev = inflight.get(id)
    if (prev) {
      // Serialize: once the running save lands, write whatever is newest now.
      return prev.then(() => (pendingText.has(id) && !inflight.has(id) ? flush(id) : inflight.get(id)))
    }
    if (!pendingText.has(id)) return Promise.resolve()
    const p = runOne(id).finally(() => {
      if (inflight.get(id) === p) inflight.delete(id)
    })
    inflight.set(id, p)
    return p
  }

  const schedule = (id: string, markdown: string): void => {
    pendingText.set(id, markdown)
    stopTimer(id)
    timers.set(
      id,
      setTimer(() => {
        timers.delete(id)
        void flush(id)
      }, delay)
    )
  }
  const cancel = (id: string): void => {
    stopTimer(id)
    pendingText.delete(id)
  }

  return {
    schedule,
    flush,
    async flushAll() {
      const ids = new Set([...pendingText.keys(), ...inflight.keys()])
      await Promise.all([...ids].map((id) => flush(id)))
    },
    cancel,
    noteSaved(id, markdown) {
      onDisk.set(id, markdown)
    },
    rename(from, to) {
      if (from === to) return
      const text = pendingText.get(from)
      cancel(from)
      const disk = onDisk.get(from)
      if (disk !== undefined) onDisk.set(to, disk)
      onDisk.delete(from)
      if (text !== undefined) schedule(to, text)
    },
    pending: (id) => pendingText.get(id),
    busy: () => pendingText.size > 0 || inflight.size > 0,
    drain() {
      const out = [...pendingText.entries()].map(([id, markdown]) => ({ id, markdown }))
      for (const id of [...timers.keys()]) stopTimer(id)
      pendingText.clear()
      return out
    }
  }
}

/**
 * Which lifted draft belongs in the editor. The draft MUST be keyed by the doc the editor is
 * actually showing — not the selected tab id. Opening a note that isn't cached yet changes the
 * selection before its doc loads; keying by selection handed the still-visible old note
 * `undefined`, so the editor reset it to its last saved text and dropped the edits (the
 * "new tab / switch lost my Untitled content" bug).
 */
export function draftForEditor(
  doc: { id: string } | null,
  drafts: Readonly<Record<string, string>>
): string | undefined {
  return doc ? drafts[doc.id] : undefined
}

// ---------------------------------------------------------------------------------------------
// Quit flush (main process): ask every window to write pending text before the app quits.

export interface QuitFlushOptions {
  /** Ids of windows that may hold unsaved text. */
  targets: () => number[]
  /** Ask window `id` to flush; it answers by calling `ack(token)` from its reply. */
  request: (id: number, token: string) => void
  timeoutMs?: number
  setTimer?: (fn: () => void, ms: number) => Timer
  clearTimer?: (t: Timer) => void
}

export interface QuitFlush {
  /** Resolves when every window acked or the timeout passed (quit is never blocked forever). */
  run: () => Promise<{ acked: number; timedOut: boolean }>
  ack: (token: string) => void
}

export function createQuitFlush(opts: QuitFlushOptions): QuitFlush {
  const timeoutMs = opts.timeoutMs ?? 2000
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  const waiting = new Set<string>()
  let settle: (() => void) | null = null
  let seq = 0

  return {
    run() {
      const ids = opts.targets()
      if (ids.length === 0) return Promise.resolve({ acked: 0, timedOut: false })
      return new Promise((resolve) => {
        let acked = 0
        let done = false
        const finish = (timedOut: boolean): void => {
          if (done) return
          done = true
          clearTimer(timer)
          waiting.clear()
          settle = null
          resolve({ acked, timedOut })
        }
        const timer = setTimer(() => finish(true), timeoutMs)
        settle = () => {
          acked++
          if (waiting.size === 0) finish(false)
        }
        const tokens = ids.map((id) => {
          const token = `flush-${++seq}-${id}`
          waiting.add(token)
          return [id, token] as const
        })
        for (const [id, token] of tokens) {
          try {
            opts.request(id, token)
          } catch {
            // A window that can't be asked (destroyed mid-quit) has nothing to flush.
            waiting.delete(token)
          }
        }
        if (waiting.size === 0) finish(false)
      })
    },
    ack(token) {
      if (!waiting.delete(token)) return
      settle?.()
    }
  }
}

/**
 * The editor shows (and autosaves) a note's BODY — the index strips YAML front matter. Writing
 * that body back as the whole file would silently drop the note's front matter (id, kind,
 * project…), and with autosave that would happen on the first keystroke. Keep the file's
 * existing front matter unless the incoming text brings its own.
 */
export function keepFrontmatter(existingFile: string, body: string): string {
  if (!existingFile.startsWith('---') || body.startsWith('---')) return body
  const end = existingFile.indexOf('\n---', 3)
  if (end === -1) return body
  return `${existingFile.slice(0, end + 4)}\n${body}`
}
