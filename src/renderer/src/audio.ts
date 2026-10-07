// Shared audio helpers: device prefs, mic stream, WAV encoding.
// Device choice lives in localStorage (shared by the main window and the
// capture popover — same origin).

const KEY = 'inkfish.audio'

export interface AudioPrefs {
  /** MediaDeviceInfo.deviceId; '' = system default. */
  inputId: string
  outputId: string
  /** Transcription engine id; '' = best ready engine. */
  engine: string
  /** Show Moonshine live captions while dictating (English). */
  liveCaptions: boolean
  /** Model download host; '' = huggingface.co. */
  modelMirror: string
}

export function loadAudioPrefs(): AudioPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AudioPrefs>
    return {
      inputId: typeof raw.inputId === 'string' ? raw.inputId : '',
      outputId: typeof raw.outputId === 'string' ? raw.outputId : '',
      engine: typeof raw.engine === 'string' ? raw.engine : '',
      liveCaptions: raw.liveCaptions === true,
      modelMirror: typeof raw.modelMirror === 'string' ? raw.modelMirror : ''
    }
  } catch {
    return { inputId: '', outputId: '', engine: '', liveCaptions: false, modelMirror: '' }
  }
}

export function saveAudioPrefs(p: Partial<AudioPrefs>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadAudioPrefs(), ...p }))
  } catch {
    // not persisted
  }
}

/** Mic stream on the chosen input; falls back to default if it vanished. */
export async function openMic(inputId = loadAudioPrefs().inputId): Promise<MediaStream> {
  const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  if (inputId) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: { ...base, deviceId: { exact: inputId } } })
    } catch (e) {
      if ((e as DOMException).name !== 'OverconstrainedError' && (e as DOMException).name !== 'NotFoundError') throw e
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: base })
}

/** Route an <audio> element to the chosen output (Chromium setSinkId). */
export async function routeOutput(el: HTMLMediaElement, outputId = loadAudioPrefs().outputId): Promise<void> {
  const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
  if (outputId && sink) await sink.call(el, outputId).catch(() => undefined)
}

export async function listDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  const all = await navigator.mediaDevices.enumerateDevices()
  const real = (d: MediaDeviceInfo): boolean => d.deviceId !== 'default' && d.deviceId !== 'communications'
  return {
    inputs: all.filter((d) => d.kind === 'audioinput' && real(d)),
    outputs: all.filter((d) => d.kind === 'audiooutput' && real(d))
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('read failed'))
    r.readAsDataURL(blob)
  })
}

/** Decode any recorded audio → 16kHz mono WAV PCM16 for the STT sidecar. */
export async function toWav(blob: Blob): Promise<Blob> {
  const ctx = new AudioContext()
  try {
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const targetRate = 16000
    const offline = new OfflineAudioContext(1, Math.ceil((buf.duration * targetRate) / 1), targetRate)
    const src = offline.createBufferSource()
    src.buffer = buf
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    const data = rendered.getChannelData(0)
    const wav = new ArrayBuffer(44 + data.length * 2)
    const view = new DataView(wav)
    const writeStr = (off: number, s: string): void => {
      for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
    }
    writeStr(0, 'RIFF')
    view.setUint32(4, 36 + data.length * 2, true)
    writeStr(8, 'WAVE')
    writeStr(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, targetRate, true)
    view.setUint32(28, targetRate * 2, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    writeStr(36, 'data')
    view.setUint32(40, data.length * 2, true)
    for (let i = 0; i < data.length; i++) {
      const s = Math.max(-1, Math.min(1, data[i] ?? 0))
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([wav], { type: 'audio/wav' })
  } finally {
    void ctx.close()
  }
}

/** Strip Electron's "Error invoking remote method 'x': Error: " prefix. */
export function ipcError(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
