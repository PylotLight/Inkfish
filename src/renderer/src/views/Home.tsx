import { useEffect, useMemo, useState } from 'react'
import type { InboxItem, NoteEntry } from '../../../shared/types'
import { plain, timeAgo } from '../text'
import { dailyTitle, localDay, parseEntries } from '../../../shared/daily'
import { entryCountLabel, summarizeDay, type DayRef } from '../../../shared/journal'
import { cachedBody, loadBody, useBodiesVersion } from '../dayBodies'

interface Props {
  notes: NoteEntry[]
  inbox: InboxItem[]
  /** Today's day-log index entry, if one exists yet (lives in staging, not the tree). */
  today: NoteEntry | null
  /** Every daily note, newest day first (index rows — bodies are read lazily for the cards). */
  days: Array<DayRef<NoteEntry>>
  onOpenJournal: () => void
  titleOf: (n: NoteEntry) => string
  onOpenNote: (id: string) => void
  onOpenInbox: () => void
  onOpenToday: () => void
  onTodayAppended: () => void
  onOpenFolder: (rel: string | null) => void
  notify: (msg: string) => void
}

/** Parent folder of a vault-relative path ('' for root). */
function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

/**
 * Launch default. Full-width, card-light layout: an open stat strip, a ruled
 * "Latest" list as the main column, and inbox + folders as a quiet side rail.
 * Today / Meetings live in the sidebar quick actions only — no duplicates here.
 * Accent is reserved for state: pending inbox count, hover affordances.
 */
export default function Home({
  notes, inbox, today, days, onOpenJournal, titleOf, onOpenNote, onOpenInbox, onOpenToday, onTodayAppended, onOpenFolder, notify
}: Props): React.JSX.Element {
  const latest = useMemo(
    () => [...notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12),
    [notes]
  )
  const pending = useMemo(
    () => inbox.filter((i) => i.status === 'inbox' || i.status === 'processing'),
    [inbox]
  )
  const topFolders = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of notes) {
      const top = n.path.split('/')[0]
      if (top && n.path.includes('/')) m.set(top, (m.get(top) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
  }, [notes])
  const maxFolder = topFolders[0]?.[1] ?? 1
  const editedToday = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return notes.filter((n) => n.updatedAt >= start.getTime()).length
  }, [notes])

  return (
    <div className="home">
      <header className="home-head">
        <h2>Home</h2>
        <p className="muted">
          {pending.length > 0 ? `${pending.length} waiting in inbox` : 'Inbox zero'}
        </p>
      </header>

      <div className="home-stats" role="list">
        <div className="hstat" role="listitem">
          <span className="hstat-value">{notes.length}</span>
          <span className="hstat-label">Notes</span>
        </div>
        <div className="hstat" role="listitem">
          <span className="hstat-value">{topFolders.length}</span>
          <span className="hstat-label">Folders</span>
        </div>
        <div className="hstat" role="listitem">
          <span className="hstat-value">{editedToday}</span>
          <span className="hstat-label">Edited today</span>
        </div>
        <button
          className={`hstat as-btn${pending.length > 0 ? ' live' : ''}`}
          role="listitem"
          onClick={onOpenInbox}
        >
          <span className="hstat-value">{pending.length}</span>
          <span className="hstat-label">Inbox</span>
        </button>
      </div>

      <TodaySection entry={today} onOpenToday={onOpenToday} onAppended={onTodayAppended} notify={notify} />

      <DailySection days={days} onOpenNote={onOpenNote} onOpenJournal={onOpenJournal} />

      <div className="home-grid">
        <section className="hsec" aria-label="Latest notes">
          <h3 className="hsec-title">Latest</h3>
          {latest.length === 0 && <p className="muted small">Nothing yet — ⌥Space to capture.</p>}
          <ul className="hrows">
            {latest.map((n) => (
              <li key={n.id}>
                <button className="hrow" onClick={() => onOpenNote(n.id)}>
                  <span className="hrow-title">{titleOf(n).slice(0, 90)}</span>
                  <span className="hrow-path">{dirOf(n.path) || '/'}</span>
                  <span className="hrow-time">{timeAgo(n.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <aside className="home-rail">
          <section className="hsec" aria-label="Needs attention">
            <h3 className="hsec-title">Needs attention</h3>
            {pending.length === 0 && <p className="muted small hsec-empty">Nothing waiting.</p>}
            <ul className="hrows">
              {pending.slice(0, 5).map((i) => (
                <li key={i.id}>
                  <button className="hrow stack" onClick={onOpenInbox}>
                    <span className="hrow-title">{plain(i.raw).slice(0, 90) || '(empty)'}</span>
                    <span className="hrow-path">
                      {i.kind} · {i.status === 'processing' ? 'routing…' : 'waiting'} · {timeAgo(i.createdAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {pending.length > 5 && (
              <button className="hlink" onClick={onOpenInbox}>
                Open inbox ({pending.length}) →
              </button>
            )}
          </section>

          {topFolders.length > 0 && (
            <section className="hsec" aria-label="Top folders">
              <h3 className="hsec-title">Folders</h3>
              <ul className="hrows">
                {topFolders.map(([name, count]) => (
                  <li key={name}>
                    <button className="hfolder" onClick={() => onOpenFolder(name)}>
                      <span className="hfolder-name">{name}</span>
                      <span className="hfolder-count">{count}</span>
                      <span className="hfolder-bar" aria-hidden>
                        <span style={{ width: `${Math.max(4, (count / maxFolder) * 100)}%` }} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  )
}

/** Today's day-log at a glance: latest entries + a quick-append box. */
function TodaySection({
  entry, onOpenToday, onAppended, notify
}: {
  entry: NoteEntry | null
  onOpenToday: () => void
  onAppended: () => void
  notify: (msg: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [sections, setSections] = useState<Array<{ time: string; text: string }>>([])

  // Read the note's timestamped entries (`- HH:MM …`, or older `## HH:MM` sections) for the preview.
  useEffect(() => {
    if (!entry) {
      setSections([])
      return
    }
    let live = true
    window.api.notes
      .get(entry.id)
      .then((doc) => {
        if (!live || !doc) return
        const secs = parseEntries(doc.markdown).map((e) => ({ time: e.time, text: plain(e.text).slice(0, 120) }))
        setSections(secs.slice(-3).reverse())
      })
      .catch(console.error)
    return () => {
      live = false
    }
  }, [entry?.id, entry?.updatedAt])

  const append = async (): Promise<void> => {
    const body = draft.trim()
    if (!body || busy) return
    setBusy(true)
    try {
      await window.api.daily.append(body, 'text')
      setDraft('')
      onAppended()
      notify("Added to today's note ☀")
    } catch (err: unknown) {
      notify(`Append failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="hsec htoday" aria-label="Today's log">
      <div className="htoday-head">
        <h3 className="hsec-title">Today</h3>
        <button className="hlink" onClick={onOpenToday}>
          Open →
        </button>
      </div>
      {sections.length === 0 && (
        <p className="muted small hsec-empty">
          Nothing logged yet — jot the first line below.
        </p>
      )}
      {sections.length > 0 && (
        <ul className="hrows">
          {sections.map((s, i) => (
            <li key={`${s.time}-${i}`}>
              <div className="hrow static">
                <span className="hrow-title">{s.text || '(empty)'}</span>
                <span className="hrow-time">{s.time}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <div className="htoday-add">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void append()
          }}
          placeholder="Log an update to today…"
          aria-label="Log an update to today"
        />
        <button className="btn mint sm" disabled={!draft.trim() || busy} onClick={() => void append()}>
          {busy ? 'Appending…' : 'Append'}
        </button>
      </div>
    </section>
  )
}

/** Cards on Home for the latest past days (today has its own strip above). */
const DAILY_CARDS = 6

/**
 * Daily — the last few day notes as compact cards (date, entry count, first lines), kept apart
 * from Latest so regular notes don't get buried under dates. "Journal" opens the full timeline.
 */
function DailySection({
  days, onOpenNote, onOpenJournal
}: {
  days: Array<DayRef<NoteEntry>>
  onOpenNote: (id: string) => void
  onOpenJournal: () => void
}): React.JSX.Element | null {
  useBodiesVersion()
  const today = localDay()
  const recent = useMemo(() => days.filter((d) => d.day !== today).slice(0, DAILY_CARDS), [days, today])
  // Six small reads at most; cached by (id, updatedAt) so Home re-renders don't refetch.
  useEffect(() => {
    for (const d of recent) void loadBody(d.id, d.updatedAt)
  }, [recent])
  if (days.length === 0) return null
  return (
    <section className="hsec hdaily" aria-label="Daily notes">
      <div className="htoday-head">
        <h3 className="hsec-title">Daily</h3>
        <button className="hlink" onClick={onOpenJournal}>
          Journal{days.length > 1 ? ` · ${days.length} days` : ''} →
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="muted small hsec-empty">Only today so far — past days collect here.</p>
      ) : (
        <div className="hdaily-grid">
          {recent.map((d) => {
            const body = cachedBody(d.id, d.updatedAt)
            const sum = summarizeDay(body ?? d.snippet, 2)
            return (
              <button key={d.id} className="hday" onClick={() => onOpenNote(d.id)} title={`Open ${dailyTitle(d.day)}`}>
                <span className="hday-head">
                  <span className="hday-title">{dailyTitle(d.day)}</span>
                  <span className="hday-count">{body !== undefined && sum.count > 0 ? entryCountLabel(sum.count) : ''}</span>
                </span>
                {sum.entries.length > 0 ? (
                  sum.entries.map((e, i) => (
                    <span key={`${e.time}-${i}`} className="hday-line">
                      <span className="hday-time">{e.time}</span>
                      <span className="hday-text">{e.text || '…'}</span>
                    </span>
                  ))
                ) : (
                  <span className="hday-line muted">
                    <span className="hday-text">{sum.text || (body !== undefined ? 'Empty' : ' ')}</span>
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}
