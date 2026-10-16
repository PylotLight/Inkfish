import { useState } from 'react'

/** "Copy details" next to an AI error: copies the scrubbed JSON (status, endpoint, model, message). */
export default function CopyDetails({ text }: { text: string }): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <button
      className="btn ghost sm ai-copy-details"
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setState('copied'),
          () => setState('failed')
        )
      }
      title="Copy the error details (no API key) to paste into an issue"
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy details'}
    </button>
  )
}
