/** UTF-8 + base64 helpers with no platform globals (Hermes lacks some). */

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00)
        i++
      }
    }
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return Uint8Array.from(out)
}

export function utf8Decode(b: Uint8Array): string {
  let s = ''
  const chunk: number[] = []
  const flush = (): void => {
    s += String.fromCharCode(...chunk)
    chunk.length = 0
  }
  for (let i = 0; i < b.length; ) {
    const x = b[i]!
    let c: number
    if (x < 0x80) { c = x; i++ }
    else if (x >> 5 === 6) { c = ((x & 31) << 6) | (b[i + 1]! & 63); i += 2 }
    else if (x >> 4 === 14) { c = ((x & 15) << 12) | ((b[i + 1]! & 63) << 6) | (b[i + 2]! & 63); i += 3 }
    else if (x >> 3 === 30) {
      c = ((x & 7) << 18) | ((b[i + 1]! & 63) << 12) | ((b[i + 2]! & 63) << 6) | (b[i + 3]! & 63)
      i += 4
    } else { c = 0xfffd; i++ }
    if (c >= 0x10000) {
      c -= 0x10000
      chunk.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023))
    } else chunk.push(c)
    if (chunk.length > 8000) flush()
  }
  flush()
  return s
}

const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const REV = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) REV[A.charCodeAt(i)] = i
REV['-'.charCodeAt(0)] = 62
REV['_'.charCodeAt(0)] = 63

export function toBase64(b: Uint8Array, url = false): string {
  const parts: string[] = []
  let s = ''
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    s += A[(n >> 18) & 63]! + A[(n >> 12) & 63]!
    s += i + 1 < b.length ? A[(n >> 6) & 63]! : '='
    s += i + 2 < b.length ? A[n & 63]! : '='
    if (s.length > 16384) { parts.push(s); s = '' }
  }
  parts.push(s)
  const out = parts.join('')
  return url ? out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : out
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/[\s=]/g, '')
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0, buf = 0, bits = 0
  for (let i = 0; i < clean.length; i++) {
    const v = REV[clean.charCodeAt(i)] ?? -1
    if (v < 0) throw new Error('bad base64')
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 255
    }
  }
  return out.subarray(0, o)
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
