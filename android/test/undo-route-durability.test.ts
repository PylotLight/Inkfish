import { expect, mock, test } from 'bun:test'
import { FakeFs } from './helpers/fakefs'

const fs = new FakeFs()
fs.scale = 0
mock.module('expo-file-system/legacy', () => ({
  ...fs.module,
  async moveAsync() {
    throw new Error('injected rename interruption')
  }
}))

const { undoRoute } = await import('../src/lib/vault/inbox')

test('a failed undo copy leaves the routed note in the vault', async () => {
  fs.files.clear()
  fs.dirs = new Set([fs.root.slice(0, -1)])
  const source = `${fs.root}inkfish/vault/work/Processed.md`
  const content = '---\nid: note-1\ninbox: in_1\n---\n# Processed\nimportant text\n'
  fs.put(source, content)

  expect(await undoRoute('in_1')).toBe(false)
  expect(fs.files.get(source)?.text).toBe(content)
  expect([...fs.files.keys()].some((path) => path.includes('/undone/'))).toBe(false)
})
