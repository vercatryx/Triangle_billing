const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronApi', {
  showSetup: () => ipcRenderer.invoke('main:show-setup'),
  openInBrowser: () => ipcRenderer.invoke('main:open-in-browser'),
  openConfigFolder: () => ipcRenderer.invoke('main:open-config-folder'),
  openEnvFile: () => ipcRenderer.invoke('main:open-env-file'),
  print: () => ipcRenderer.invoke('main:print'),
  printToPDF: () => ipcRenderer.invoke('main:print-to-pdf'),
  savePDF: (base64, defaultFileName) => ipcRenderer.invoke('main:save-pdf', base64, defaultFileName),
  saveExcel: (base64, defaultFileName) => ipcRenderer.invoke('main:save-excel', base64, defaultFileName)
});
