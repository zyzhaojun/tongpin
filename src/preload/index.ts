import { contextBridge, ipcRenderer } from 'electron';
import type { AppEvent, Signal, TongpinAPI } from '../shared/types';
const api: TongpinAPI = {
  version: () => ipcRenderer.invoke('tongpin:version'),
  receive: () => ipcRenderer.invoke('tongpin:receive'),
  connect: (invitation: string) => ipcRenderer.invoke('tongpin:connect', invitation),
  discover: () => ipcRenderer.invoke('tongpin:discover'),
  connectDevice: (id: string) => ipcRenderer.invoke('tongpin:connect-device', id),
  connectAddress: (address: string) => ipcRenderer.invoke('tongpin:connect-address', address),
  respondPair: (id: string, allow: boolean) => ipcRenderer.invoke('tongpin:respond-pair', id, allow),
  autoApproveNext: (enabled: boolean) => ipcRenderer.invoke('tongpin:auto-approve-next', enabled),
  firewallStatus: () => ipcRenderer.invoke('tongpin:firewall-status'),
  repairFirewall: () => ipcRenderer.invoke('tongpin:repair-firewall'),
  sources: () => ipcRenderer.invoke('tongpin:sources'),
  selectSource: (id: string) => ipcRenderer.invoke('tongpin:select-source', id),
  signal: (message: Signal) => ipcRenderer.invoke('tongpin:signal', message),
  stop: () => ipcRenderer.invoke('tongpin:stop'),
  fullscreen: () => ipcRenderer.invoke('tongpin:fullscreen'),
  copy: (value: string) => ipcRenderer.invoke('tongpin:copy', value),
  saveInvite: (value: string) => ipcRenderer.invoke('tongpin:save-invite', value),
  openInvite: () => ipcRenderer.invoke('tongpin:open-invite'),
  onEvent: (callback: (event: AppEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: AppEvent) => callback(data);
    ipcRenderer.on('tongpin:event', listener);
    return () => ipcRenderer.removeListener('tongpin:event', listener);
  }
};
contextBridge.exposeInMainWorld('tongpin', api);
