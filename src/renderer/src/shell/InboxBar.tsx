import { useState } from 'react'
import type { InboxItem, Project } from '../../../shared/types'
import { routeSummary } from '../../../shared/routing'

/** Action bar pinned above inbox docs: route / move / undo / delete without leaving the note. */
export default function InboxBar({
  item,
  projects,
  onDone,
  onDelete,
  notify
}: {
  item: InboxItem
  projects: Project[]
  onDone: (noteId?: string) => void
  onDelete: () => void
  notify: (msg: string) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, ok: (r: unknown) => void, failMsg: string): Promise<void> => {
    setBusy(true)
    try {
      ok(await fn())
    } catch (err) {
      notify(`${failMsg}: ${err instanceof Error ? err.message : String(err)}`)
      setBusy(false)
    }
  }

  return (
    <div className="inboxbar glass">
      <span className="qsub muted" title={item.route ? `${item.route.provider} · ${item.route.reason}` : undefined}>
        {item.kind}
        {item.status === 'processing'
          ? ' · routing…'
          : item.route
            ? ` · ${routeSummary(item.route, item.status)}${item.status === 'ready' ? ' ✓' : ` · ${item.route.reason}`}`
            : item.status === 'ready'
              ? ' · ready ✓'
              : ''}
      </span>
      <span className="flex-sp" />
      {item.status !== 'processing' && (
        <button
          className="btn mint sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.api.inbox.process(item.id),
              (r) => {
                const res = r as Awaited<ReturnType<typeof window.api.inbox.process>>
                if ('error' in res) {
                  notify(`Route issue: ${res.error}`)
                  onDone()
                } else if (res.note) {
                  notify(`Routed ✓ ${routeSummary(res.route, 'ready')}`)
                  onDone(res.note.id)
                } else {
                  notify(`Left in inbox: ${res.route.reason}`)
                  onDone()
                }
              },
              'Route failed'
            )
          }
        >
          Route now
        </button>
      )}
      <select
        className="sm"
        defaultValue=""
        disabled={busy}
        aria-label="Move to folder"
        onChange={(e) => {
          const v = e.target.value
          if (!v) return
          e.target.value = ''
          void run(
            () => window.api.inbox.reassign(item.id, v),
            (r) => {
              const res = r as Awaited<ReturnType<typeof window.api.inbox.reassign>>
              if ('error' in res) {
                notify(`Move failed: ${res.error}`)
                onDone()
                return
              }
              notify(`Moved → ${v}`)
              onDone(res.note ?? undefined)
            },
            'Move failed'
          )
        }}
      >
        <option value="">Move →</option>
        {projects.map((p) => (
          <option key={p.id} value={p.name}>
            {p.name}
          </option>
        ))}
      </select>
      {item.status === 'ready' && (
        <button
          className="btn ghost sm"
          disabled={busy}
          onClick={() =>
            void run(
              () => window.api.inbox.undo(item.id),
              () => {
                notify('Undone — raw kept')
                onDone()
              },
              'Undo failed'
            )
          }
        >
          Undo
        </button>
      )}
      <button className="btn ghost sm danger-quiet" disabled={busy} onClick={onDelete} title="Delete permanently">
        Delete
      </button>
    </div>
  )
}
