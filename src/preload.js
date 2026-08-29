const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__careidKiosk', {
  native: true,
  version: process.env.npm_package_version || null,
  platform: process.platform,
  bridgePort: 8765,
  quit: () => ipcRenderer.invoke('kiosk:quit'),
});
