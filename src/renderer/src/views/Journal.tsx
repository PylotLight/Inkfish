import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { NoteEntry } from '../../../shared/types'
import { dailyTitle, localDay, parseDay } from '../../../shared/daily'
import {
  entryCountLabel,
  filterDays,
  groupByMonth,
  heatLevel,
  isDailyPath,
  monthCounts,
  monthGrid,
  monthKey,
  monthLabel,
  shiftMonth,
  stepDay,
  streak,
  summarizeDay,
  type DayRef
} from '../../../shared/journal'
import { cachedBody, loadBody, useBodiesVersion } from '../dayBodies'

type Day = DayRef<NoteEntry>

interface Props {
  /** Every daily note, newest day first (from the index — no file reads). */
  days: Day[]
  onOpen: (id: string) => void
  onOpenToday: () => void
}

/** Days mounted per chunk; more mount as you scroll (content-visibility skips offscreen paint). */
const CHUNK = 60
/** Entries shown inline per day before "+N more". */
const INLINE_MAX = 24

/**
 * Journal — every daily note as one reverse-chronological timeline, grouped by month, each day's
 * entries readable inline. Built from the note index; a day's body is read only once it scrolls
 * near the viewport (until then the index snippet stands in). The filter box matches dates + text
 * (plus the full-text index for days not read yet); the rail has a month calendar to jump around.
 * Keys: j/k or ↑/↓ between days, Enter opens, / filters, t opens today.
 */
export default function Journal({ days, onOpen, onOpenToday }: Props): React.JSX.Element {
  const version = useBodiesVersion()
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [ftsIds, setFtsIds] = useState<Set<string> | null>(null)
  const [sel, setSel] = useState<string | null>(null)
  const [limit, setLimit] = useState(CHUNK)
  const today = localDay()
  const [calMonth, setCalMonth] = useState(() => monthKey(days[0]?.day ?? today))
  const rootRef = useRef<HTMLDivElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const rowEls = useRef(new Map<string, HTMLElement>())
  const ioRef = useRef<IntersectionObserver | null>(null)
  const moreIoRef = useRef<IntersectionObserver | null>(null)
  /** Day to scroll to after the next render (keyboard / calendar jumps, not mouse clicks). */
  const scrollTo = useRef<string | null>(null)

  // Debounce typing; full-text search catches words in days whose body isn't loaded yet.
  const qRef = useRef('')
  useEffect(() => {
    const t = window.setTimeout(() => {
      const next = query.trim()
      if (next === qRef.current) return
      qRef.current = next
      setQ(next)
      setLimit(CHUNK) // a new filter starts from the top chunk
    }, 140)
    return () => window.clearTimeout(t)
  }, [query])
  useEffect(() => {
    if (q.length < 2) {
      setFtsIds(null)
      return
    }
    let live = true
    window.api.notes
      .search(q)
      .then((r) => {
        if (live) setFtsIds(new Set(r.filter((n) => isDailyPath(n.path)).map((n) => n.id)))
      })
      .catch(() => {
        if (live) setFtsIds(null)
      })
    return () => {
      live = false
    }
  }, [q])

  const filtered = useMemo(
    () => filterDays(days, q, (d) => cachedBody(d.id, d.updatedAt) ?? d.snippet, ftsIds ?? undefined),
    // `version`: newly read bodies can match the filter too (cheap — hundreds of short strings).
    [days, q, ftsIds, version]
  )
  const dayList = useMemo(() => filtered.map((d) => d.day), [filtered])
  const byDay = useMemo(() => new Map(days.map((d) => [d.day, d])), [days])
  const visibleDays = useMemo(() => filtered.slice(0, limit), [filtered, limit])
  const rows = useMemo(() => groupByMonth(visibleDays), [visibleDays])
  const months = useMemo(() => monthCounts(days.map((d) => d.day)), [days])
  const run = useMemo(
    () =>
      streak(
        days.map((d) => d.day),
        today
      ),
    [days, today]
  )
  const remaining = filtered.length - visibleDays.length

  /** Make sure `day` is mounted (extend the window), select it and scroll to it. */
  const reveal = useCallback(
    (day: string) => {
      const i = dayList.indexOf(day)
      if (i >= limit) setLimit(Math.ceil((i + 1) / CHUNK) * CHUNK + CHUNK)
      scrollTo.current = day
      setSel(day)
    },
    [dayList, limit]
  )

  // Selection follows on the calendar; jumps scroll once the row is mounted.
  useEffect(() => {
    if (sel) setCalMonth(monthKey(sel))
  }, [sel])
  useEffect(() => {
    const day = scrollTo.current
    if (!day) return
    const el = rowEls.current.get(day)
    if (!el) return
    scrollTo.current = null
    el.scrollIntoView({ block: 'nearest' })
  }, [sel, limit])

  // Lazy body reads for days near the viewport, and "mount more" near the end.
  useEffect(() => {
    const root = rootRef.current?.closest('.view-scroll') ?? null
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const el = e.target as HTMLElement
          const id = el.dataset['id']
          if (id) void loadBody(id, Number(el.dataset['at']))
        }
      },
      { root, rootMargin: '600px 0px' }
    )
    ioRef.current = io
    for (const el of rowEls.current.values()) io.observe(el)
    const more = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setLimit((l) => l + CHUNK)
      },
      { root, rootMargin: '900px 0px' }
    )
    moreIoRef.current = more
    return () => {
      io.disconnect()
      more.disconnect()
      ioRef.current = null
      moreIoRef.current = null
    }
  }, [])

  // Re-arm the end sentinel after each chunk: an observer only reports changes, so a sentinel
  // still in range after mounting more would otherwise never fire again.
  useEffect(() => {
    const more = moreIoRef.current
    const s = sentinelRef.current
    if (!more || !s) return
    more.unobserve(s)
    if (remaining > 0) more.observe(s)
  }, [limit, remaining])

  const register = useCallback((day: string, el: HTMLElement | null) => {
    const prev = rowEls.current.get(day)
    if (prev && prev !== el) ioRef.current?.unobserve(prev)
    if (el) {
      rowEls.current.set(day, el)
      ioRef.current?.observe(el)
    } else {
      rowEls.current.delete(day)
    }
  }, [])

  const openDay = useCallback(
    (day: string) => {
      const d = byDay.get(day)
      if (d) onOpen(d.id)
    },
    [byDay, onOpen]
  )

  // Keyboard: j/k ↑/↓ step, Enter/o open, / filter, t today. Typing in a field is left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))
        return
      if (document.querySelector('.modal-backdrop, .ctx-scrim')) return
      const k = e.key
      if (k === 'j' || k === 'ArrowDown') {
        e.preventDefault()
        const next = stepDay(dayList, sel, 1)
        if (next) reveal(next)
      } else if (k === 'k' || k === 'ArrowUp') {
        e.preventDefault()
        const next = stepDay(dayList, sel, -1)
        if (next) reveal(next)
      } else if ((k === 'Enter' || k === 'o') && sel) {
        e.preventDefault()
        openDay(sel)
      } else if (k === '/') {
        e.preventDefault()
        filterRef.current?.focus()
        filterRef.current?.select()
      } else if (k === 't') {
        e.preventDefault()
        onOpenToday()
      } else if (k === 'Escape' && sel) {
        setSel(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dayList, sel, reveal, openDay, onOpenToday])

  const pickCalDay = (day: string): void => {
    if (byDay.has(day)) {
      if (!dayList.includes(day)) {
        // Filtered out — show everything again, then jump once the list is back.
        setQuery('')
        qRef.current = ''
        setQ('')
        scrollTo.current = day
        setLimit(Math.ceil((days.findIndex((d) => d.day === day) + 1) / CHUNK) * CHUNK + CHUNK)
        setSel(day)
        return
      }
      reveal(day)
    } else if (day === today) {
      onOpenToday()
    }
  }

  return (
    <div className="journal" ref={rootRef}>
      <header className="journal-head">
        <div>
          <h2>Journal</h2>
          <p className="muted">
            {days.length === 0
              ? 'No daily notes yet'
              : `${days.length} day${days.length === 1 ? '' : 's'}${run > 1 ? ` · ${run}-day streak` : ''}`}
          </p>
        </div>
        <div className="journal-tools">
          <input
            ref={filterRef}
            className="journal-filter"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                if (query) setQuery('')
                else e.currentTarget.blur()
              } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                e.currentTarget.blur()
                const first = dayList[0]
                if (first) reveal(first)
              }
            }}
            placeholder="Filter days…"
            aria-label="Filter daily notes"
            spellCheck={false}
          />
          <button className="btn ghost sm" onClick={onOpenToday} title="Open today's note (t)">
            Today
          </button>
        </div>
      </header>

      <div className="journal-grid">
        <div
          className="journal-timeline"
          role="listbox"
          aria-label="Daily notes"
          aria-activedescendant={sel ? `jday-${sel}` : undefined}
        >
          {days.length === 0 && (
            <p className="muted small">Days you log show up here — hit Today (⌘⇧D) or capture → Today to start one.</p>
          )}
          {days.length > 0 && filtered.length === 0 && <p className="muted small">No days match “{q}”.</p>}
          {rows.map((r) =>
            r.kind === 'month' ? (
              <h3 key={`m-${r.key}`} className="jmonth">
                <span>{r.label}</span>
                <span className="jmonth-count">{r.count}</span>
              </h3>
            ) : (
              <DayRow
                key={r.day}
                day={r.item}
                body={cachedBody(r.item.id, r.item.updatedAt)}
                today={r.day === today}
                selected={sel === r.day}
                query={q}
                register={register}
                onSelect={setSel}
                onOpen={openDay}
              />
            )
          )}
          {remaining > 0 && <div className="jmore muted small">{remaining} more…</div>}
          <div ref={sentinelRef} className="jsentinel" aria-hidden />
        </div>

        <aside className="journal-rail">
          <MonthCalendar
            month={calMonth}
            byDay={byDay}
            today={today}
            selected={sel}
            onMonth={(n) => setCalMonth((m) => shiftMonth(m, n))}
            onPick={pickCalDay}
          />
          {months.length > 1 && (
            <section className="jmonths" aria-label="Months">
              <h3 className="hsec-title">Months</h3>
              <ul>
                {months.map((m) => (
                  <li key={m.key}>
                    <button
                      className={m.key === calMonth ? 'on' : ''}
                      onClick={() => {
                        setCalMonth(m.key)
                        const first =
                          filtered.find((d) => monthKey(d.day) === m.key) ?? days.find((d) => monthKey(d.day) === m.key)
                        if (first) pickCalDay(first.day)
                      }}
                    >
                      <span>{m.label}</span>
                      <span className="jmonths-count">{m.count}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <p className="jkeys muted small">
            <kbd>j</kbd> <kbd>k</kbd> move · <kbd>↵</kbd> open · <kbd>/</kbd> filter · <kbd>t</kbd> today
          </p>
        </aside>
      </div>
    </div>
  )
}

/** Wrap matched words in <mark> (plain text in, React nodes out). */
function highlight(text: string, query: string): React.ReactNode {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  if (!words.length) return text
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((p, i) => (i % 2 === 1 ? <mark key={i}>{p}</mark> : p))
}

const DayRow = memo(function DayRow({
  day,
  body,
  today,
  selected,
  query,
  register,
  onSelect,
  onOpen
}: {
  day: Day
  body: string | undefined
  today: boolean
  selected: boolean
  query: string
  register: (day: string, el: HTMLElement | null) => void
  onSelect: (day: string) => void
  onOpen: (day: string) => void
}): React.JSX.Element {
  const loaded = body !== undefined
  const sum = useMemo(() => summarizeDay(body ?? day.snippet, loaded ? INLINE_MAX : 6), [body, day.snippet, loaded])
  const ref = useCallback((el: HTMLElement | null) => register(day.day, el), [register, day.day])
  const d = parseDay(day.day)
  const title = dailyTitle(day.day)
  const extra = sum.count - sum.entries.length
  return (
    <article
      ref={ref}
      id={`jday-${day.day}`}
      role="option"
      aria-selected={selected}
      className={`jday${selected ? ' sel' : ''}${today ? ' is-today' : ''}`}
      data-id={day.id}
      data-at={day.updatedAt}
      onMouseDown={() => onSelect(day.day)}
      onClick={() => onOpen(day.day)}
      title={`Open ${title}`}
    >
      <div className="jday-date" aria-hidden>
        <span className="jday-num">{d?.getDate() ?? ''}</span>
        <span className="jday-wd">{title.split(' ')[0]}</span>
      </div>
      <div className="jday-body">
        <div className="jday-head">
          <span className="jday-title">{title}</span>
          {today && <span className="jday-tag">today</span>}
          <span className="jday-count">{loaded && sum.count > 0 ? entryCountLabel(sum.count) : ''}</span>
        </div>
        {sum.entries.length > 0 ? (
          <ul className="jentries">
            {sum.entries.map((e, i) => (
              <li key={`${e.time}-${i}`}>
                <span className="jtime">{e.time}</span>
                <span className="jtext">
                  {e.kind && <span className="jkind">{e.kind}</span>}
                  {highlight(e.text || '…', query)}
                </span>
              </li>
            ))}
            {loaded && extra > 0 && <li className="jextra muted">+{extra} more</li>}
          </ul>
        ) : sum.text ? (
          <p className="jsnippet">{highlight(sum.text, query)}</p>
        ) : (
          <p className="jsnippet muted">{loaded ? 'Empty' : ' '}</p>
        )}
      </div>
    </article>
  )
})

const WD = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

/** Small month calendar: days with a note are tinted by how much is in them (file size). */
function MonthCalendar({
  month,
  byDay,
  today,
  selected,
  onMonth,
  onPick
}: {
  month: string
  byDay: Map<string, Day>
  today: string
  selected: string | null
  onMonth: (n: number) => void
  onPick: (day: string) => void
}): React.JSX.Element {
  const weeks = useMemo(() => monthGrid(month), [month])
  return (
    <section className="jcal" aria-label={`Calendar, ${monthLabel(month)}`}>
      <div className="jcal-head">
        <button className="jcal-nav" onClick={() => onMonth(-1)} aria-label="Previous month">
          ‹
        </button>
        <span className="jcal-title">{monthLabel(month)}</span>
        <button
          className="jcal-nav"
          onClick={() => onMonth(1)}
          aria-label="Next month"
          disabled={month >= monthKey(today)}
        >
          ›
        </button>
      </div>
      <div className="jcal-grid">
        {WD.map((w, i) => (
          <span key={`h${i}`} className="jcal-wd" aria-hidden>
            {w}
          </span>
        ))}
        {weeks.flat().map((cell, i) => {
          if (!cell) return <span key={`p${i}`} className="jcal-cell is-pad" />
          const note = byDay.get(cell)
          const lvl = note ? Math.max(1, heatLevel(note.size)) : 0
          const isToday = cell === today
          return (
            <button
              key={cell}
              className={`jcal-cell lvl-${lvl}${isToday ? ' is-today' : ''}${selected === cell ? ' sel' : ''}`}
              disabled={!note && !isToday}
              onClick={() => onPick(cell)}
              title={note ? dailyTitle(cell) : isToday ? 'Start today' : undefined}
              aria-label={`${dailyTitle(cell)}${note ? '' : ' (no note)'}`}
            >
              {Number(cell.slice(8))}
            </button>
          )
        })}
      </div>
    </section>
  )
}
