'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// The launcher shell runs with contextIsolation on and no Node access; everything it can
// do is the fixed set of calls below, each answered by the main process.
contextBridge.exposeInMainWorld('launcher', {
    getState: () => ipcRenderer.invoke('launcher:getState'),
    discordLogin: () => ipcRenderer.invoke('launcher:discordLogin'),
    forgetDiscordLogin: () => ipcRenderer.invoke('launcher:forgetDiscordLogin'),
    play: () => ipcRenderer.invoke('launcher:play'),
    browseFlash: () => ipcRenderer.invoke('launcher:browseFlash'),
    moveToApplications: () => ipcRenderer.invoke('launcher:moveToApplications'),
    relaunch: () => ipcRenderer.invoke('launcher:relaunch'),
    quit: () => ipcRenderer.invoke('launcher:quit'),
    updateCheck: () => ipcRenderer.invoke('launcher:updateCheck'),
    updateInstall: () => ipcRenderer.invoke('launcher:updateInstall'),
    onState: (handler) => {
        const listener = (_event, state) => handler(state);
        ipcRenderer.on('launcher:state', listener);
        return () => ipcRenderer.removeListener('launcher:state', listener);
    }
});
