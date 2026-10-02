interface Props {
  platform?: NodeJS.Platform
}

export default function Glass({ platform }: Props): React.JSX.Element {
  const isMac = platform === 'darwin'
  return (
    <section className="glass-stage">
      <div className="glass-hero glass">
        <h2>{isMac ? 'Native vibrancy is on' : 'CSS glass fallback'}</h2>
        <p>
          {isMac
            ? 'This window uses NSVisualEffectView (fullscreen-ui) with a transparent window — the desktop blurs through behind these cards.'
            : 'No native vibrancy on this platform, so the app falls back to layered translucency + backdrop-filter. Same components, both paths.'}
        </p>
      </div>
      <div className="glass-row">
        <div className="glass-card glass">
          <h3>Card one</h3>
          <p className="muted">backdrop blur + saturate, 1px translucent border.</p>
        </div>
        <div className="glass-card glass strong">
          <h3>Card two</h3>
          <p className="muted">Stronger variant for dialogs and toasts.</p>
        </div>
        <div className="glass-card glass">
          <h3>Card three</h3>
          <p className="muted">Swap the gradient in CSS to re-theme.</p>
        </div>
      </div>
      <p className="muted small">
        Implementation: <code>BrowserWindow</code> <code>vibrancy</code> +{' '}
        <code>titleBarStyle: hiddenInset</code> on darwin (see <code>src/main/index.ts</code>),
        CSS <code>backdrop-filter</code> everywhere else.
      </p>
    </section>
  )
}
