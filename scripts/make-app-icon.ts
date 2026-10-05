// Generates the app icon (build/icon.png + build/icon.icns) with zero dependencies.
// Run with: bun scripts/make-app-icon.ts
//
// Mark: a deep-sea rounded square with a glowing ink drop.
// The .icns is hand-assembled: PNG-compressed entries (ic07..ic10 + small
// sizes), which macOS accepts. electron-builder needs a prebuilt .icns on
// non-mac hosts (no iconutil there), so both files are committed.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
mkdirSync(buildDir, { recursive: true })

type RGBA = [number, number, number, number]

const crcTable: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, Buffer.from(data)])), 0)
  return Buffer.concat([len, typeBuf, Buffer.from(data), crc])
}

function encodePng(size: number, paint: (x: number, y: number) => RGBA): Buffer {
  const stride = 1 + size * 4
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0 // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = paint(x, y)
      const o = y * stride + 1 + x * 4
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = a
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// --- the mark ------------------------------------------------------------------
// Background: deep-sea rounded square (#0b1626 → #13283f vertical).
// Foreground: ink drop — a circle with a tapered top — in pale cyan with a
// soft glow, slightly right of center like a fresh drop of ink.

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

function paint(size: number): (x: number, y: number) => RGBA {
  const s = size / 1024
  const rr = 228 * s // corner radius
  return (x, y) => {
    // Rounded-rect mask.
    const cx = Math.min(Math.max(x, rr), size - rr)
    const cy = Math.min(Math.max(y, rr), size - rr)
    const dd = Math.hypot(x - cx, y - cy)
    if (dd > rr) return [0, 0, 0, 0]
    const edge = Math.min(1, Math.max(0, (rr - dd) / (2 * s)))
    // Background gradient.
    const t = y / size
    const bg: RGBA = [
      clamp(11 + (19 - 11) * t),
      clamp(22 + (40 - 22) * t),
      clamp(38 + (63 - 38) * t),
      255
    ]
    // Ink drop: circle at (0.5, 0.60) r=0.20 + tip triangle up to (0.5, 0.26).
    const px = x / size
    const py = y / size
    const dcx = 0.5
    const dcy = 0.6
    const dr = 0.2
    const inCircle = Math.hypot(px - dcx, py - dcy) <= dr
    const tipT = (dcy - py) / (dcy - 0.26) // 0 at bulb, 1 at tip
    const tipHalf = 0.005 + (1 - Math.max(0, Math.min(1, tipT))) * dr * 0.95
    const inTip = py < dcy && py >= 0.26 && Math.abs(px - dcx) <= tipHalf
    if (!inCircle && !inTip) return [bg[0], bg[1], bg[2], clamp(255 * edge)]
    // Cyan ink with vertical sheen + soft outer glow.
    const sheen = 0.75 + 0.25 * (1 - Math.abs(px - dcx) / dr)
    const glowBand = inCircle || inTip ? 0 : 0
    void glowBand
    const ink: RGBA = [clamp(126 * sheen), clamp(211 * sheen), clamp(252 * sheen), 255]
    // Glow: lighten bg near the drop edge.
    const distEdge = inCircle
      ? dr - Math.hypot(px - dcx, py - dcy)
      : tipHalf - Math.abs(px - dcx)
    const mix = Math.min(1, distEdge / (0.03 + 0.001))
    const glow = 0.35 * (1 - mix)
    return [
      clamp(ink[0] * (1 - glow * 0.4) + bg[0] * glow * 0.4),
      clamp(ink[1] * (1 - glow * 0.4) + bg[1] * glow * 0.4),
      clamp(ink[2] * (1 - glow * 0.4) + bg[2] * glow * 0.4),
      clamp(255 * edge)
    ]
  }
}

function icns(pngs: Array<{ type: string; png: Buffer }>): Buffer {
  const entries = pngs.map(({ type, png }) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(8 + png.length, 0)
    return Buffer.concat([Buffer.from(type, 'ascii'), len, png])
  })
  const body = Buffer.concat(entries)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(8 + body.length, 4)
  return Buffer.concat([head, body])
}

const master = encodePng(1024, paint(1024))
writeFileSync(join(buildDir, 'icon.png'), master)
console.log('[icon] wrote build/icon.png (1024×1024)')

const sizes: Array<{ px: number; type: string }> = [
  { px: 16, type: 'icp4' },
  { px: 32, type: 'icp5' },
  { px: 64, type: 'icp6' },
  { px: 128, type: 'ic07' },
  { px: 256, type: 'ic08' },
  { px: 512, type: 'ic09' },
  { px: 1024, type: 'ic10' }
]
writeFileSync(
  join(buildDir, 'icon.icns'),
  icns(sizes.map(({ px, type }) => ({ type, png: encodePng(px, paint(px)) })))
)
console.log('[icon] wrote build/icon.icns (16–1024, PNG-compressed entries)')
