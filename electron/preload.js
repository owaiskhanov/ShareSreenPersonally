'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only surface the page can touch. No Node, no fs, no arbitrary IPC.
 */
contextBridge.exposeInMainWorld('screenLink', {
  isElectron: true,

  info: () => ipcRenderer.invoke('app:info'),

  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
  },

  listSources: () => ipcRenderer.invoke('sources:list'),
  startShare: (payload) => ipcRenderer.invoke('share:start', payload),
  stopShare: () => ipcRenderer.invoke('share:stop'),

  setControlAllowed: (allowed) => ipcRenderer.invoke('control:set', allowed),
  controlState: () => ipcRenderer.invoke('control:state'),

  sendInput: (evt) => ipcRenderer.send('input:event', evt),

  clipboard: {
    read: () => ipcRenderer.invoke('clipboard:read'),
    write: (text) => ipcRenderer.invoke('clipboard:write', text),
  },

  window: {
    fullscreen: (on) => ipcRenderer.invoke('window:fullscreen', on),
    minimize: () => ipcRenderer.invoke('window:minimize'),
  },

  // Fired when the local "stop remote control" hotkey is pressed.
  onControlRevoked: (cb) => {
    ipcRenderer.on('control:revoked', () => cb());
  },
});
