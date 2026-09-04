const { contextBridge, ipcRenderer } = require('electron');

// The only bridge between the page and the filesystem. Keeping this surface
// tiny is what lets us run the renderer with nodeIntegration off.
contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('store:load'),
  save: (data) => ipcRenderer.invoke('store:save', data),
  dataPath: () => ipcRenderer.invoke('store:path'),
  exportNotebook: (data) => ipcRenderer.invoke('store:export', data),
  importNotebook: () => ipcRenderer.invoke('store:import')
});
