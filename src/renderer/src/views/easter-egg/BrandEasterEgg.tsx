import { lazy, Suspense, useCallback, useRef, useState } from 'react'
import { EMPTY_CLICK_BURST, registerClick } from '../../../../shared/click-burst'

/**
 * Hidden: triple-click the Inkfish logo at the top of the sidebar for a big animated logo
 * (ported from Surffish's toolbar-logo egg). The trigger is a few lines in the main bundle; the
 * card (markup + CSS) is its own chunk, loaded on the first triple-click only.
 */
export function useBrandTripleClick(): { open: boolean; onClick: () => void; close: () => void } {
  const [open, setOpen] = useState(false)
  const burst = useRef(EMPTY_CLICK_BURST)
  const onClick = useCallback(() => {
    const result = registerClick(burst.current, performance.now())
    burst.current = result.burst
    if (result.fired) setOpen(true)
  }, [])
  const close = useCallback(() => setOpen(false), [])
  return { open, onClick, close }
}

const InkfishEgg = lazy(() => import('./InkfishEgg'))

export function BrandEasterEgg({ logoUrl, onClose }: { logoUrl: string; onClose: () => void }): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <InkfishEgg logoUrl={logoUrl} onClose={onClose} />
    </Suspense>
  )
}
