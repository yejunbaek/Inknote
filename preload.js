const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The only bridge between the page and the filesystem. Keeping this surface
// tiny is what lets us run the renderer with nodeIntegration off.
contextBridge.exposeInMainWorld('api', {
  load: () => ipcRenderer.invoke('store:load'),
  save: (data) => ipcRenderer.invoke('store:save', data),
  dataPath: () => ipcRenderer.invoke('store:path'),
  exportNotebook: (data) => ipcRenderer.invoke('store:export', data),
  importNotebook: () => ipcRenderer.invoke('store:import'),

  saveImage: (dataUrl) => ipcRenderer.invoke('image:save', dataUrl),
  // Desktop already serves these directly; the web build overrides this.
  imageUrl: (src) => src,
  deleteImage: (url) => ipcRenderer.invoke('image:delete', url),
  readImageFile: (filePath) => ipcRenderer.invoke('image:readFile', filePath),

  // Electron 32 removed File.path; this is the supported replacement for
  // turning a dropped File back into a filesystem path.
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  }
});
