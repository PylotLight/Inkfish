import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { FakeFs } from './helpers/fakefs'

const fs = new FakeFs()
fs.scale = 0
let failMoves = false
const deleted: string[] = []
const moved: Array<{ from: string; to: string; destinationBefore: string | null }> = []
const nativeMove = fs.module.moveAsync

mock.module('expo-file-system/legacy', () => ({
  ...fs.module,
  async deleteAsync(uri: string, options?: { idempotent?: boolean }) {
    deleted.push(uri)
    await fs.module.deleteAsync(uri, options)
  },
  async moveAsync({ from, to }: { from: string; to: string }) {
    const key = to.endsWith('/') ? to.slice(0, -1) : to
    moved.push({ from, to, destinationBefore: fs.files.get(key)?.text ?? null })
    if (failMoves) throw new Error('injected rename interruption')
    await nativeMove({ from, to })
  }
}))
mock.module('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(0x2a) }))

const { androidFs } = await import('../src/lib/syncfs')
const { writeText } = await import('../src/lib/vault/paths')

const target = `${fs.root}inkfish/vault/note.md`
const decoded = (text: string): string => Buffer.from(text, 'base64').toString('utf8')

beforeEach(() => {
  fs.files.clear()
  fs.dirs = new Set([fs.root.slice(0, -1)])
  fs.resetCounts()
  failMoves = false
  deleted.length = 0
  moved.length = 0
})

describe('Android atomic filesystem writes', () => {
  test('sync replacement keeps the previous file until the atomic rename', async () => {
    fs.put(target, 'previous note')

    await androidFs.write('note.md', new TextEncoder().encode('updated note'))

    expect(moved).toHaveLength(1)
    expect(moved[0]?.destinationBefore).toBe('previous note')
    expect(deleted).not.toContain(target)
    expect(decoded(fs.files.get(target)!.text)).toBe('updated note')
  })

  test('a failed replacement leaves the previous sync copy intact', async () => {
    fs.put(target, 'last good note')
    failMoves = true

    await expect(androidFs.write('note.md', new TextEncoder().encode('new note'))).rejects.toThrow(
      'injected rename interruption'
    )

    expect(fs.files.get(target)?.text).toBe('last good note')
    expect(deleted).not.toContain(target)
    expect(moved).toHaveLength(2) // the sync adapter retries once
  })

  test('editor/vault text replacement is atomic and preserves the old file on failure', async () => {
    fs.put(target, 'saved note')
    failMoves = true

    await expect(writeText(target, 'new editor text')).rejects.toThrow('injected rename interruption')

    expect(fs.files.get(target)?.text).toBe('saved note')
    expect(deleted).not.toContain(target)
  })

  test('partial append uses the highest chunk index instead of overwriting a gap', async () => {
    const dir = `${fs.root}inkfish/.sync/partial/abc/`
    fs.put(`${dir}00000`, 'QQ==')
    fs.put(`${dir}00002`, 'Qw==')

    await androidFs.partial.append('abc', new TextEncoder().encode('B'))

    expect(fs.files.get(`${dir}00002`)?.text).toBe('Qw==')
    expect(fs.files.get(`${dir}00003`)?.text).toBe('Qg==')
    expect(decoded(Buffer.from(await androidFs.partial.read('abc')).toString('base64'))).toBe('ACB')
  })
})
