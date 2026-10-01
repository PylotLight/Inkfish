import { useEffect, useState } from 'react'

export default function App(): React.JSX.Element {
  const [pong, setPong] = useState<string>('—')

  useEffect(() => {
    window.api
      ?.ping()
      .then(setPong)
      .catch((err: unknown) => setPong(`error: ${String(err)}`))
  }, [])

  const versions = typeof window.api !== 'undefined' ? window.api.versions : null

  return (
    <main className="page">
      <h1>bun-electron-app</h1>
      <p>
        Pure <code>bun</code> + Electron <code>{versions?.electron() ?? '…'}</code> + React + Vite +
        TypeScript.
      </p>
      <ul>
        <li>
          Node: <code>{versions?.node() ?? '…'}</code>
        </li>
        <li>
          Chrome: <code>{versions?.chrome() ?? '…'}</code>
        </li>
        <li>
          IPC <code>ping()</code>: <code>{pong}</code>
        </li>
      </ul>
      <p className="hint">
        Dev: <code>bun run dev</code> · Build: <code>bun run build</code> · Start:{' '}
        <code>bun run start</code>
      </p>
    </main>
  )
}
