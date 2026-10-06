// Generates tray icons as PNGs with zero dependencies.
// Run with: bun scripts/make-tray-icon.ts  (or: bun run assets)
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'assets')
mkdirSync(assetsDir, { recursive: true })

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
  const raw = Buffer.alloc(size * stride)
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
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0))
  ])
}

/** Ink drop (macOS template style: solid fg silhouette), matching the app
 * mark in `make-app-icon.ts`: a circle with a tapered tip. Reads at 22px
 * where the old ring plate was just a rounded square. */
function paintDrop(size: number, fg: RGBA): (x: number, y: number) => RGBA {
  const transparent: RGBA = [0, 0, 0, 0]
  const dcx = 0.5
  const dcy = 0.6
  const dr = 0.25
  const tip = 0.1
  return (x, y) => {
    const px = (x + 0.5) / size
    const py = (y + 0.5) / size
    const inCircle = Math.hypot(px - dcx, py - dcy) <= dr
    const tipT = (dcy - py) / (dcy - tip) // 0 at bulb, 1 at apex
    const taper = Math.pow(1 - Math.max(0, Math.min(1, tipT)), 1.6)
    const half = 0.003 + taper * dr * 0.6
    const inTip = py < dcy && py >= tip && Math.abs(px - dcx) <= half
    return inCircle || inTip ? fg : transparent
  }
}

const white: RGBA = [255, 255, 255, 255]
const slate: RGBA = [43, 47, 54, 255]

const outputs: Array<[string, number, RGBA]> = [
  ['trayTemplate.png', 22, white], // macOS (naming + setTemplateImage => auto dark/light)
  ['trayTemplate@2x.png', 44, white],
  ['tray.png', 32, slate] // Windows/Linux fallback plate
]

for (const [name, size, fg] of outputs) {
  const png = encodePng(size, paintDrop(size, fg))
  writeFileSync(join(assetsDir, name), png)
  console.log(`wrote assets/${name} (${size}x${size}, ${png.length} bytes)`)
}
