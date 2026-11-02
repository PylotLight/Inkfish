import { describe, expect, test } from 'bun:test'
import { walkManifest, type HashCache, type WalkIo, type WalkRoot } from './walk'

describe('manifest walk hash policy', () => {
  test('a forced note rehash detects changed Markdown with unchanged size and mtime', async () => {
    let noteBytes = 'old'
    const files = ['note.md', 'image.png']
    const root: WalkRoot = { uri: 'root/', prefix: '', deep: false }
    const io: WalkIo = {
      readDir: async () => files,
      stat: async (uri) => ({ exists: true, isDirectory: false, size: 3, mtime: 12 }),
      hash: async (uri) => (uri.endsWith('note.md') ? `hash:${noteBytes}` : 'hash:image')
    }
    const cache: HashCache = {
      'note.md': { size: 3, mtime: 12, hash: 'hash:old' },
      'image.png': { size: 3, mtime: 12, hash: 'hash:image' }
    }

    noteBytes = 'new'
    const result = await walkManifest(io, [root], cache, 8, (rel) => rel.endsWith('.md'))

    expect(result.manifest['note.md']?.hash).toBe('hash:new')
    expect(result.manifest['image.png']?.hash).toBe('hash:image')
    expect(result.hashed).toBe(1)
  })

  test('the default policy continues to reuse unchanged cached hashes', async () => {
    let hashes = 0
    const io: WalkIo = {
      readDir: async () => ['note.md'],
      stat: async () => ({ exists: true, isDirectory: false, size: 3, mtime: 12 }),
      hash: async () => {
        hashes++
        return 'fresh'
      }
    }
    const cache: HashCache = { 'note.md': { size: 3, mtime: 12, hash: 'cached' } }

    const result = await walkManifest(io, [{ uri: 'root/', prefix: '', deep: false }], cache)

    expect(result.manifest['note.md']?.hash).toBe('cached')
    expect(result.hashed).toBe(0)
    expect(hashes).toBe(0)
  })
})
