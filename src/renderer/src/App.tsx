import { useEffect, useState } from 'react'
import type { SysInfo } from '../../main/index'
import Kitchen from './views/Kitchen'
import TrayDemo from './views/TrayDemo'
import Glass from './views/Glass'
import Agent from './views/Agent'

type Tab = 'kitchen' | 'tray' | 'glass' | 'agent'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'kitchen', label: 'Kitchen sink' },
  { id: 'tray', label: 'Tray' },
  { id: 'glass', label: 'Glass' },
  { id: 'agent', label: 'Agent mode' }
]

export default function App(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('kitchen')
  const [sys, setSys] = useState<SysInfo | null>(null)

  useEffect(() => {
    window.api.sys.info().then(setSys).catch(console.error)
  }, [])

  return (
    <div className="app" data-platform={sys?.platform ?? 'unknown'}>
      <header className="titlebar">
        <span className="traffic-spacer" aria-hidden />
        <h1>bun-electron-app</h1>
        <span className="titlebar-sub">
          {sys ? `${sys.platform}/${sys.arch}` : '…'} · e{window.api.versions.electron()}
        </span>
      </header>

      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <main className="view">
        {tab === 'kitchen' && <Kitchen />}
        {tab === 'tray' && <TrayDemo platform={sys?.platform} />}
        {tab === 'glass' && <Glass platform={sys?.platform} />}
        {tab === 'agent' && <Agent />}
      </main>
    </div>
  )
}
