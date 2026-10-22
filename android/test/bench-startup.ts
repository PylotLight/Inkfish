/**
 * Android startup benchmark: a 2,000-note vault with images on a simulated
 * phone file system (bridge latency on every expo-file-system call, same cost
 * model as scripts/bench-sync.ts). Measures what the user waits on:
 *
 *   first render  — the shell (home + drawer) can paint
 *   drawer        — the drawer has the vault's notes in it
 *   open note     — tap a drawer row → its page is on screen
 *
 *   bun android/test/bench-startup.ts [--notes 2000] [--images 300] [--scale 1] [--json]
 *   bun android/test/bench-startup.ts --legacy   # the android-v0.2.7 boot order
 *
 * `--legacy` replays the old StoreProvider sequence (ensureTree → full index →
 * ready, nothing on screen before). Run it on an android-v0.2.7 checkout for the
 * old numbers. Times are simulated wall-clock (real sleeps), not a device measurement.
 */
import { mock } from 'bun:test'
import { FakeFs, seedVault } from './helpers/fakefs'

const arg = (k: string, d: number): number => {
  const i = process.argv.indexOf(`--${k}`)
  return i > 0 ? Number(process.argv[i + 1]) : d
}
const NOTES = arg('notes', 2000)
const IMAGES = arg('images', 300)
const legacy = process.argv.includes('--legacy')
const json = process.argv.includes('--json')

const fs = new FakeFs()
fs.scale = arg('scale', 1)
mock.module('expo-file-system/legacy', () => fs.module)
const { ids, rels: seeded } = seedVault(fs, { notes: NOTES, images: IMAGES })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const vault: any = await import('../src/lib/vault')
const pickAt = Math.floor(ids.length / 2)
const pick = ids[pickAt]!
const pickRel = seeded[pickAt * 97]! // seedVault samples every 97th note
const ms = (t: number): number => Math.round(performance.now() - t)

interface Row {
  scenario: string
  firstRenderMs: number
  drawerMs: number
  drawerNotes: number
  openNoteMs: number
  calls: number
}
const rows: Row[] = []

async function legacyBoot(): Promise<void> {
  fs.resetCounts()
  const t0 = performance.now()
  await vault.ensureTree()
  const [index] = await Promise.all([vault.listVaultIndex(), vault.listInbox()])
  const ready = ms(t0) // StoreProvider gated the whole UI on this
  const t1 = performance.now()
  const doc = await vault.getNote(pick)
  if (/!\[/.test(doc?.markdown ?? '')) await vault.listAttachments()
  rows.push({
    scenario: 'android-v0.2.7 launch',
    firstRenderMs: ready,
    drawerMs: ready,
    drawerNotes: index.notes.length,
    openNoteMs: ms(t1),
    calls: fs.total()
  })
}

/**
 * Mirrors the new StoreProvider: saved index → paint → background scan (with the
 * stat-only drawer on a first launch). The user taps a drawer row as soon as the
 * drawer has rows, while the scan is still running.
 */
async function boot(scenario: string): Promise<void> {
  vault.resetMemoryForTests()
  fs.resetCounts()
  const t0 = performance.now()
  const snap = await vault.loadIndexSnapshot()
  const firstRenderMs = ms(t0)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let rows0: any[] | null = snap ? snap.notes : null
  let drawerAt = snap ? firstRenderMs : -1
  let shown: () => void = () => undefined
  const drawerShown = new Promise<void>((r) => (shown = r))
  if (snap) shown()
  const scan = (async () => {
    await vault.ensureTree()
    const [index, inbox] = await Promise.all([
      vault.listVaultIndex(
        snap
          ? {}
          : {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onPartial: (rough: any) => {
                rows0 = rough.notes
                drawerAt = ms(t0)
                shown()
              }
            }
      ),
      vault.listInbox()
    ])
    if (drawerAt < 0) {
      rows0 = index.notes
      drawerAt = ms(t0)
      shown()
    }
    await vault.saveIndexSnapshot(index, inbox)
    return index
  })()
  await drawerShown
  // tap the drawer row for the sample note (its id is a path on a first-launch drawer)
  const row = rows0!.find((n) => n.id === pick) ?? rows0!.find((n) => n.path === pickRel)
  const t1 = performance.now()
  const doc = await vault.getNote(row ? row.id : pick)
  if (!doc) throw new Error('note not found')
  if (/!\[/.test(doc.markdown)) await vault.listAttachments()
  const openNoteMs = ms(t1)
  await scan
  rows.push({ scenario, firstRenderMs, drawerMs: drawerAt, drawerNotes: rows0!.length, openNoteMs, calls: fs.total() })
}

if (legacy) {
  await legacyBoot()
} else {
  await boot('first launch (no saved index)')
  await boot('relaunch (saved index, nothing changed)')
  // a sync pulled/changed 50 notes since last launch
  let n = 0
  for (const [k, f] of fs.files) {
    if (k.includes('/vault/') && k.endsWith('.md') && n++ % 40 === 0)
      fs.files.set(k, { ...f, text: `${f.text}\nedited\n`, mtime: f.mtime + 1 })
  }
  await boot('relaunch (50 notes changed)')
}

if (json) console.log(JSON.stringify(rows))
else {
  console.log(`vault: ${NOTES} notes, ${IMAGES} images, scale ${fs.scale}`)
  for (const r of rows) {
    console.log(
      `${r.scenario.padEnd(42)} first render ${String(r.firstRenderMs).padStart(6)} ms   drawer ${String(r.drawerMs).padStart(6)} ms (${r.drawerNotes} notes)   open note ${String(r.openNoteMs).padStart(6)} ms   fs calls ${r.calls}`
    )
  }
}
