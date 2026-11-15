// Applis Nexify (Android, Windows, Linux, macOS) : dernière version publiée sur GitHub,
// fichier adapté à l'appareil, et avertissement de mise à jour dans les applis installées.
import { native } from './native.js';
import { store } from './api.js';

export const REPO = 'xenix13/Nexify';
const LATEST = `https://github.com/${REPO}/releases/latest`;

export const PLATFORMS = [
  { id: 'android', label: 'Android', file: 'Nexify-Android.apk', hint: 'Fichier APK à installer sur le téléphone' },
  { id: 'windows', label: 'Windows', file: 'Nexify-Windows.exe', hint: 'Installeur pour Windows 10 et 11' },
  { id: 'linux', label: 'Linux', file: 'Nexify-Linux.AppImage', hint: 'AppImage (aussi disponible en .deb)' },
  { id: 'macos', label: 'macOS', file: 'Nexify-macOS.dmg', hint: 'Image disque pour Mac (puce Apple)' },
];

export function currentPlatform() {
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/windows/i.test(ua)) return 'windows';
  if (/mac os x|macintosh/i.test(ua)) return 'macos';
  if (/linux|x11/i.test(ua)) return 'linux';
  return null;
}

export const directUrl = (file) => `${LATEST}/download/${file}`;

let cache = null;
// Dernière version publiée : { version, url, assets: { [fichier]: { url, size } } } ou null
export async function latestRelease({ force = false } = {}) {
  if (cache && !force && Date.now() - cache.at < 10 * 60_000) return cache.data;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { accept: 'application/vnd.github+json' }, cache: 'no-store' });
    if (r.status === 404) { cache = { at: Date.now(), data: null }; return null; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const data = {
      version: String(j.tag_name || '').replace(/^v/, ''),
      url: j.html_url,
      date: j.published_at,
      assets: Object.fromEntries((j.assets || []).map((a) => [a.name, { url: a.browser_download_url, size: a.size }])),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch {
    return undefined; // GitHub injoignable : on proposera les liens directs
  }
}

export function newer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

// Ouvre un téléchargement : navigateur du système dans les applis, nouvel onglet sinon
export function openDownload(url) {
  if (native.kind === 'android') { location.href = url; return; }
  window.open(url, '_blank', 'noopener');
}

// Applis installées : prévient une fois par version qu'une mise à jour existe
export async function checkAppUpdate(notify) {
  if (!native.isNative || !native.engineVersion) return;
  const rel = await latestRelease();
  if (!rel || !newer(rel.version, native.engineVersion)) return;
  if (store.get('appUpdateSeen') === rel.version) return;
  store.set('appUpdateSeen', rel.version);
  const os = window.nexifyNative?.os;
  const file = native.kind === 'android' ? 'Nexify-Android.apk'
    : os === 'win32' ? 'Nexify-Windows.exe' : os === 'darwin' ? 'Nexify-macOS.dmg' : os === 'linux' ? 'Nexify-Linux.AppImage' : null;
  notify(rel, file ? (rel.assets[file]?.url || directUrl(file)) : rel.url);
}
