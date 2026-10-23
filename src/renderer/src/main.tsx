import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { cleanupLegacyWebModels } from './webStt'

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('Missing #root element')

// Free the space held by Web speech models that were removed.
void cleanupLegacyWebModels()

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>
)
