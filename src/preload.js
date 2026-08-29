const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__careidKiosk', {
  native: true,
  version: process.env.npm_package_version || null,
  platform: process.platform,
  bridgePort: 8765,
  saveConfig: (config) => ipcRenderer.invoke('kiosk:save-config', config),
  clearConfig: () => ipcRenderer.invoke('kiosk:clear-config'),
  getConfig: () => ipcRenderer.invoke('kiosk:get-config'),
  quit: () => ipcRenderer.invoke('kiosk:quit'),
});
