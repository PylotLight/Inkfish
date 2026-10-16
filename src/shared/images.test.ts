import { describe, expect, test } from 'bun:test'
import {
  applyEdits,
  assetPathFromUrl,
  assetUrl,
  findImages,
  formatImageAlt,
  imageCandidates,
  imageMarkdown,
  moveImageEdits,
  normalizeVaultPath,
  parseImageAlt,
  resizeImageEdit
} from './images'

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

describe('image size syntax (Obsidian ![alt|300](src))', () => {
  test('alt|w, alt|wxh, |w with empty alt', () => {
    expect(parseImageAlt('cat|300')).toEqual({ alt: 'cat', width: 300 })
    expect(parseImageAlt('cat|300x200')).toEqual({ alt: 'cat', width: 300, height: 200 })
    expect(parseImageAlt('|300')).toEqual({ alt: '', width: 300 })
    expect(parseImageAlt('cat | 300 x 200 ')).toEqual({ alt: 'cat', width: 300, height: 200 })
  })
  test('no width and weird alts stay literal', () => {
    expect(parseImageAlt('')).toEqual({ alt: '' })
    expect(parseImageAlt('cat')).toEqual({ alt: 'cat' })
    expect(parseImageAlt('a|b')).toEqual({ alt: 'a|b' })
    expect(parseImageAlt('x|')).toEqual({ alt: 'x|' })
    expect(parseImageAlt('300')).toEqual({ alt: '300' })
    expect(parseImageAlt('|0')).toEqual({ alt: '|0' })
    expect(parseImageAlt('1|2|300')).toEqual({ alt: '1|2', width: 300 })
    expect(parseImageAlt('w|300x')).toEqual({ alt: 'w|300x' })
  })
  test('findImages exposes width/height and the clean alt; src untouched', () => {
    const t = 'a ![cat|300](assets/c.png) b ![|120x80](<my pic.png>) ![](x.png)'
    const r = findImages(t)
    expect(r.map((i) => [i.alt, i.src, i.width, i.height])).toEqual([
      ['cat', 'assets/c.png', 300, undefined],
      ['', 'my pic.png', 120, 80],
      ['', 'x.png', undefined, undefined]
    ])
    expect(t.slice(r[0]!.index, r[0]!.index + r[0]!.length)).toBe('![cat|300](assets/c.png)')
  })
  test('formatImageAlt round-trips', () => {
    expect(formatImageAlt('cat', 300)).toBe('cat|300')
    expect(formatImageAlt('', 300, 200)).toBe('|300x200')
    expect(formatImageAlt('cat', null)).toBe('cat')
    expect(parseImageAlt(formatImageAlt('a|b', 42))).toEqual({ alt: 'a|b', width: 42 })
  })
})

describe('resizeImageEdit', () => {
  const doc = 'x\n![cat](assets/c.png)\ny'
  const at = doc.indexOf('![')
  test('sets, updates and resets a width', () => {
    const set = applyEdits(doc, [resizeImageEdit(doc, at, 300.4)!])
    expect(set).toBe('x\n![cat|300](assets/c.png)\ny')
    const upd = applyEdits(set, [resizeImageEdit(set, at, 120)!])
    expect(upd).toBe('x\n![cat|120](assets/c.png)\ny')
    const reset = applyEdits(upd, [resizeImageEdit(upd, at, null)!])
    expect(reset).toBe(doc)
  })
  test('empty alt, wxh keeps aspect, no-ops return null', () => {
    const e = '![](assets/a.png)'
    expect(applyEdits(e, [resizeImageEdit(e, 0, 250)!])).toBe('![|250](assets/a.png)')
    const wh = '![|300x200](a.png)'
    expect(applyEdits(wh, [resizeImageEdit(wh, 0, 150)!])).toBe('![|150x100](a.png)')
    expect(applyEdits(wh, [resizeImageEdit(wh, 0, null)!])).toBe('![](a.png)')
    expect(resizeImageEdit(e, 0, null)).toBeNull()
    expect(resizeImageEdit('![|300](a.png)', 0, 300)).toBeNull()
    expect(resizeImageEdit('no image here', 0, 300)).toBeNull()
    expect(resizeImageEdit('[x](y.png)', 0, 300)).toBeNull()
  })
})

describe('moveImageEdits', () => {
  const doc = 'one\n![](a.png)\ntwo\nthree'
  const from = doc.indexOf('![')
  const to = from + '![](a.png)'.length
  test('block image moves as a whole line, before/after the drop line', () => {
    const after = moveImageEdits(doc, from, to, doc.indexOf('three'), 'after')!
    expect(applyEdits(doc, after)).toBe('one\ntwo\nthree\n![](a.png)')
    const before = moveImageEdits(doc, from, to, 1, 'before')!
    expect(applyEdits(doc, before)).toBe('![](a.png)\none\ntwo\nthree')
    const mid = moveImageEdits(doc, from, to, doc.indexOf('two') + 1, 'after')!
    expect(applyEdits(doc, mid)).toBe('one\ntwo\n![](a.png)\nthree')
  })
  test('last-line image and no-op drops', () => {
    const d = 'a\nb\n![|300](x.png)'
    const f = d.indexOf('![')
    expect(applyEdits(d, moveImageEdits(d, f, d.length, 0, 'before')!)).toBe('![|300](x.png)\na\nb')
    expect(moveImageEdits(d, f, d.length, f + 3, 'after')).toBeNull()
    expect(moveImageEdits(d, f, d.length, d.indexOf('b'), 'after')).toBeNull()
    expect(moveImageEdits(doc, from, to, doc.indexOf('two'), 'before')).toBeNull()
  })
  test('inline image moves to the exact offset, never inside another ref', () => {
    const d = 'see ![](a.png) here and ![](b.png) end'
    const f = d.indexOf('![](a')
    const t = f + '![](a.png)'.length
    expect(applyEdits(d, moveImageEdits(d, f, t, d.length)!)).toBe('see  here and ![](b.png) end![](a.png)')
    const inB = d.indexOf('![](b') + 3
    expect(applyEdits(d, moveImageEdits(d, f, t, inB)!)).toBe('see  here and ![](b.png)![](a.png) end')
    expect(moveImageEdits(d, f, t, f + 2)).toBeNull()
  })
})

describe('image copy helpers', () => {
  test('imageSourceOf classifies loaded URLs', async () => {
    const { imageSourceOf } = await import('./images')
    expect(imageSourceOf('asset://vault/assets/a%20b.png')).toEqual({ kind: 'vault', rel: 'assets/a b.png' })
    expect(imageSourceOf('asset://vault/../x.png')).toBeNull()
    expect(imageSourceOf('https://x.test/p.gif?v=1')).toEqual({ kind: 'remote', url: 'https://x.test/p.gif?v=1' })
    expect(imageSourceOf('data:image/png;base64,iVBO')).toEqual({ kind: 'data', url: 'data:image/png;base64,iVBO' })
    expect(imageSourceOf('file:///etc/x.png')).toBeNull()
    expect(imageSourceOf('')).toBeNull()
    expect(imageSourceOf(null)).toBeNull()
  })
  test('imageMime sniffs bytes first, then the extension', async () => {
    const { imageMime, nativelyDecodable } = await import('./images')
    const pad = (h: number[]): Uint8Array => new Uint8Array([...h, ...new Array(16).fill(0)])
    expect(imageMime('x.jpg', pad([0x89, 0x50, 0x4e, 0x47]))).toBe('image/png')
    expect(imageMime('', pad([0xff, 0xd8, 0xff]))).toBe('image/jpeg')
    expect(imageMime('', pad([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif')
    const webp = new Uint8Array(16)
    webp.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
    expect(imageMime('', webp)).toBe('image/webp')
    expect(imageMime('/a/b.WEBP?x=1')).toBe('image/webp')
    expect(imageMime('a.jpeg')).toBe('image/jpeg')
    expect(imageMime('a.txt')).toBeNull()
    expect(nativelyDecodable('image/png')).toBe(true)
    expect(nativelyDecodable('image/jpeg')).toBe(true)
    expect(nativelyDecodable('image/gif')).toBe(false)
    expect(nativelyDecodable('image/webp')).toBe(false)
  })
})
