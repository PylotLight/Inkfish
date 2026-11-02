import { describe, expect, test } from 'bun:test'
import { downloadApk, sha256Chunks, type ApkDownloadAdapter } from '../src/lib/apkDownload'

const complete = 'abcdef'
const sha = 'a'.repeat(64)
const asset = {
  version: '0.3.2-beta.1',
  apkUrl: 'https://example.test/app.apk',
  apkSize: complete.length,
  apkSha256: sha
}

function fakeAdapter(files = new Map<string, string>()) {
  const calls: Array<{ destination: string; resumeData: string | undefined }> = []
  const adapter: ApkDownloadAdapter = {
    getInfo: async (uri) => {
      const content = files.get(uri)
      return content === undefined ? { exists: false } : { exists: true, isDirectory: false, size: content.length }
    },
    delete: async (uri) => {
      files.delete(uri)
    },
    move: async (from, to) => {
      const content = files.get(from)
      if (content === undefined) throw new Error('missing source file')
      files.set(to, content)
      files.delete(from)
    },
    sha256: async (uri) => (files.get(uri) === complete ? sha : '0'.repeat(64)),
    download: async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      return { uri: destination, status: 200 }
    },
    sleep: async () => {}
  }
  return { adapter, files, calls }
}

describe('Android updater APK downloads', () => {
  test('computes SHA-256 incrementally across file-sized chunks', async () => {
    const chunks = [new Uint8Array([97]), new Uint8Array([98, 99]), new Uint8Array()]
    const digest = await sha256Chunks(async () => chunks.shift() ?? new Uint8Array())

    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('resumes a network-interrupted partial with Range and promotes only the verified complete APK', async () => {
    const { adapter, files, calls } = fakeAdapter()
    let request = 0
    adapter.download = async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      request++
      if (request === 1) {
        files.set(destination, 'abc')
        throw new Error('connection dropped')
      }
      expect(resumeData).toBe('3')
      files.set(destination, `${files.get(destination) ?? ''}def`)
      return { uri: destination, status: 206, headers: { 'Content-Range': 'bytes 3-5/6' } }
    }

    const result = await downloadApk(asset, 'app.apk.part', 'app.apk', adapter, () => {})

    expect(result).toBe('app.apk')
    expect(calls.map((call) => call.resumeData)).toEqual([undefined, '3'])
    expect(files.get('app.apk')).toBe(complete)
    expect(files.has('app.apk.part')).toBe(false)
  })

  test('discards a partial if the server ignores Range, then starts a clean full download', async () => {
    const { adapter, files, calls } = fakeAdapter(new Map([['app.apk.part', 'abc']]))
    adapter.download = async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      if (resumeData) {
        // Expo's legacy Android implementation appends the full 200 body to the partial.
        files.set(destination, `${files.get(destination) ?? ''}${complete}`)
        return { uri: destination, status: 200 }
      }
      files.set(destination, complete)
      return { uri: destination, status: 200 }
    }

    const result = await downloadApk(asset, 'app.apk.part', 'app.apk', adapter, () => {})

    expect(result).toBe('app.apk')
    expect(calls.map((call) => call.resumeData)).toEqual(['3', undefined])
    expect(files.get('app.apk')).toBe(complete)
    expect(files.has('app.apk.part')).toBe(false)
  })

  test('does not reuse a same-size cached APK unless its GitHub digest matches', async () => {
    const { adapter, files, calls } = fakeAdapter(new Map([['app.apk', 'xxxxxx']]))
    adapter.download = async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      files.set(destination, complete)
      return { uri: destination, status: 200 }
    }

    await downloadApk(asset, 'app.apk.part', 'app.apk', adapter, () => {})

    expect(calls).toHaveLength(1)
    expect(files.get('app.apk')).toBe(complete)
  })

  test('rejects a permanent HTTP error and removes its response body from the partial path', async () => {
    const { adapter, files, calls } = fakeAdapter()
    adapter.download = async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      files.set(destination, 'not an apk')
      return { uri: destination, status: 404 }
    }

    await expect(downloadApk(asset, 'app.apk.part', 'app.apk', adapter, () => {})).rejects.toThrow('HTTP 404')
    expect(calls).toHaveLength(1)
    expect(files.has('app.apk.part')).toBe(false)
    expect(files.has('app.apk')).toBe(false)
  })

  test('keeps a byte-range-resumable partial after bounded transient failures, but never exposes it as ready', async () => {
    const { adapter, files, calls } = fakeAdapter()
    adapter.download = async (_url, destination, resumeData) => {
      calls.push({ destination, resumeData })
      files.set(destination, `${files.get(destination) ?? ''}a`)
      throw new Error('connection dropped')
    }

    await expect(downloadApk(asset, 'app.apk.part', 'app.apk', adapter, () => {})).rejects.toThrow(
      'remain saved to resume'
    )
    expect(calls).toHaveLength(4)
    expect(calls.map((call) => call.resumeData)).toEqual([undefined, '1', '2', '3'])
    expect(files.has('app.apk')).toBe(false)
    expect(files.get('app.apk.part')).toBe('aaaa')
  })
})
