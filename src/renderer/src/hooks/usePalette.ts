import { useEffect, useMemo, useRef, useState } from 'react'
import type { NoteEntry } from '../../../shared/types'
import type { PaletteMode } from '../../../shared/command-palette'
import { buildPaletteCommands, type PaletteCommandContext } from '../shell/palette-commands'

export interface PaletteInput extends Omit<PaletteCommandContext, 'activeTab'> {
  allNotes: NoteEntry[]
  openSettings: () => void
}

/**
 * ⌘K command palette / ⌘O note switcher: open state, the command list
 * (buildPaletteCommands), the note list, and the global shortcuts
 * (⌘K, ⌘O, ⇧⌘P, ⌘, settings, ⌘⇧D today, ⌘⇧J journal).
 */
export function usePalette(input: PaletteInput) {
  const {
    allNotes,
    openSettings,
    activeNoteId,
    tabs,
    titleOf,
    openSettingsAt,
    leaveSettings,
    openToday,
    openJournal,
    ...rest
  } = input

  const [palette, setPalette] = useState<PaletteMode | null>(null)
  const activeTab = activeNoteId ? (tabs.find((t) => t.id === activeNoteId) ?? null) : null
  const paletteCommands = buildPaletteCommands({
    ...rest,
    activeTab,
    titleOf,
    openSettingsAt,
    leaveSettings,
    openToday,
    openJournal,
    activeNoteId,
    tabs
  })
  const paletteNotes = useMemo(
    () => allNotes.map((n) => ({ id: n.id, title: titleOf(n), path: n.path, tags: n.tags, updatedAt: n.updatedAt })),
    [allNotes, titleOf]
  )

  // ⌘K palette, ⌘O notes only, ⇧⌘P commands only, ⌘, settings. Capture phase so the editor
  // can't swallow them; pressing the same shortcut again closes the palette.
  const paletteRef = useRef<PaletteMode | null>(null)
  paletteRef.current = palette
  const openSettingsRef = useRef(openSettings)
  openSettingsRef.current = openSettings
  // "Open Settings › AI" from an AI error in the editor.
  const openSettingsAtRef = useRef(openSettingsAt)
  openSettingsAtRef.current = openSettingsAt
  useEffect(() => {
    const onOpen = (e: Event): void => openSettingsAtRef.current(String((e as CustomEvent<string>).detail || 'ai'))
    window.addEventListener('inkfish:open-settings', onOpen)
    return () => window.removeEventListener('inkfish:open-settings', onOpen)
  }, [])
  const openJournalRef = useRef<() => void>(() => undefined)
  const openTodayRef = useRef(() => {
    leaveSettings()
    void openToday()
  })
  openTodayRef.current = () => {
    leaveSettings()
    void openToday()
  }
  openJournalRef.current = () => openJournal()
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return
      const key = e.key.toLowerCase()
      let mode: PaletteMode | null = null
      if (key === 'k' && !e.shiftKey) mode = 'all'
      else if (key === 'o' && !e.shiftKey) mode = 'notes'
      else if (key === 'p' && e.shiftKey) mode = 'commands'
      else if (key === ',' && !e.shiftKey) {
        e.preventDefault()
        openSettingsRef.current()
        return
      } else if (key === 'd' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openTodayRef.current()
        return
      } else if (key === 'j' && e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        openJournalRef.current()
        return
      }
      if (!mode) return
      e.preventDefault()
      e.stopPropagation()
      setPalette(paletteRef.current === mode ? null : mode)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  return { palette, setPalette, paletteCommands, paletteNotes }
}
