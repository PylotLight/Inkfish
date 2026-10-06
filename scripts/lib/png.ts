import { inflateSync, deflateSync } from 'node:zlib'

// Minimal zero-dependency PNG helpers: decode 8-bit RGB/RGBA (non-interlaced),
// bilinear resampling, and RGBA encoding. Enough to derive every app icon from
// `assets/Inkfish_logo.png` without native toolchains.

export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array // length = width * height * 4, RGBA order
}

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

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Decode an 8-bit RGB (color type 2) or RGBA (type 6) PNG. Throws otherwise. */
export function decodePng(png: Uint8Array): RgbaImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  for (let i = 0; i < 8; i++) {
    if (png[i] !== sig[i]) throw new Error('not a PNG file')
  }
  let pos = 8
  let width = 0
  let height = 0
  let colorType = 0
  const idat: Buffer[] = []
  while (pos < png.length) {
    const len = Buffer.from(png.buffer, png.byteOffset + pos, 4).readUInt32BE(0)
    const type = Buffer.from(png.buffer, png.byteOffset + pos + 4, 4).toString('ascii')
    const data = png.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      const v = Buffer.from(data.buffer, data.byteOffset, data.length)
      width = v.readUInt32BE(0)
      height = v.readUInt32BE(4)
      const bitDepth = v[8]!
      colorType = v[9]!
      const interlace = v[12]!
      if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${bitDepth}`)
      if (colorType !== 2 && colorType !== 6) throw new Error(`unsupported PNG color type ${colorType}`)
      if (interlace !== 0) throw new Error('interlaced PNG not supported')
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data.buffer, data.byteOffset, data.length))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }
  if (width === 0 || height === 0) throw new Error('PNG missing IHDR')
  const channels = colorType === 6 ? 4 : 3
  const stride = width * channels
  const raw = inflateSync(Buffer.concat(idat))
  const data = new Uint8Array(width * height * 4)
  const prev = Buffer.alloc(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++]!
    const line = Buffer.from(raw.buffer, raw.byteOffset + p, stride)
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels]! : 0
      const b = prev[i]!
      const c = i >= channels ? prev[i - channels]! : 0
      if (filter === 1) line[i] = (line[i]! + a) & 0xff
      else if (filter === 2) line[i] = (line[i]! + b) & 0xff
      else if (filter === 3) line[i] = (line[i]! + ((a + b) >> 1)) & 0xff
      else if (filter === 4) line[i] = (line[i]! + paeth(a, b, c)) & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const s = x * channels
      data[o] = line[s]!
      data[o + 1] = line[s + 1]!
      data[o + 2] = line[s + 2]!
      data[o + 3] = channels === 4 ? line[s + 3]! : 255
    }
    line.copy(prev)
  }
  return { width, height, data }
}

/** Bilinear resample of RGBA data to dw × dh. */
export function resampleRgba(src: Uint8Array, sw: number, sh: number, dw: number, dh: number): Uint8Array {
  const out = new Uint8Array(dw * dh * 4)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1))
    const ty = Math.max(0, Math.min(1, fy - y0))
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1))
      const tx = Math.max(0, Math.min(1, fx - x0))
      const o = (y * dw + x) * 4
      for (let c = 0; c < 4; c++) {
        const p00 = src[(y0 * sw + x0) * 4 + c]!
        const p10 = src[(y0 * sw + x1) * 4 + c]!
        const p01 = src[(y1 * sw + x0) * 4 + c]!
        const p11 = src[(y1 * sw + x1) * 4 + c]!
        out[o + c] = Math.round(p00 * (1 - tx) * (1 - ty) + p10 * tx * (1 - ty) + p01 * (1 - tx) * ty + p11 * tx * ty)
      }
    }
  }
  return out
}

/** Bilinear resample of a single-channel float mask. */
export function resampleMask(src: Float32Array, sw: number, sh: number, dw: number, dh: number): Float32Array {
  const out = new Float32Array(dw * dh)
  const sx = sw / dw
  const sy = sh / dh
  for (let y = 0; y < dh; y++) {
    const fy = (y + 0.5) * sy - 0.5
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)))
    const y1 = Math.max(0, Math.min(sh - 1, y0 + 1))
    const ty = Math.max(0, Math.min(1, fy - y0))
    for (let x = 0; x < dw; x++) {
      const fx = (x + 0.5) * sx - 0.5
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)))
      const x1 = Math.max(0, Math.min(sw - 1, x0 + 1))
      const tx = Math.max(0, Math.min(1, fx - x0))
      out[y * dw + x] =
        src[y0 * sw + x0]! * (1 - tx) * (1 - ty) +
        src[y0 * sw + x1]! * tx * (1 - ty) +
        src[y1 * sw + x0]! * (1 - tx) * ty +
        src[y1 * sw + x1]! * tx * ty
    }
  }
  return out
}

export function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = 1 + width * 4
  const raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * stride + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
