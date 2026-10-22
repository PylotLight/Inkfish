import { describe, expect, test } from 'bun:test'
import { runSync, type SyncReport } from './engine'
import { CiFs, MemFs, MemState, hashes, wired } from './testkit'
import { utf8Encode } from './bytes'
import { bumpOriginal, caseAdoptions, conflictOriginal, redundantCopies } from './paths'
import type { Manifest } from './plan'

/**
 * Convergence: after a sync both vaults hold the same paths + bytes, and the
 * next sync is a no-op in both directions. Run against a case-insensitive
 * "Mac" (APFS) and a case-sensitive, self-healing "phone" (Android) — the
 * combination that looped forever in v0.2.13 / android-v0.2.6.
 */

const work = (r: SyncReport): number => r.pulled + r.pushed + r.merged + r.deleted + r.moved + r.conflicts.length

function png(n: number, size = 4096): Uint8Array {
  const b = new Uint8Array(size)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  for (let i = 8; i < size; i++) b[i] = (i * 31 + n * 7) & 0xff
  return b
}

async function expectConverged(phone: MemFs, mac: CiFs): Promise<void> {
  expect(hashes(await phone.list())).toEqual(hashes(await mac.list()))
}

describe('sync converges (Mac case-insensitive, phone case-sensitive)', () => {
  test('regression: phone lowercase folders vs Mac Title-case folders — repeated syncs push 0 files', async () => {
    // Mac vault: Title-case folders. Phone: fresh install seeded personal/work/ and has notes there.
    const mac = new CiFs({
      'Work/standup.md': '# standup\n',
      'Work/plan.md': '# plan\n',
      'Personal/groceries.md': '# groceries\n',
      'Reading/books.md': '# books\n',
      'assets/2026/10/pic.png': png(1),
      'Work/diagram.png': png(2)
    })
    const phone = new MemFs({ 'work/phone-idea.md': '# idea from phone\n', 'personal/todo.md': '# todo\n' })
    phone.healCase = true
    const state = new MemState()
    const { remote, changed } = wired(mac)

    for (let i = 0; i < 2; i++) await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await expectConverged(phone, mac)
    // The phone adopts the Mac's spelling — Mac folders are never renamed.
    expect(mac.paths().some((p) => p.startsWith('work/') || p.startsWith('personal/'))).toBe(false)
    expect(mac.text('Work/phone-idea.md')).toBe('# idea from phone\n')
    expect(phone.text('Work/phone-idea.md')).toBe('# idea from phone\n')
    expect(phone.files.get('assets/2026/10/pic.png')).toEqual(png(1))
    expect(phone.files.get('Work/diagram.png')).toEqual(png(2))

    // Repeated syncs after convergence push nothing and pull nothing.
    const applies = changed.length
    const writes = mac.writes
    for (let i = 0; i < 5; i++) expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
    expect(changed.length).toBe(applies)
    expect(mac.writes).toBe(writes)
    // Nothing multiplied.
    expect(phone.files.size).toBe(8)
    expect(mac.paths().length).toBe(8)
  })

  test('a lowercase Mac vault and a Title-case phone converge too (Mac spelling wins)', async () => {
    const mac = new CiFs({ 'work/a.md': 'a\n' })
    const phone = new MemFs({ 'Work/b.md': 'b\n' })
    phone.healCase = true
    const state = new MemState()
    const { remote, changed } = wired(mac)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await expectConverged(phone, mac)
    expect(phone.text('work/b.md')).toBe('b\n')
    const n = changed.length
    for (let i = 0; i < 3; i++) expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
    expect(changed.length).toBe(n)
  })

  test('edits keep flowing after a case adoption, and nothing is deleted on the Mac', async () => {
    const mac = new CiFs({ 'Work/a.md': 'one\n' })
    const phone = new MemFs({ 'work/seed.md': 's\n' })
    phone.healCase = true
    const state = new MemState()
    const { remote } = wired(mac)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await phone.write('Work/a.md', utf8Encode('two\n'))
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r.pushed).toBe(1)
    expect(r.deleted).toBe(0)
    expect(mac.text('Work/a.md')).toBe('two\n')
    await mac.write('Work/a.md', utf8Encode('three\n'))
    const r2 = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r2.pulled).toBe(1)
    expect(phone.text('Work/a.md')).toBe('three\n')
    await expectConverged(phone, mac)
  })

  test('a phone already stuck in the loop (old base, lowercase copies) recovers without deleting', async () => {
    const mac = new CiFs({ 'Work/a.md': 'a\n', 'Work/b.md': 'b\n' })
    const phone = new MemFs({ 'work/a.md': 'a\n', 'work/b.md': 'b\n' })
    phone.healCase = true
    const state = new MemState()
    state.base = { 'Work/a.md': 'stale', 'work/b.md': 'stale' }
    const { remote } = wired(mac)
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r.deleted).toBe(0)
    expect(mac.paths()).toEqual(['Work/a.md', 'Work/b.md'])
    await expectConverged(phone, mac)
    expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
  })

  test('assets converge both ways byte-exact, then idle', async () => {
    const big = png(9, 3 * 1024 * 1024)
    const mac = new CiFs({
      'assets/a.png': png(3),
      'notes/with image.md': '![](../assets/a.png)\n',
      'assets/big.png': big
    })
    const phone = new MemFs({ 'assets/from-phone.jpg': png(4, 100_000), 'assets/audio.m4a': png(5, 200_000) })
    const state = new MemState()
    const { remote } = wired(mac)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await expectConverged(phone, mac)
    expect(phone.files.get('assets/big.png')).toEqual(big)
    expect(await mac.read('assets/audio.m4a')).toEqual(png(5, 200_000))
    expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
  })

  test('a fresh phone pulls a 300-note Mac vault in one run, then idles', async () => {
    const init: Record<string, string> = {}
    for (let i = 0; i < 300; i++)
      init[`${['Work', 'Personal', 'Ideas/Sub'][i % 3]}/note ${i}.md`] = `# note ${i}\n\nbody ${i}\n`
    const mac = new CiFs(init)
    const phone = new MemFs()
    phone.healCase = true
    const state = new MemState()
    const { remote } = wired(mac)
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r.pulled).toBe(300)
    await expectConverged(phone, mac)
    expect(Object.keys(state.base).length).toBe(300)
    expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
  })
})

describe('conflict copies', () => {
  const C1 = 'Work/a (conflict · Mac · 2026-10-19 1801).md'
  const C2 = 'Work/a (conflict · Mac · 2026-10-19 1802).md'
  const C3 = 'Work/a (conflict · Mac · 2026-10-19 1803).md'

  test('name helpers', () => {
    expect(conflictOriginal(C1)).toBe('Work/a.md')
    expect(conflictOriginal('Work/a.md')).toBeNull()
    expect(bumpOriginal('Work/a 2.md')).toBe('Work/a.md')
    expect(bumpOriginal('Work/2026 10.md')).toBe('Work/2026.md')
    expect(bumpOriginal('Work/a.md')).toBeNull()
    expect(caseAdoptions({ 'work/x.md': e('1') }, { 'Work/x.md': e('1') })).toEqual([
      { from: 'work/x.md', to: 'Work/x.md' }
    ])
    // Ambiguous (both spellings on the phone): leave alone.
    expect(caseAdoptions({ 'work/x.png': e('1'), 'WORK/x.png': e('2') }, { 'Work/x.png': e('1') })).toEqual([])
  })

  test('redundant copies: identical to the original, or to an older copy', () => {
    const m: Manifest = {
      'Work/a.md': e('A'),
      [C1]: e('A'),
      [C2]: e('B'),
      [C3]: e('B'),
      'Work/b 2.md': e('X'),
      'Work/b.md': e('X')
    }
    expect(redundantCopies(m).sort()).toEqual([C1, C3].sort())
    expect(redundantCopies(m, { bumps: true }).sort()).toEqual([C1, C3, 'Work/b 2.md'].sort())
  })

  test('identical conflict copies are trashed on both sides and stay gone', async () => {
    const mac = new CiFs({ 'Work/a.md': 'A\n', [C1]: 'A\n', [C2]: 'B\n', [C3]: 'B\n' })
    const phone = new MemFs()
    const state = new MemState()
    const { remote } = wired(mac)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' }) // pull them all
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    expect(r.cleaned).toBe(2)
    expect(mac.paths()).toEqual(['Work/a (conflict · Mac · 2026-10-19 1802).md', 'Work/a.md'])
    await expectConverged(phone, mac)
    expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
  })

  test('never mints a conflict copy the vault already holds', async () => {
    const mac = new CiFs({ 'Work/a.md': 'line\n' })
    const phone = new MemFs()
    const state = new MemState()
    const { remote } = wired(mac)
    await runSync({ fs: phone, remote, state, remoteName: 'Mac' })
    await mac.write('Work/a.md', utf8Encode('mac\n'))
    await phone.write('Work/a.md', utf8Encode('phone\n'))
    const r1 = await runSync({ fs: phone, remote, state, remoteName: 'Mac', now: new Date(2026, 9, 19, 18, 1) })
    expect(r1.conflicts.length).toBe(1)
    // Same divergence comes back (Mac back on its version, phone edits again): a copy with "mac" already exists.
    await mac.write('Work/a.md', utf8Encode('mac\n'))
    await phone.write('Work/a.md', utf8Encode('phone again\n'))
    const r2 = await runSync({ fs: phone, remote, state, remoteName: 'Mac', now: new Date(2026, 9, 19, 18, 2) })
    expect(r2.conflicts.length).toBe(0)
    expect(mac.paths().filter((p) => p.includes('conflict')).length).toBe(1)
    expect(mac.text('Work/a.md')).toBe('phone again\n')
    await expectConverged(phone, mac)
  })
})

describe('repair', () => {
  test('pulls what the base wrongly thinks is synced, deletes nothing', async () => {
    const mac = new CiFs({ 'Work/a.md': 'a\n', 'Work/b.md': 'b\n', 'assets/p.png': png(1) })
    const phone = new MemFs({ 'Work/c.md': 'c\n' })
    const state = new MemState()
    // Corrupt base: claims the Mac files were synced (and since deleted here), so a normal run would trash them on the Mac.
    const m = await mac.list()
    state.base = {
      'Work/a.md': m['Work/a.md']!.hash,
      'Work/b.md': m['Work/b.md']!.hash,
      'assets/p.png': m['assets/p.png']!.hash
    }
    const { remote } = wired(mac)
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac', repair: true })
    expect(r.deleted).toBe(0)
    expect(mac.paths()).toEqual(['Work/a.md', 'Work/b.md', 'Work/c.md', 'assets/p.png'])
    await expectConverged(phone, mac)
    expect(work(await runSync({ fs: phone, remote, state, remoteName: 'Mac' }))).toBe(0)
  })

  test('repair trashes heal bumps identical to their original', async () => {
    const mac = new CiFs({ 'Work/a.md': 'a\n' })
    const phone = new MemFs({ 'Work/a.md': 'a\n', 'Work/a 2.md': 'a\n' })
    const state = new MemState()
    const { remote } = wired(mac)
    const r = await runSync({ fs: phone, remote, state, remoteName: 'Mac', repair: true })
    expect(r.cleaned).toBe(1)
    expect(mac.paths()).toEqual(['Work/a.md'])
    await expectConverged(phone, mac)
  })
})

function e(hash: string): { hash: string; size: number; mtime: number } {
  return { hash, size: 1, mtime: 0 }
}
