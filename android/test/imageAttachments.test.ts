import { describe, expect, test } from 'bun:test'
import {
  appendMarkdownImageRefs,
  imageAttachmentsFromPickerResult,
  imageExtension,
  markdownImageRefs
} from '../src/lib/imageAttachments'

describe('Android photo attachments', () => {
  test('converts a multi-image picker result into copyable local sources', () => {
    expect(
      imageAttachmentsFromPickerResult({
        canceled: false,
        assets: [
          { uri: 'content://photos/1', width: 1200, height: 800, fileName: 'desk.png', mimeType: 'image/png' },
          { uri: 'content://photos/2', width: 800, height: 1200, fileName: null, mimeType: 'image/jpeg' }
        ]
      })
    ).toEqual([
      { uri: 'content://photos/1', fileName: 'desk.png', mimeType: 'image/png' },
      { uri: 'content://photos/2', fileName: null, mimeType: 'image/jpeg' }
    ])
    expect(imageAttachmentsFromPickerResult({ canceled: true, assets: null })).toEqual([])
  })

  test('preserves the real image extension from MIME type or filename when the URI has none', () => {
    expect(imageExtension({ uri: 'content://photo/1', mimeType: 'image/png' })).toBe('.png')
    expect(imageExtension({ uri: 'content://photo/2', fileName: 'holiday.jpeg' })).toBe('.jpg')
    expect(imageExtension({ uri: 'content://photo/3?name=pic.webp' })).toBe('.jpg')
    expect(imageExtension({ uri: 'file:///cache/pic.webp' })).toBe('.webp')
  })

  test('formats imported photos as Markdown references after any entry text', () => {
    expect(markdownImageRefs(['assets/2026/11/a.jpg', 'assets/2026/11/b.png'])).toBe(
      '![](assets/2026/11/a.jpg)\n![](assets/2026/11/b.png)'
    )
    expect(appendMarkdownImageRefs('  lunch with Sam  ', ['assets/2026/11/lunch.jpg'])).toBe(
      'lunch with Sam\n![](assets/2026/11/lunch.jpg)'
    )
    expect(appendMarkdownImageRefs('', ['assets/2026/11/only-photo.jpg'])).toBe('![](assets/2026/11/only-photo.jpg)')
  })
})
