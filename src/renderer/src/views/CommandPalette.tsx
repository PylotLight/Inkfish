import { useEffect, useMemo, useRef, useState } from 'react'
import {
  parseRecent,
  rankPalette,
  recordRecent,
  type PaletteCommand,
  type PaletteItem,
  type PaletteMode,
  type PaletteNote
} from '../../../shared/command-palette'
import './CommandPalette.css'

const RECENT_KEY = 'inkfish.palette.recent.v1'

function loadRecent(): string[] {
  try {
    return parseRecent(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'))
  } catch {
    return []
  }
}

function saveRecent(keys: string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(keys))
  } catch {
    // ignore
  }
}

export interface RunnableCommand extends PaletteCommand {
  run: () => void
}

/**
 * ⌘K command palette + ⌘O note switcher (ported from Surffish's palette, PR #67).
 * Type to fuzzy-find notes and commands; `>` lists commands only. ↑↓ / ⌃N ⌃P move,
 * ↩ opens, ⌘↩ pops a note out to a mini window, Esc closes.
 */
export default function CommandPalette({
  mode,
  commands,
  notes,
  platform,
  onOpenNote,
  onClose
}: {
  mode: PaletteMode
  commands: RunnableCommand[]
  notes: PaletteNote[]
  platform: string
  onOpenNote: (id: string, popOut: boolean) => void
  onClose: () => void
}): React.JSX.Element {
  const [input, setInput] = useState('')
  const [active, setActive] = useState(0)
  const [recent, setRecent] = useState<string[]>(loadRecent)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const items = useMemo(
    () => rankPalette({ input, mode, commands, notes, recent, platform }),
    [input, mode, commands, notes, recent, platform]
  )

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setActive(0), [input, mode])
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const choose = (item: PaletteItem | undefined, popOut = false): void => {
    if (!item) return
    const next = recordRecent(recent, item.key)
    setRecent(next)
    saveRecent(next)
    onClose()
    if (item.kind === 'note') onOpenNote(item.noteId, popOut)
    else commands.find((c) => c.id === item.commandId)?.run()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const down = e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')
    const up = e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')
    if (down || up) {
      e.preventDefault()
      if (items.length) setActive((i) => (i + (down ? 1 : -1) + items.length) % items.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      choose(items[active], e.metaKey || e.ctrlKey)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const placeholder =
    mode === 'notes'
      ? 'Open a note…'
      : mode === 'commands'
        ? 'Run a command…'
        : 'Find a note or command…  (> for commands)'

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette glass strong"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={input}
          placeholder={placeholder}
          spellCheck={false}
          aria-label="Command palette search"
          aria-controls="palette-list"
          aria-activedescendant={items[active] ? `palette-${active}` : undefined}
          onChange={(e) => setInput(e.target.value)}
        />
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef}>
          {items.length === 0 && <div className="palette-empty muted small">No matches</div>}
          {items.map((item, index) => (
            <div
              key={item.key}
              id={`palette-${index}`}
              data-index={index}
              role="option"
              aria-selected={index === active}
              className={`palette-item${index === active ? ' on' : ''}`}
              onMouseMove={() => index !== active && setActive(index)}
              onClick={(e) => choose(item, e.metaKey || e.ctrlKey)}
            >
              <span className="palette-icon" aria-hidden>
                {item.kind === 'note' ? '▤' : '›'}
              </span>
              <span className="palette-text">
                <span className="palette-title">{item.title}</span>
                <span className="palette-sub muted small">{item.subtitle}</span>
              </span>
              {item.kind === 'command' && item.shortcut && <kbd className="palette-kbd">{item.shortcut}</kbd>}
            </div>
          ))}
        </div>
        <div className="palette-foot muted small">
          <span>↑↓ move</span>
          <span>↩ open</span>
          <span>{platform === 'darwin' ? '⌘' : 'Ctrl+'}↩ mini window</span>
          <span>&gt; commands</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  )
}
