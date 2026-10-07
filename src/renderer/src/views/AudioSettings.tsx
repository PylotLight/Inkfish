import { useEffect, useRef, useState } from 'react'
import {
  listDevices,
  loadAudioPrefs,
  openMic,
  routeOutput,
  saveAudioPrefs,
  type AudioPrefs
} from '../audio'

type TestState = 'idle' | 'recording'

/** Settings › Audio: pick mic + speaker, watch the level, record/play/transcribe a test. */
export default function AudioSettings(): React.JSX.Element {
  const [prefs, setPrefs] = useState<AudioPrefs>(loadAudioPrefs)
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [outputs, setOutputs] = useState<MediaDeviceInfo[]>([])
  const [needsAccess, setNeedsAccess] = useState(false)
  const [level, setLevel] = useState(0)
  const [monitoring, setMonitoring] = useState(false)
  const [test, setTest] = useState<TestState>('idle')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const meter = useRef<{ stream: MediaStream; ctx: AudioContext; raf: number } | null>(null)
  const lastTake = useRef<string | null>(null)

  const refresh = async (): Promise<void> => {
    const { inputs: i, outputs: o } = await listDevices()
    setInputs(i)
    setOutputs(o)
    // Labels are blank until mic permission is granted.
    setNeedsAccess(i.length > 0 && i.every((d) => !d.label))
  }

  useEffect(() => {
    void refresh()
    const onChange = (): void => void refresh()
    navigator.mediaDevices.addEventListener('devicechange', onChange)
    return () => {
      navigator.mediaDevices.removeEventListener('devicechange', onChange)
      stopMeter()
      if (lastTake.current) URL.revokeObjectURL(lastTake.current)
    }
  }, [])

  const update = (patch: Partial<AudioPrefs>): void => {
    const next = { ...prefs, ...patch }
    setPrefs(next)
    saveAudioPrefs(next)
    if (patch.inputId !== undefined && monitoring) {
      stopMeter()
      void startMeter(next.inputId)
    }
  }

  const allow = async (): Promise<void> => {
    try {
      const s = await openMic()
      s.getTracks().forEach((t) => t.stop())
      await refresh()
    } catch {
      setResult({ ok: false, text: 'Mic blocked — allow Inkfish in System Settings › Privacy & Security › Microphone.' })
    }
  }

  const startMeter = async (inputId = prefs.inputId): Promise<void> => {
    try {
      const stream = await openMic(inputId)
      const ctx = new AudioContext()
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      ctx.createMediaStreamSource(stream).connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      const tick = (): void => {
        analyser.getFloatTimeDomainData(buf)
        let sum = 0
        for (const v of buf) sum += v * v
        const rms = Math.sqrt(sum / buf.length)
        setLevel(Math.min(1, rms * 4))
        if (meter.current) meter.current.raf = requestAnimationFrame(tick)
      }
      meter.current = { stream, ctx, raf: requestAnimationFrame(tick) }
      setMonitoring(true)
      void refresh()
    } catch {
      setResult({ ok: false, text: 'Could not open that microphone.' })
    }
  }

  function stopMeter(): void {
    const m = meter.current
    if (!m) return
    cancelAnimationFrame(m.raf)
    m.stream.getTracks().forEach((t) => t.stop())
    void m.ctx.close()
    meter.current = null
    setMonitoring(false)
    setLevel(0)
  }

  const recordTest = async (): Promise<void> => {
    setResult(null)
    let stream: MediaStream
    try {
      stream = await openMic()
    } catch {
      setResult({ ok: false, text: 'Mic blocked — allow Inkfish in System Settings › Privacy & Security › Microphone.' })
      return
    }
    const rec = new MediaRecorder(stream)
    const chunks: Blob[] = []
    rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data)
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      const blob = new Blob(chunks, { type: rec.mimeType })
      if (lastTake.current) URL.revokeObjectURL(lastTake.current)
      lastTake.current = URL.createObjectURL(blob)
      setTest('idle')
      void play(lastTake.current)
    }
    rec.start()
    setTest('recording')
    window.setTimeout(() => rec.state === 'recording' && rec.stop(), 4000)
  }

  const play = async (url: string): Promise<void> => {
    const el = new Audio(url)
    await routeOutput(el, prefs.outputId)
    await el.play().catch(() => setResult({ ok: false, text: 'Playback failed on that output.' }))
  }

  const playTone = async (): Promise<void> => {
    const rate = 44100
    const ctx = new OfflineAudioContext(1, rate * 0.9, rate)
    const notes = [660, 880]
    notes.forEach((f, i) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.frequency.value = f
      const t = i * 0.3
      g.gain.setValueAtTime(0, t)
      g.gain.linearRampToValueAtTime(0.25, t + 0.02)
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.5)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + 0.55)
    })
    const buf = await ctx.startRendering()
    const url = URL.createObjectURL(new Blob([encodeWav(buf)], { type: 'audio/wav' }))
    await play(url)
    window.setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  const label = (d: MediaDeviceInfo, i: number, kind: string): string => d.label || `${kind} ${i + 1}`

  return (
    <section className="settings-group">
      <h4>Audio</h4>

      {needsAccess && (
        <div className="setting-row inline">
          <span className="setting-label">
            Device names are hidden
            <span className="muted small setting-hint">Grant microphone access to list your devices.</span>
          </span>
          <button className="btn ghost sm" onClick={() => void allow()}>
            Allow mic
          </button>
        </div>
      )}

      <div className="setting-row stacked">
        <span className="setting-label">Microphone</span>
        <div className="row" style={{ marginTop: 0 }}>
          <select
            className="grow"
            value={prefs.inputId}
            onChange={(e) => update({ inputId: e.target.value })}
            aria-label="Microphone"
          >
            <option value="">System default</option>
            {inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d, i, 'Microphone')}
              </option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={() => (monitoring ? stopMeter() : void startMeter())}>
            {monitoring ? 'Stop' : 'Check level'}
          </button>
        </div>
        <div className="level-meter" aria-hidden={!monitoring}>
          <span style={{ transform: `scaleX(${level})` }} />
        </div>
      </div>

      <div className="setting-row stacked">
        <span className="setting-label">Speaker</span>
        <div className="row" style={{ marginTop: 0 }}>
          <select
            className="grow"
            value={prefs.outputId}
            onChange={(e) => update({ outputId: e.target.value })}
            aria-label="Speaker"
          >
            <option value="">System default</option>
            {outputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d, i, 'Speaker')}
              </option>
            ))}
          </select>
          <button className="btn ghost sm" onClick={() => void playTone()}>
            Play test sound
          </button>
        </div>
      </div>

      <div className="setting-row stacked">
        <span className="setting-label">
          Mic test
          <span className="muted small setting-hint">Record 4 seconds, then play it back on the chosen speaker.</span>
        </span>
        <div className="row" style={{ marginTop: 0 }}>
          <button className="btn ghost sm" disabled={test !== 'idle'} onClick={() => void recordTest()}>
            {test === 'recording' ? 'Listening… (4 s)' : 'Record 4 s'}
          </button>
          <button
            className="btn ghost sm"
            disabled={!lastTake.current || test !== 'idle'}
            onClick={() => lastTake.current && void play(lastTake.current)}
          >
            Play back
          </button>
        </div>
        {result && (
          <p className={`small setting-hint ${result.ok ? '' : 'error-text'}`} style={{ overflowWrap: 'anywhere' }}>
            {result.text}
          </p>
        )}
      </div>
    </section>
  )
}

/** AudioBuffer → WAV PCM16 (mono). */
function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const data = buf.getChannelData(0)
  const out = new ArrayBuffer(44 + data.length * 2)
  const v = new DataView(out)
  const s = (o: number, t: string): void => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i))
  }
  s(0, 'RIFF'); v.setUint32(4, 36 + data.length * 2, true); s(8, 'WAVE'); s(12, 'fmt ')
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, buf.sampleRate, true); v.setUint32(28, buf.sampleRate * 2, true)
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, data.length * 2, true)
  for (let i = 0; i < data.length; i++) {
    const x = Math.max(-1, Math.min(1, data[i] ?? 0))
    v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true)
  }
  return out
}
