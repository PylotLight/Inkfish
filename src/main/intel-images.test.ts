import { describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INTEL_MAX_IMAGE_BYTES } from '../shared/intelligence'
import { loadVaultIntelImages } from './intel-images'

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jclcAAAAASUVORK5CYII=',
  'base64'
)

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'inkfish-intel-images-'))
}

describe('vault-local intelligence images', () => {
  test('loads PNGs referenced by local inbox markdown and deduplicates assets', () => {
    const root = tempDir()
    try {
      mkdirSync(join(root, 'assets'), { recursive: true })
      writeFileSync(join(root, 'assets', 'invoice.png'), tinyPng)
      const images = loadVaultIntelImages(
        '![invoice](../assets/invoice.png) and ![same](assets/invoice.png)',
        ['assets/invoice.png'],
        root
      )
      expect(images).toEqual([{ mime: 'image/png', data: tinyPng.toString('base64') }])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('never fetches HTTP, data or file URLs and rejects path traversal', () => {
    const root = tempDir()
    try {
      const images = loadVaultIntelImages(
        '![remote](https://example.com/document.png) ![data](data:image/png;base64,AAAA)',
        ['file:///tmp/private.png', '../outside.png'],
        root
      )
      expect(images).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects a symlink that resolves outside the vault', () => {
    const root = tempDir()
    const outside = join(tmpdir(), `inkfish-outside-${Date.now()}.png`)
    try {
      mkdirSync(join(root, 'assets'), { recursive: true })
      writeFileSync(outside, tinyPng)
      symlinkSync(outside, join(root, 'assets', 'outside.png'))
      expect(loadVaultIntelImages('', ['assets/outside.png'], root)).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { force: true })
    }
  })

  test('loads at most two images and skips files over the per-image cap', () => {
    const root = tempDir()
    try {
      mkdirSync(join(root, 'assets'), { recursive: true })
      writeFileSync(join(root, 'assets', 'one.png'), tinyPng)
      writeFileSync(join(root, 'assets', 'two.png'), tinyPng)
      writeFileSync(join(root, 'assets', 'three.png'), tinyPng)
      writeFileSync(join(root, 'assets', 'large.png'), Buffer.concat([tinyPng, Buffer.alloc(INTEL_MAX_IMAGE_BYTES)]))
      const images = loadVaultIntelImages(
        '',
        ['assets/large.png', 'assets/one.png', 'assets/two.png', 'assets/three.png'],
        root
      )
      expect(images).toHaveLength(2)
      expect(images.every((image) => image.mime === 'image/png')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
