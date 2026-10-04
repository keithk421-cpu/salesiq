import { contextBridge, ipcRenderer } from 'electron'

const api = {
  info: () => ipcRenderer.invoke('app:info'),
  listDevices: () => ipcRenderer.invoke('devices:list'),
  getConfig: () => ipcRenderer.invoke('devices:config'),
  testDevices: (systemId: string, micId: string) => ipcRenderer.invoke('devices:test', systemId, micId),
  stopTest: () => ipcRenderer.invoke('devices:stopTest'),
  saveDevices: (systemId: string, micId: string) => ipcRenderer.invoke('devices:save', systemId, micId),
  snapshot: (label: string) => ipcRenderer.invoke('devices:snapshot', label),
  setKey: (key: string) => ipcRenderer.invoke('key:set', key),
  start: () => ipcRenderer.invoke('session:start'),
  pause: () => ipcRenderer.invoke('session:pause'),
  resume: () => ipcRenderer.invoke('session:resume'),
  stop: () => ipcRenderer.invoke('session:stop'),
  switchEndpoint: (stream: string, id: string) => ipcRenderer.invoke('session:switchEndpoint', stream, id),
  openFolder: () => ipcRenderer.invoke('app:openFolder'),
  onSession: (cb: (ev: unknown) => void) => ipcRenderer.on('session-event', (_e, ev) => cb(ev)),
  onTest: (cb: (ev: unknown) => void) => ipcRenderer.on('test-event', (_e, ev) => cb(ev)),
}

contextBridge.exposeInMainWorld('copilot', api)
export type CopilotApi = typeof api
