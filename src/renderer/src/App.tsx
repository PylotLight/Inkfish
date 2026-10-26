import { useMemo } from 'react'
import { useVaultData } from './hooks/useVaultData'
import { useShellUi } from './hooks/useShellUi'
import { useCtxMenu } from './hooks/useCtxMenu'
import { useNoteWorkspace } from './hooks/useNoteWorkspace'
import type { NoteEntry, NoteKind } from '../../shared/types'
import { dailyTitle, dayOfPath, localDay } from '../../shared/daily'
import Capture from './views/Capture'
import { type Scope } from './shell/types'
import { dailyRefs } from '../../shared/journal'
import MiniNote, { isMiniWindow } from './views/MiniNote'
import Sidebar from './shell/Sidebar'
import Center from './shell/Center'
import Overlays from './shell/Overlays'
import { usePalette } from './hooks/usePalette'
import { useBrandTripleClick } from './views/easter-egg/BrandEasterEgg'
import { foldersOf } from '../../shared/note-move'

/** Popover windows load the same bundle with `#capture` — render capture only. */
export function isCaptureWindow(): boolean {
  return (
    typeof window !== 'undefined' && (window.location.hash === '#capture' || window.location.hash === '#capture-daily')
  )
}

export default function App(): React.JSX.Element {
  if (isCaptureWindow()) {
    return (
      <div className="capture-shell">
        <Capture />
      </div>
    )
  }
  if (isMiniWindow()) return <MiniNote />
  return <Main />
}

function Main(): React.JSX.Element {
  const {
    sys,
    profile,
    isMacUi,
    captureKey,
    projects,
    allNotes,
    allNotesRef,
    inbox,
    vaultInfo,
    backend,
    setBackend,
    titles,
    setTitles,
    setAllNotes,
    titleNamedRef,
    refreshTitleNamed,
    notify,
    toast,
    refreshInbox,
    refreshProjects,
    refreshNotes,
    refreshAll,
    showOnboarding,
    setShowOnboarding,
    ostep,
    setOstep,
    onVaultReady
  } = useVaultData()
  const {
    scope,
    setScope,
    settingsOpen,
    setSettingsOpen,
    settingsReturn,
    settingsNonce,
    kind,
    setKind,
    targetDir,
    setTargetDir,
    revealDir,
    setRevealDir,
    query,
    setQuery,
    results,
    showMeeting,
    setShowMeeting,
    meetingLive,
    setMeetingLive,
    prefs,
    setPrefs,
    updateBadge,
    sideCollapsed,
    setSideCollapsed,
    pickDir,
    openSettings,
    openSettingsAt,
    leaveSettings
  } = useShellUi({ allNotesRef })
  const brandEgg = useBrandTripleClick()
  const {
    sel,
    setSel,
    doc,
    setDoc,
    tabs,
    drafts,
    docsCache,
    movePick,
    setMovePick,
    prompt,
    setPrompt,
    confirm,
    setConfirm,
    treeRename,
    setTreeRename,
    delAsk,
    setDelAsk,
    undoDel,
    setUndoDel,
    tabsRef,
    selRef,
    autosave,
    titleSync,
    flushAll,
    openEntry,
    handleDraft,
    selectInbox,
    selectNote,
    focusEnd,
    focusEndOn,
    openToday,
    deleteInbox,
    closeTab,
    togglePin,
    closeOthers,
    closeUnpinned,
    activeNoteId,
    popOut,
    popTitle,
    renameNote,
    titleOf,
    doCreateFile,
    doCreateFolder,
    doMove,
    openMovePicker,
    setNoteTags,
    doRename,
    trashWithUndo,
    undoTrash,
    closeUndo,
    doTrash,
    rowEl,
    deleteNote,
    startNoteRename,
    rowActions
  } = useNoteWorkspace({
    allNotes,
    setAllNotes,
    allNotesRef,
    inbox,
    titles,
    setTitles,
    titleNamedRef,
    refreshTitleNamed,
    refreshNotes,
    refreshInbox,
    refreshProjects,
    refreshAll,
    notify,
    scope,
    setScope,
    targetDir,
    setTargetDir,
    revealDir,
    setRevealDir,
    prefs,
    settingsOpen,
    setSettingsOpen
  })

  /** Context menu items for a tree target, the open note, or a tab. */
  const { menu, setMenu, menuItems } = useCtxMenu({
    tabsRef,
    allNotesRef,
    doc,
    sel,
    titleOf,
    doCreateFile,
    doRename,
    doTrash,
    startNoteRename,
    deleteNote,
    notify,
    refreshNotes,
    togglePin,
    closeTab,
    closeOthers,
    closeUnpinned,
    popOut,
    openMovePicker,
    setPrompt,
    setRevealDir
  })

  // --- derived -------------------------------------------------------------------
  // Staging (inbox/daily working state) lives in app data and is surfaced via
  // the Inbox tab + Today — never as folders in the vault tree or Home.
  const finalNotes = useMemo(
    () => allNotes.filter((n) => !n.path.startsWith('inbox/') && !n.path.startsWith('daily/')),
    [allNotes]
  )
  /** Folder picker choices: every folder holding a note. */
  const folderList = useMemo(() => foldersOf(finalNotes.map((n) => n.path)), [finalNotes])
  /** Tag chip autocomplete: every tag in the vault, A→Z. */
  const allTags = useMemo(() => {
    const m = new Map<string, string>()
    for (const n of finalNotes) for (const t of n.tags) if (!m.has(t.toLowerCase())) m.set(t.toLowerCase(), t)
    return [...m.values()].sort((a, b) => a.localeCompare(b))
  }, [finalNotes])
  const kindCounts = useMemo(() => {
    const m = new Map<NoteKind, number>()
    for (const n of finalNotes) m.set(n.kind, (m.get(n.kind) ?? 0) + 1)
    return m
  }, [finalNotes])
  const kindsPresent = kindCounts.size

  /** Today's day-log index entry, if one exists yet (staging `daily/…`, not the tree). */
  const todayEntry = useMemo(() => {
    const d = new Date()
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return allNotes.find((n) => n.path === `daily/${day}.md`) ?? null
  }, [allNotes])

  /** Every daily note, newest day first — Home's Daily cards + the Journal (index rows only). */
  const journalDays = useMemo(() => dailyRefs(allNotes), [allNotes])

  /** Day notes that exist, oldest first (`YYYY-MM-DD` → entry). */
  const dayNotes = useMemo(() => {
    const out: Array<{ day: string; entry: NoteEntry }> = []
    for (const n of allNotes) {
      const day = dayOfPath(n.path)
      if (day) out.push({ day, entry: n })
    }
    return out.sort((a, b) => a.day.localeCompare(b.day))
  }, [allNotes])
  /** Previous / next existing day note around the open one (skips days with no note). Stepping
   *  forward past the last one onto today opens (and creates) today's note. */
  const openDay = dayOfPath(doc?.path ?? '')
  const dayNav = useMemo(() => {
    if (!openDay) return null
    const today = localDay()
    const prev = [...dayNotes].reverse().find((d) => d.day < openDay) ?? null
    const next = dayNotes.find((d) => d.day > openDay) ?? null
    const toToday = !next && openDay < today
    return {
      prev,
      next,
      toToday,
      onPrev: prev
        ? () => {
            selectNote(prev.entry.id)
            focusEndOn(prev.entry.id)
          }
        : null,
      onNext: next
        ? () => {
            selectNote(next.entry.id)
            focusEndOn(next.entry.id)
          }
        : toToday
          ? () => void openToday()
          : null,
      prevLabel: prev ? dailyTitle(prev.day) : undefined,
      nextLabel: next ? dailyTitle(next.day) : toToday ? `${dailyTitle(today)} (today)` : undefined
    }
  }, [openDay, dayNotes, selectNote, openToday, focusEndOn])

  const pickScope = (s: Scope): void => {
    setScope(s)
    if (s === 'home' || s === 'journal') {
      void autosave.flushAll()
      // Tabs stay open (Obsidian-style) — just park the active selection.
      setSel(null)
      setDoc(null)
    } else if (s === 'notes' && !selRef.current && tabsRef.current.length > 0) {
      const last = tabsRef.current[tabsRef.current.length - 1]
      if (last) openEntry(last.id, 'note')
    }
  }

  const pendingCount = inbox.filter((i) => i.status === 'inbox' || i.status === 'processing').length
  const activeItem = scope === 'inbox' ? (inbox.find((i) => i.id === sel?.id) ?? null) : null
  const openPath = sel?.origin === 'note' ? (doc?.path ?? allNotes.find((n) => n.id === sel.id)?.path ?? null) : null

  // --- ⌘K command palette / ⌘O note switcher (ported from Surffish) -------------------
  /** The Journal: every daily note as one timeline (sidebar button, ribbon, Home → Daily, ⌘⇧J). */
  const openJournal = (): void => {
    leaveSettings()
    setShowMeeting(false)
    pickScope('journal')
  }
  const { palette, setPalette, paletteCommands, paletteNotes } = usePalette({
    allNotes,
    openSettings,
    leaveSettings,
    doCreateFile,
    targetDir,
    doCreateFolder,
    openToday,
    openJournal,
    dayNav,
    setSideCollapsed,
    openPath,
    doRename,
    doc,
    openMovePicker,
    titleOf,
    setQuery,
    setBackend,
    refreshAll,
    notify,
    pickScope,
    meetingLive,
    setShowMeeting,
    showMeeting,
    activeNoteId,
    popOut,
    tabs,
    closeTab,
    closeOthers,
    togglePin,
    openSettingsAt
  })

  return (
    <div className={`shell${sideCollapsed ? ' side-collapsed' : ''}`} data-platform={sys?.platform ?? 'unknown'}>
      <Sidebar
        sideCollapsed={sideCollapsed}
        setSideCollapsed={setSideCollapsed}
        scope={scope}
        setScope={setScope}
        settingsOpen={settingsOpen}
        showMeeting={showMeeting}
        meetingLive={meetingLive}
        pendingCount={pendingCount}
        updateBadge={updateBadge}
        isMacUi={isMacUi}
        profile={profile}
        onBrandEggClick={brandEgg.onClick}
        query={query}
        setQuery={setQuery}
        pickScope={pickScope}
        openToday={openToday}
        openJournal={openJournal}
        leaveSettings={leaveSettings}
        openSettings={openSettings}
        openSettingsAt={openSettingsAt}
        setShowMeeting={setShowMeeting}
        inbox={inbox}
        projects={projects}
        sel={sel}
        selectInbox={selectInbox}
        deleteInbox={deleteInbox}
        refreshAll={refreshAll}
        notify={notify}
        captureKey={captureKey}
        finalNotes={finalNotes}
        kind={kind}
        setKind={setKind}
        titleOf={titleOf}
        results={results}
        revealDir={revealDir}
        selectNote={selectNote}
        pickDir={pickDir}
        setMenu={(menu) => setMenu(menu)}
        doCreateFile={doCreateFile}
        doCreateFolder={doCreateFolder}
        targetDir={targetDir}
        doMove={(rel, k, dest) => void doMove(rel, k, dest)}
        rowActions={rowActions}
        kindsPresent={kindsPresent}
        kindCounts={kindCounts}
        openPath={openPath}
        vaultInfo={vaultInfo}
        sys={sys}
      />

      {/* Center: home dashboard, note stage, or full-page settings. */}
      <Center
        sideCollapsed={sideCollapsed}
        meetingLive={meetingLive}
        showMeeting={showMeeting}
        leaveSettings={leaveSettings}
        setShowMeeting={setShowMeeting}
        settingsOpen={settingsOpen}
        settingsNonce={settingsNonce}
        prefs={prefs}
        sys={sys}
        vaultInfo={vaultInfo}
        backend={backend}
        setPrefs={setPrefs}
        setSettingsOpen={setSettingsOpen}
        setScope={setScope}
        settingsReturn={settingsReturn}
        setOstep={setOstep}
        setShowOnboarding={setShowOnboarding}
        notify={notify}
        refreshAll={refreshAll}
        setBackend={setBackend}
        scope={scope}
        captureKey={captureKey}
        finalNotes={finalNotes}
        inbox={inbox}
        todayEntry={todayEntry}
        journalDays={journalDays}
        openJournal={openJournal}
        titleOf={titleOf}
        selectNote={selectNote}
        pickScope={pickScope}
        openToday={openToday}
        setTargetDir={setTargetDir}
        setRevealDir={setRevealDir}
        focusEndOn={focusEndOn}
        tabs={tabs}
        allNotes={allNotes}
        titles={titles}
        sel={sel}
        openEntry={openEntry}
        closeTab={closeTab}
        togglePin={togglePin}
        setMenu={(menu) => setMenu(menu)}
        doCreateFile={doCreateFile}
        targetDir={targetDir}
        popOut={popOut}
        popTitle={popTitle}
        activeItem={activeItem}
        projects={projects}
        deleteInbox={deleteInbox}
        doc={doc}
        drafts={drafts}
        handleDraft={handleDraft}
        flushAll={flushAll}
        renameNote={renameNote}
        onEditorBlur={() => titleSync.flush()}
        dayNav={dayNav}
        focusEnd={focusEnd}
        openMovePicker={openMovePicker}
        setNoteTags={(t) => void setNoteTags(t)}
        setSideCollapsed={setSideCollapsed}
        setQuery={setQuery}
        allTags={allTags}
        setMeetingLive={setMeetingLive}
      />

      <Overlays
        menu={menu}
        menuItems={menuItems}
        setMenu={setMenu}
        palette={palette}
        paletteCommands={paletteCommands}
        paletteNotes={paletteNotes}
        sys={sys}
        setPalette={setPalette}
        popOut={popOut}
        leaveSettings={leaveSettings}
        selectNote={selectNote}
        prompt={prompt}
        setPrompt={setPrompt}
        confirm={confirm}
        setConfirm={setConfirm}
        showOnboarding={showOnboarding}
        ostep={ostep}
        setOstep={setOstep}
        vaultInfo={vaultInfo}
        profile={profile}
        onVaultReady={onVaultReady}
        setShowOnboarding={setShowOnboarding}
        notify={notify}
        movePick={movePick}
        folderList={folderList}
        setMovePick={setMovePick}
        doMove={doMove}
        delAsk={delAsk}
        setDelAsk={setDelAsk}
        trashWithUndo={trashWithUndo}
        rowEl={rowEl}
        undoDel={undoDel}
        closeUndo={closeUndo}
        undoTrash={undoTrash}
        toast={toast}
        brandEgg={brandEgg}
      />
    </div>
  )
}
