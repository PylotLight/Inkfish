import { describe, expect, test } from 'bun:test'
import { assetPathFromUrl, assetUrl, findImages, imageCandidates, imageMarkdown, normalizeVaultPath } from './images'

describe('findImages', () => {
  test('captured ref with empty alt (the bare "!" bug)', () => {
    const line = '![](assets/2026/10/a_x1.png)'
    expect(findImages(line)).toEqual([{ index: 0, length: line.length, alt: '', src: 'assets/2026/10/a_x1.png' }])
  })
  test('alt, title, angle-bracket src with spaces, several per line', () => {
    const t = 'see ![cat](./cat.png "Cat") and ![](<my pics/dog 1.png>)'
    const r = findImages(t)
    expect(r.map((i) => [i.alt, i.src])).toEqual([
      ['cat', './cat.png'],
      ['', 'my pics/dog 1.png']
    ])
    expect(t.slice(r[0]!.index, r[0]!.index + r[0]!.length)).toBe('![cat](./cat.png "Cat")')
  })
  test('plain links are not images', () => {
    expect(findImages('[x](y.png)')).toEqual([])
  })
})

describe('imageCandidates', () => {
  test('vault-root ref resolves from any folder, note-relative as fallback', () => {
    expect(imageCandidates('assets/2026/10/a.png', 'personal/Untitled 2.md')).toEqual([
      'asset://vault/assets/2026/10/a.png',
      'asset://vault/personal/assets/2026/10/a.png'
    ])
  })
  test('./ and ../ resolve against the note folder first', () => {
    expect(imageCandidates('../assets/a.png', 'projects/x/n.md')[0]).toBe('asset://vault/projects/assets/a.png')
    expect(imageCandidates('./a.png', 'personal/n.md')[0]).toBe('asset://vault/personal/a.png')
  })
  test('remote passes through, file:// and escapes are dropped', () => {
    expect(imageCandidates('https://x.test/a.png', 'n.md')).toEqual(['https://x.test/a.png'])
    expect(imageCandidates('file:///etc/passwd', 'n.md')).toEqual([])
    expect(imageCandidates('../../etc/passwd', 'n.md')).toEqual([])
  })
  test('spaces and case are kept through encoding', () => {
    expect(imageCandidates('Pics/My Shot.PNG')).toEqual(['asset://vault/Pics/My%20Shot.PNG'])
  })
})

describe('asset protocol paths', () => {
  test('round-trips through assetUrl', () => {
    for (const p of ['assets/2026/10/a_x.png', 'Personal/My Shot #2.png', 'a/b%c.png']) {
      expect(assetPathFromUrl(assetUrl(p))).toBe(p)
    }
  })
  test('legacy asset://<path> still works', () => {
    expect(assetPathFromUrl('asset://assets/2026/10/a.png?x=1')).toBe('assets/2026/10/a.png')
  })
  test('traversal rejected', () => {
    expect(assetPathFromUrl('asset://vault/../secret')).toBeNull()
    expect(normalizeVaultPath('a/../../b')).toBeNull()
  })
  test('imageMarkdown wraps paths with spaces', () => {
    expect(imageMarkdown('assets/a.png')).toBe('![](assets/a.png)')
    expect(imageMarkdown('assets/a b.png')).toBe('![](<assets/a b.png>)')
  })
})
