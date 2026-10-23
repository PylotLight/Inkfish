import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Local AI handler utility process (utilityProcess.fork from src/main/ai-api.ts).
          'ai-handler': resolve(__dirname, 'src/main/ai-handler.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    // The in-app speech engine (vocule) spawns module workers and uses top-level await.
    worker: { format: 'es' },
    build: { target: 'esnext' },
    optimizeDeps: {
      exclude: ['@karanganesan/vocule']
    }
  }
})
