import { useEffect, useState } from 'react'
import type { GlassState, SysInfo } from '../../main/index'
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
  const [tab, setTab] = useState<Tab>('glass')
  const [sys, setSys] = useState<SysInfo | null>(null)
  const [glass, setGlass] = useState<GlassState | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    window.api.sys.info().then(setSys).catch(console.error)
    window.api.glass.get().then(setGlass).catch(console.error)
  }, [])

  const vibrancyOn = glass !== null && glass.vibrancy !== null

  return (
    <div className="shell" data-platform={sys?.platform ?? 'unknown'}>
      <aside className="sidebar">
        <div className="traffic-spacer" aria-hidden />
        <div className="brand">
          <h1>Kitchen</h1>
          <p>pure bun · electron · glass</p>
        </div>
        <nav className="nav" role="tablist" aria-label="Demo sections">
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
        <div className="side-foot">
          <span className={`status-pill${vibrancyOn ? ' on' : ''}`}>
            vibrancy {glass === null ? '…' : vibrancyOn ? 'on' : 'off'}
          </span>
          <span className="status-sub">
            {sys ? `${sys.platform} · e${window.api.versions.electron()}` : '…'}
          </span>
        </div>
      </aside>

      <div className="content">
        <header className="topbar">
          <button
            className="btn ghost"
            title="Hide the whole app (macOS: Cmd+H behavior)"
            onClick={() => void window.api.app.hide()}
          >
            Hide
          </button>
          <input
            className="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the day…"
            aria-label="Search schedule items"
          />
          <span className="weather pill">
            {sys ? `${sys.hostname} · ${sys.cpus} cores` : '…'}
          </span>
        </header>

        <main className="view">
          {tab === 'kitchen' && <Kitchen />}
          {tab === 'tray' && <TrayDemo platform={sys?.platform} />}
          {tab === 'glass' && (
            <Glass
              platform={sys?.platform}
              query={query}
              glass={glass}
              onGlassChange={setGlass}
            />
          )}
          {tab === 'agent' && <Agent />}
        </main>
      </div>
    </div>
  )
}
