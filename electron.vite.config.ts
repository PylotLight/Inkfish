import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    // In-app speech engines spawn module workers and use top-level await.
    worker: { format: 'es' },
    build: { target: 'esnext' },
    optimizeDeps: {
      exclude: ['@karanganesan/vocule', 'parakeet.js']
    }
  }
})
