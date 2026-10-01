import { contextBridge, ipcRenderer } from 'electron'

const api = {
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),
  versions: {
    node: (): string => process.versions.node,
    chrome: (): string => process.versions.chrome,
    electron: (): string => process.versions.electron
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.api = api
}

export type PreloadAPI = typeof api
