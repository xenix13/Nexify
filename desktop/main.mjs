// Nexify pour Windows, macOS et Linux (Electron).
// L'appli fait tourner localement le moteur Nexify (le même code que le serveur, en mode local) :
// recherche, accueil, radio et flux audio via yt-dlp sont faits par l'ordinateur lui-même.
// Le serveur Nexify ne sert qu'à la connexion et à la synchronisation des playlists et « J'aime ».
import { app, BrowserWindow, shell, dialog, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { ensureTools } from './tools.mjs';

const PORT = 47810; // fixe : l'origine de l'interface (et donc ses données) reste la même
const HERE = import.meta.dirname;
const CORE = app.isPackaged ? path.join(process.resourcesPath, 'nexify') : path.resolve(HERE, '..');

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) app.quit();

let win = null;

function secret(dataDir) {
  const f = path.join(dataDir, 'secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

async function startEngine() {
  const userData = app.getPath('userData');
  const logFile = path.join(userData, 'nexify.log');
  const log = (m) => { try { fs.appendFileSync(logFile, `${new Date().toISOString()} ${m}\n`); } catch { /* sans effet */ } };
  const tools = ensureTools(path.join(userData, 'bin'), { fetchImpl: (u) => net.fetch(u), log });
  const { createApp } = await import(pathToFileURL(path.join(CORE, 'server', 'app.js')).href);
  const { getConfig } = await import(pathToFileURL(path.join(CORE, 'server', 'config.js')).href);
  const config = {
    ...getConfig({ APP_SECRET: secret(userData), DATA_DIR: path.join(userData, 'engine'), HOST: '127.0.0.1', PORT: String(PORT), PUBLIC_URL: `http://127.0.0.1:${PORT}` }),
    localMode: true,
  };
  config.ytdlp = { bin: tools.ytdlp, extraArgs: ['--js-runtimes', `deno:${tools.deno}`], cookiesFile: '' };
  const engine = createApp(config, { ytdlpReady: tools.ready });
  const server = http.createServer((q, s) => engine.handle(q, s));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', resolve);
  });
  return { server, engine };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 380,
    minHeight: 560,
    backgroundColor: '#000000',
    title: 'Nexify',
    autoHideMenuBar: true,
    icon: path.join(HERE, 'icons', 'icon.png'),
    webPreferences: {
      preload: path.join(HERE, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadURL(`http://127.0.0.1:${PORT}/`);
  // liens externes (Spotify, YouTube…) : navigateur du système
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://127.0.0.1:${PORT}/`)) { e.preventDefault(); shell.openExternal(url); }
  });
}

app.on('second-instance', () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  try {
    await startEngine();
  } catch (e) {
    dialog.showErrorBox('Nexify ne peut pas démarrer', e.code === 'EADDRINUSE'
      ? `Le port ${PORT} est déjà utilisé par une autre application.`
      : String(e.message || e));
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
