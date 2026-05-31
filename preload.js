const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('querypad', {
  db: {
    testConnection: (cfg) => ipcRenderer.invoke('db:test-connection', cfg),
    execute:        (id, sql) => ipcRenderer.invoke('db:execute', id, sql),
    getSchema:      (id) => ipcRenderer.invoke('db:get-schema', id),
    saveConnection: (cfg) => ipcRenderer.invoke('db:save-connection', cfg),
    loadConnections: () => ipcRenderer.invoke('db:load-connections'),
    deleteConnection: (id) => ipcRenderer.invoke('db:delete-connection', id),
    connect:        (id) => ipcRenderer.invoke('db:connect', id),
    disconnect:     (id) => ipcRenderer.invoke('db:disconnect', id),
  },
  query: {
    save:   (name, connId, content) => ipcRenderer.invoke('query:save', name, connId, content),
    load:   (name, connId)          => ipcRenderer.invoke('query:load', name, connId),
    list:   (connId)                => ipcRenderer.invoke('query:list', connId),
    delete: (name, connId)          => ipcRenderer.invoke('query:delete', name, connId),
  },
  session: {
    save: (s) => ipcRenderer.invoke('session:save', s),
    load: ()  => ipcRenderer.invoke('session:load'),
  },
  dialog: {
    save: (name, content) => ipcRenderer.invoke('dialog:save', name, content),
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
});
