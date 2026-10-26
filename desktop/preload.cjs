// Signale à l'interface qu'elle tourne dans l'appli PC (moteur local disponible).
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('nexifyNative', { platform: 'desktop', os: process.platform });
