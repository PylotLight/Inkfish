import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import './inkfish-egg.css'

// A little squid (head at +x, tentacles trailing), drawn around the origin so it can ride a path.
const SQUID =
  'M30 0C30-9 20-14 6-13L-8-10C-14-8-18-4-18 0-18 4-14 8-8 10L6 13C20 14 30 9 30 0Z' +
  'M-16-6C-26-12-34-10-42-14-34-6-26-6-18-3Z' +
  'M-18 0C-28-2-36 2-46 0-36 4-28 4-18 2Z' +
  'M-16 6C-26 12-34 10-42 14-34 6-26 6-18 3Z'
// The squid's swim: a lazy figure-eight around the logo. Its ink trail follows the same path.
const SWIM = 'M0 0C120-150 330-150 330 0S120 150 0 0-120-150-330 0-120 150 0 0Z'
const BUBBLES = [
  { x: 9, size: 9, delay: 0, duration: 9 },
  { x: 18, size: 5, delay: 2.4, duration: 7.5 },
  { x: 27, size: 12, delay: 4.1, duration: 11 },
  { x: 39, size: 6, delay: 1.2, duration: 8 },
  { x: 61, size: 10, delay: 3.3, duration: 10 },
  { x: 70, size: 5, delay: 5.6, duration: 7 },
  { x: 79, size: 12, delay: 0.8, duration: 12 },
  { x: 90, size: 7, delay: 2.9, duration: 9.5 }
]
// Ink puffs blooming out from behind the logo (where, how big, when).
const PUFFS = [
  { x: 38, y: 58, size: 30, delay: 0 },
  { x: 62, y: 44, size: 26, delay: 1.6 },
  { x: 47, y: 34, size: 22, delay: 3.1 },
  { x: 57, y: 63, size: 34, delay: 4.4 }
]
// Ink drops falling from the top and blooming into rings where they land.
const DROPS = [
  { x: 14, delay: 0.4 },
  { x: 31, delay: 2.2 },
  { x: 72, delay: 1.3 },
  { x: 86, delay: 3.5 }
]

const SWIM_SECONDS = 12
const TRAIL_LENGTH = 22
// Reduced motion: the squid rests on the right loop (about a quarter of the way round), heading down.
const STILL_AT = 25

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** The squid riding the swim path nose first, with a little pulse (jet) and wiggle. SMIL so it shares the trail's clock. */
function Swimmer({ still }: { still: boolean }): React.JSX.Element {
  return (
    <g className="inkfish-egg-squid" transform={still ? 'translate(330 0) rotate(90)' : undefined}>
      {!still && <animateMotion dur={`${SWIM_SECONDS}s`} repeatCount="indefinite" rotate="auto" path={SWIM} calcMode="linear" />}
      <g>
        {!still && (
          <animateTransform
            attributeName="transform"
            type="scale"
            values="1 1;1.12 0.86;1 1"
            dur="1.2s"
            repeatCount="indefinite"
            calcMode="spline"
            keyTimes="0;0.35;1"
            keySplines=".3 0 .5 1;.4 0 .6 1"
          />
        )}
        <path d={SQUID} fill="url(#inkfish-egg-squid-fill)" />
        <circle cx="16" cy="-4" r="2.6" fill="#071a24" />
      </g>
    </g>
  )
}

/**
 * The logo easter egg: a window-sized card with the Inkfish logo floating in deep ink-dark water
 * while a little squid swims a figure-eight around it, writing an ink trail that fades behind it,
 * ink puffs bloom, drops land as rings and bubbles rise. Pure CSS/SVG, no new assets (the logo is
 * the sidebar's own). Closes on a click anywhere, Esc, or the window losing focus.
 * prefers-reduced-motion gets the same scene, still.
 */
export default function InkfishEgg({ logoUrl, onClose }: { logoUrl: string; onClose: () => void }): React.JSX.Element {
  const dialogRef = useRef<HTMLDivElement>(null)
  const [still] = useState(prefersReducedMotion)
  useEffect(() => {
    dialogRef.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    // Capture phase so the editor / other Esc handlers don't see it while the egg is up.
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  return createPortal(
    <div
      ref={dialogRef}
      className={`inkfish-egg${still ? ' is-still' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="Inkfish"
      tabIndex={-1}
      onClick={onClose}
    >
      <div className="inkfish-egg-water" aria-hidden="true">
        {PUFFS.map((p, i) => (
          <span key={i} className="inkfish-egg-puff" style={{ left: `${p.x}%`, top: `${p.y}%`, width: `${p.size}cqmin`, animationDelay: `${p.delay}s` }} />
        ))}
        {DROPS.map((d, i) => (
          <span key={i} className="inkfish-egg-drop" style={{ left: `${d.x}%`, animationDelay: `${d.delay}s` }}>
            <i />
          </span>
        ))}
      </div>
      <div className="inkfish-egg-stage" aria-hidden="true">
        <div className="inkfish-egg-glow" />
        <svg className="inkfish-egg-swim" viewBox="-400 -200 800 400">
          <defs>
            <linearGradient id="inkfish-egg-squid-fill" x1="0" x2="1">
              <stop offset="0" stopColor="#7fd3df" />
              <stop offset="1" stopColor="#e6fbff" />
            </linearGradient>
          </defs>
          {/* The ink trail: a dash TRAIL_LENGTH long that ends at the squid, on the same clock
              (pathLength 100: at fraction f the squid is at 100f, so the dash spans 100f-L..100f). */}
          <path d={SWIM} className="inkfish-egg-trail is-faint" pathLength={100} />
          <path
            d={SWIM}
            className="inkfish-egg-trail"
            pathLength={100}
            strokeDasharray={`${TRAIL_LENGTH} ${100 - TRAIL_LENGTH}`}
            strokeDashoffset={still ? TRAIL_LENGTH - STILL_AT : TRAIL_LENGTH}
          >
            {!still && (
              <animate attributeName="stroke-dashoffset" from={TRAIL_LENGTH} to={TRAIL_LENGTH - 100} dur={`${SWIM_SECONDS}s`} repeatCount="indefinite" />
            )}
          </path>
          <Swimmer still={still} />
        </svg>
        <div className="inkfish-egg-logo">
          <img src={logoUrl} alt="" draggable={false} />
          <span className="inkfish-egg-shine" />
        </div>
      </div>
      <div className="inkfish-egg-sea" aria-hidden="true">
        {BUBBLES.map((b, i) => (
          <span
            key={i}
            className="inkfish-egg-bubble"
            style={{ left: `${b.x}%`, width: b.size, height: b.size, animationDelay: `${b.delay}s`, animationDuration: `${b.duration}s` }}
          />
        ))}
      </div>
      <div className="inkfish-egg-caption">
        <strong>Inkfish</strong>
        <span>you found the ink · click anywhere or press Esc</span>
      </div>
    </div>,
    document.body
  )
}
