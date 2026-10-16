import { describe, expect, test } from 'bun:test'
import { imageMenuItems, type ImageMenuInput } from './imageActions'

const noop = (): void => {}
const base: ImageMenuInput = {
  url: null,
  markdown: null,
  resettable: false,
  copyImage: noop,
  copyPath: noop,
  copyMarkdown: noop,
  reveal: noop,
  reset: noop
}
const labels = (i: Partial<ImageMenuInput>): string[] => imageMenuItems({ ...base, ...i }).map((x) => x.label)

describe('image context menu', () => {
  test('vault image: full menu, reset only when sized', () => {
    const v = { url: 'asset://vault/assets/a%20b.png', markdown: '![](<assets/a b.png>)' }
    expect(labels(v)).toEqual(['Copy image', 'Copy image path', 'Copy markdown', 'Reveal in Finder'])
    expect(labels({ ...v, resettable: true })).toEqual([
      'Copy image',
      'Copy image path',
      'Copy markdown',
      'Reveal in Finder',
      'Reset size'
    ])
  })
  test('remote image: copy URL, no reveal', () => {
    expect(labels({ url: 'https://x.test/p.webp', markdown: '![](https://x.test/p.webp)' })).toEqual([
      'Copy image',
      'Copy image URL',
      'Copy markdown'
    ])
  })
  test('data URL: no path item', () => {
    expect(labels({ url: 'data:image/gif;base64,R0lG', markdown: '![](data:...)' })).toEqual([
      'Copy image',
      'Copy markdown'
    ])
  })
  test('image that failed to load still offers markdown (+ reset)', () => {
    expect(labels({ markdown: '![x|200](nope.png)', resettable: true })).toEqual(['Copy markdown', 'Reset size'])
  })
  test('actions are wired to the right callbacks', () => {
    const hit: string[] = []
    const items = imageMenuItems({
      ...base,
      url: 'asset://vault/a.png',
      markdown: '![](a.png)',
      resettable: true,
      copyImage: () => hit.push('img'),
      copyPath: () => hit.push('path'),
      copyMarkdown: () => hit.push('md'),
      reveal: () => hit.push('reveal'),
      reset: () => hit.push('reset')
    })
    for (const i of items) i.action()
    expect(hit).toEqual(['img', 'path', 'md', 'reveal', 'reset'])
  })
})
