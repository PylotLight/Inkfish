import { useEffect, useState } from 'react'

interface Props {
  onDone: () => void
}

/** Onboarding: 3 steps — vault location, mic test, shortcut confirm. */
export default function Onboarding({ onDone }: Props): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [vault, setVault] = useState<string>('')
  const [mic, setMic] = useState<'untested' | 'ok' | 'blocked'>('untested')

  useEffect(() => {
    window.api.vault.info().then((v) => setVault(v.root)).catch(console.error)
  }, [])

  const testMic = async (): Promise<void> => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
      setMic('ok')
    } catch {
      setMic('blocked')
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal glass strong onboard">
        <span className="stat-label">Inkfish setup {step + 1}/3</span>
        {step === 0 && (
          <>
            <h3>Your vault lives here</h3>
            <p className="muted">
              Plain Markdown files — <code>inbox/</code>, <code>projects/&lt;name&gt;/</code>,{' '}
              <code>assets/</code>. No server, no lock-in.
            </p>
            <code className="pill">{vault || '…'}</code>
            <div className="row end">
              <button className="btn ghost" onClick={() => void window.api.vault.reveal()}>
                Reveal
              </button>
              <button className="btn" onClick={() => setStep(1)}>
                Next
              </button>
            </div>
          </>
        )}
        {step === 1 && (
          <>
            <h3>Mic check</h3>
            <p className="muted">
              Voice notes + meeting capture need the mic. Headphones recommended (model-card
              noise weakness).
            </p>
            <div className="row">
              <button className="btn" onClick={() => void testMic()}>
                Test mic
              </button>
              <span className="muted">
                {mic === 'ok' ? '✓ hearing you' : mic === 'blocked' ? 'blocked — typing still works' : ''}
              </span>
            </div>
            <div className="row end">
              <button className="btn ghost" onClick={() => setStep(0)}>
                Back
              </button>
              <button className="btn" onClick={() => setStep(2)}>
                Next
              </button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h3>⌥Space squirts ink</h3>
            <p className="muted">
              The global shortcut pops capture from anywhere. <code>⌘↵</code> saves to the
              inbox — the worker routes it, raw is never deleted.
            </p>
            <div className="row end">
              <button className="btn ghost" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="btn mint"
                onClick={() => {
                  localStorage.setItem('inkfish.onboarded', '1')
                  onDone()
                }}
              >
                Start capturing
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
