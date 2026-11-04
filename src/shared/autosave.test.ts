import { describe, expect, test } from 'bun:test'
import { createAutosave, createQuitFlush, draftForEditor, keepFrontmatter, planEditorSave } from './autosave'

/** Manual clock: timers only fire when the test says so. */
function fakeTimers(): {
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (t: unknown) => void
  advance: (ms: number) => void
  count: () => number
} {
  let now = 0
  let next = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    setTimer: (fn, ms) => {
      const id = next++
      timers.set(id, { at: now + ms, fn })
      return id
    },
    clearTimer: (t) => void timers.delete(t as number),
    advance: (ms) => {
      now += ms
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.delete(id)) t.fn()
      }
    },
    count: () => timers.size
  }
}

/** A tiny vault the autosave writes into. */
function fakeDisk(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial }
  const writes: Array<[string, string]> = []
  return {
    files,
    writes,
    save: async (id: string, md: string) => {
      writes.push([id, md])
      files[id] = md
      return { id, markdown: md }
    }
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/**
 * Mirrors App.tsx's tab model: editor shows `doc`; tabs open async (doc lags the selection);
 * every tab change flushes autosave first.
 */
function session(disk: ReturnType<typeof fakeDisk>, clock: ReturnType<typeof fakeTimers>) {
  const drafts: Record<string, string> = {}
  let selId: string | null = null
  let doc: { id: string; markdown: string } | null = null
  const autosave = createAutosave({
    save: disk.save,
    delayMs: 400,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onSaved: (id, md) => {
      if (drafts[id] === md) delete drafts[id]
    }
  })
  /** What the editor would render for the visible doc. */
  const editorText = (): string => draftForEditor(doc, drafts) ?? doc?.markdown ?? ''
  return {
    drafts,
    autosave,
    editorText,
    type(md: string) {
      if (!doc) throw new Error('no doc open')
      drafts[doc.id] = md
      autosave.schedule(doc.id, md)
    },
    /** Select first (sync), doc arrives later — exactly the window that lost content. */
    async open(id: string) {
      void autosave.flushAll()
      selId = id
      // Editor still shows the old doc here; its text must be unchanged.
      const during = editorText()
      await tick()
      doc = { id, markdown: disk.files[id] ?? '' }
      autosave.noteSaved(id, doc.markdown)
      return during
    },
    get selId() {
      return selId
    }
  }
}

describe('autosave', () => {
  test('debounces edits and writes only the newest text', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ a: '' })
    const s = createAutosave({ save: disk.save, delayMs: 400, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    s.schedule('a', 'h')
    clock.advance(200)
    s.schedule('a', 'he')
    clock.advance(200)
    s.schedule('a', 'hey')
    expect(disk.writes).toEqual([])
    clock.advance(400)
    await tick()
    expect(disk.writes).toEqual([['a', 'hey']])
    expect(s.busy()).toBe(false)
  })

  test('edit then new tab keeps content (Untitled is flushed to its file)', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ 'Untitled.md': '', 'Untitled 1.md': '' })
    const ses = session(disk, clock)
    await ses.open('Untitled.md')
    ses.type('my untitled thoughts')
    // ⊕ new tab before the debounce fires; the new file isn't cached yet.
    const shownWhileLoading = await ses.open('Untitled 1.md')
    expect(shownWhileLoading).toBe('my untitled thoughts')
    await tick()
    expect(disk.files['Untitled.md']).toBe('my untitled thoughts')
    expect(ses.drafts['Untitled.md']).toBeUndefined()
    // Back to the first tab: content is there from disk.
    await ses.open('Untitled.md')
    expect(ses.editorText()).toBe('my untitled thoughts')
  })

  test('edit then switch keeps content', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ 'a.md': 'alpha', 'b.md': 'beta' })
    const ses = session(disk, clock)
    await ses.open('a.md')
    ses.type('alpha + edits')
    const shown = await ses.open('b.md')
    expect(shown).toBe('alpha + edits')
    expect(ses.editorText()).toBe('beta')
    await tick()
    expect(disk.files['a.md']).toBe('alpha + edits')
    await ses.open('a.md')
    expect(ses.editorText()).toBe('alpha + edits')
    expect(clock.count()).toBe(0)
  })

  test('draft is keyed by the visible doc, not the selected tab', () => {
    expect(draftForEditor({ id: 'a' }, { a: 'typed' })).toBe('typed')
    expect(draftForEditor(null, { a: 'typed' })).toBeUndefined()
  })

  test('quit flushes pending text even before the debounce', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ a: 'x', b: 'y' })
    const s = createAutosave({ save: disk.save, delayMs: 400, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    s.schedule('a', 'x1')
    s.schedule('b', 'y1')
    await s.flushAll()
    expect(disk.files).toEqual({ a: 'x1', b: 'y1' })
    expect(clock.count()).toBe(0)
    expect(s.busy()).toBe(false)
  })

  test('saves never overlap and an older write never lands after a newer one', async () => {
    const order: string[] = []
    let release: (() => void) | null = null
    const s = createAutosave({
      delayMs: 400,
      save: async (_id, md) => {
        order.push(`start:${md}`)
        if (md === 'v1') await new Promise<void>((r) => (release = r))
        order.push(`end:${md}`)
        return md
      }
    })
    s.schedule('a', 'v1')
    const first = s.flush('a')
    s.schedule('a', 'v2')
    const second = s.flush('a')
    await tick()
    expect(order).toEqual(['start:v1'])
    ;(release as unknown as () => void)()
    await Promise.all([first, second])
    expect(order).toEqual(['start:v1', 'end:v1', 'start:v2', 'end:v2'])
  })

  test('each save keeps the baseline from when its edit was queued', async () => {
    const calls: Array<[string, string | undefined]> = []
    const s = createAutosave({
      save: async (_id, md, base) => {
        calls.push([md, base])
        return md
      }
    })
    s.noteSaved('a', 'opened')
    s.schedule('a', 'local edit')
    // A sync notification must not rewrite the base of an edit already in progress.
    s.noteSaved('a', 'newer disk text')
    await s.flush('a')
    expect(calls).toEqual([['local edit', 'opened']])
  })

  test('a newer edit typed during an in-flight save is based on that in-flight text', async () => {
    const calls: Array<[string, string | undefined]> = []
    let release: (() => void) | null = null
    const s = createAutosave({
      save: async (_id, md, base) => {
        calls.push([md, base])
        if (md === 'v1') await new Promise<void>((r) => (release = r))
        return md
      }
    })
    s.noteSaved('a', 'initial')
    s.schedule('a', 'v1')
    const first = s.flush('a')
    await tick()
    s.schedule('a', 'v2')
    const second = s.flush('a')
    ;(release as unknown as () => void)()
    await Promise.all([first, second])
    expect(calls).toEqual([
      ['v1', 'initial'],
      ['v2', 'v1']
    ])
  })

  test('beforeunload drain includes the baseline needed for a safe synchronous save', () => {
    const s = createAutosave({ save: async (_id, text) => text })
    s.noteSaved('a', 'opened')
    s.schedule('a', 'typed')
    expect(s.drain()).toEqual([{ id: 'a', markdown: 'typed', base: 'opened' }])
  })

  test('skips text already on disk; keeps text when a save fails', async () => {
    let fail = true
    const writes: string[] = []
    const errors: string[] = []
    const s = createAutosave({
      save: async (_id, md) => {
        if (fail) throw new Error('disk full')
        writes.push(md)
        return md
      },
      onError: (id) => errors.push(id)
    })
    s.noteSaved('a', 'same')
    s.schedule('a', 'same')
    await s.flush('a')
    expect(writes).toEqual([])
    s.schedule('a', 'new')
    await s.flush('a')
    expect(errors).toEqual(['a'])
    expect(s.pending('a')).toBe('new')
    fail = false
    await s.flushAll()
    expect(writes).toEqual(['new'])
  })

  test('cancel drops pending text (another window owns the newer edit)', async () => {
    const disk = fakeDisk({ a: '' })
    const s = createAutosave({ save: disk.save })
    s.schedule('a', 'mine')
    s.cancel('a')
    await s.flushAll()
    expect(disk.writes).toEqual([])
  })

  test('rename carries pending text to the new id', async () => {
    const disk = fakeDisk()
    const s = createAutosave({ save: disk.save })
    s.schedule('old.md', 'text')
    s.rename('old.md', 'new.md')
    await s.flushAll()
    expect(disk.writes).toEqual([['new.md', 'text']])
  })

  test('rename re-schedules text whose save failed mid-rename (never parked until blur)', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ 'new.md': '' })
    let gone = true
    const s = createAutosave({
      // The old path is gone while the rename is in flight: that save is refused.
      save: async (id: string, md: string) => (gone && id === 'old.md' ? null : disk.save(id, md)),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    s.schedule('old.md', 'typed during rename')
    clock.advance(1000)
    await Promise.resolve()
    await Promise.resolve()
    expect(s.pending('old.md')).toBe('typed during rename')
    expect(clock.count()).toBe(0) // failed: no timer left
    gone = false
    s.rename('old.md', 'new.md')
    expect(clock.count()).toBe(1) // back on a timer under the new id
    clock.advance(1000)
    await s.flushAll()
    expect(disk.files['new.md']).toBe('typed during rename')
    expect(s.pending('new.md')).toBeUndefined()
  })

  test('drain hands back everything pending for a sync last-chance save', () => {
    const clock = fakeTimers()
    const s = createAutosave({ save: async () => null, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    s.schedule('a', '1')
    s.schedule('b', '2')
    expect(s.drain()).toEqual([
      { id: 'a', markdown: '1' },
      { id: 'b', markdown: '2' }
    ])
    expect(s.busy()).toBe(false)
    expect(clock.count()).toBe(0)
  })
})

describe('quit flush', () => {
  test('waits for every window to ack before quitting', async () => {
    const asked: Array<[number, string]> = []
    const q = createQuitFlush({ targets: () => [1, 2], request: (id, token) => asked.push([id, token]) })
    const done = q.run()
    expect(asked.map(([id]) => id)).toEqual([1, 2])
    q.ack(asked[0]![1])
    let settled = false
    void done.then(() => (settled = true))
    await tick()
    expect(settled).toBe(false)
    q.ack(asked[1]![1])
    expect(await done).toEqual({ acked: 2, timedOut: false })
  })

  test('never blocks quit forever', async () => {
    const clock = fakeTimers()
    const q = createQuitFlush({
      targets: () => [1],
      request: () => undefined,
      timeoutMs: 1500,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    })
    const done = q.run()
    clock.advance(1500)
    expect(await done).toEqual({ acked: 0, timedOut: true })
  })

  test('no windows → quits immediately; stale acks ignored', async () => {
    const q = createQuitFlush({ targets: () => [], request: () => undefined })
    q.ack('nope')
    expect(await q.run()).toEqual({ acked: 0, timedOut: false })
  })

  test('end to end: quit drains a renderer autosave before the app exits', async () => {
    const clock = fakeTimers()
    const disk = fakeDisk({ 'a.md': '' })
    const renderer = createAutosave({ save: disk.save, setTimer: clock.setTimer, clearTimer: clock.clearTimer })
    renderer.schedule('a.md', 'typed right before ⌘Q')
    const q = createQuitFlush({
      targets: () => [1],
      request: (_id, token) => void renderer.flushAll().then(() => q.ack(token))
    })
    const res = await q.run()
    expect(res.timedOut).toBe(false)
    expect(disk.files['a.md']).toBe('typed right before ⌘Q')
  })
})

describe('keepFrontmatter', () => {
  test('autosaving a body keeps the file front matter', () => {
    const file = '---\nid: abc\nkind: todo\n---\nold body\n'
    expect(keepFrontmatter(file, 'new body')).toBe('---\nid: abc\nkind: todo\n---\nnew body')
  })
  test('no front matter, or text that brings its own, is written as-is', () => {
    expect(keepFrontmatter('plain', 'next')).toBe('next')
    expect(keepFrontmatter('---\nid: a\n---\nx', '---\nid: b\n---\ny')).toBe('---\nid: b\n---\ny')
    expect(keepFrontmatter('---\nbroken', 'y')).toBe('y')
  })
})

describe('planEditorSave', () => {
  test('combines a desktop edit with an independent newer disk edit', () => {
    const current = '---\nid: a\n---\n# T\nMac edit\nlast line\n'
    const p = planEditorSave(current, '# T\nbase line\nlast line\n', '# T\nbase line\nPhone edit\n')
    expect(p).toEqual({
      file: '---\nid: a\n---\n# T\nMac edit\nPhone edit\n',
      body: '# T\nMac edit\nPhone edit\n',
      merged: true,
      conflicted: false
    })
  })

  test('keeps a true editor overlap in the original file as a marker block', () => {
    const current = '---\nid: a\n---\n# T\nMac wording\n'
    const p = planEditorSave(current, '# T\nsame line\n', '# T\nPhone wording\n')
    expect(p.conflicted).toBe(true)
    expect(p.file).toBe(
      '---\nid: a\n---\n# T\n<<<<<<< Inkfish alternative A\nMac wording\n=======\nPhone wording\n>>>>>>> Inkfish alternative B\n'
    )
  })

  test('without a known baseline, preserves both full body versions inline', () => {
    const p = planEditorSave('current\n', undefined, 'edited\n')
    expect(p.conflicted).toBe(true)
    expect(p.file).toContain('current')
    expect(p.file).toContain('edited')
  })
})
