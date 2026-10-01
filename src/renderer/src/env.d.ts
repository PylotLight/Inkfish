/// <reference types="vite/client" />

interface Window {
  api: {
    ping: () => Promise<string>
    versions: {
      node: () => string
      chrome: () => string
      electron: () => string
    }
  }
}
