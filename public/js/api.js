// Appels à l'API Nexify et suivi de la connexion au serveur.
import { native } from './native.js';
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.data = data;
  }
}

// État de la connexion : « online » = le serveur Nexify répond.
class Net extends EventTarget {
  constructor() {
    super();
    this.online = navigator.onLine !== false;
    this._timer = null;
    window.addEventListener('online', () => this.check());
    window.addEventListener('offline', () => this.set(false));
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.check(); });
  }

  set(online) {
    if (online === this.online) return;
    this.online = online;
    this.dispatchEvent(new Event('change'));
    clearInterval(this._timer);
    // hors connexion : on revérifie régulièrement pour reprendre la main dès le retour du serveur
    if (!online) this._timer = setInterval(() => this.check(), 20_000);
  }

  async check() {
    if (navigator.onLine === false || (native.isNative && !native.server)) { this.set(false); return false; }
    try {
      const r = await fetchWithTimeout(`${native.server}/api/health`, { cache: 'no-store' }, 5000);
      this.set(r.ok);
      return r.ok;
    } catch {
      this.set(false);
      return false;
    }
  }
}

export const net = new Net();

async function fetchWithTimeout(url, opts = {}, ms = 20_000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: opts.signal || ac.signal });
  } finally {
    clearTimeout(t);
  }
}

export const unauthorized = new EventTarget();

export async function api(path, { method = 'GET', body, timeout = 25_000 } = {}) {
  const headers = { 'x-nexify': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (native.isNative) {
    headers['x-nexify-client'] = 'native';
    if (native.token) headers.authorization = `Bearer ${native.token}`;
  }
  let r;
  try {
    if (native.isNative && !native.server) throw new Error('serveur non configuré');
    r = await fetchWithTimeout(native.server + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: native.isNative ? 'omit' : 'same-origin', cache: 'no-store' }, timeout);
  } catch {
    net.set(false);
    throw new ApiError('Le serveur Nexify est injoignable. Vérifiez votre connexion.', 0, { code: 'offline' });
  }
  net.set(true);
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/auth/')) unauthorized.dispatchEvent(new Event('expired'));
  if (!r.ok) throw new ApiError(data.error || `Erreur ${r.status}`, r.status, data);
  return data;
}

export const get = (p, o) => api(p, o);
export const post = (p, body = {}, o = {}) => api(p, { ...o, method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });

// Petites préférences locales (synchrones)
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`nexify:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`nexify:${key}`, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
  remove(key) {
    try { localStorage.removeItem(`nexify:${key}`); } catch { /* stockage indisponible */ }
  },
};

// Pochettes des titres téléchargés, gardées sur l'appareil (adresse d'origine → blob:)
export const artOverrides = new Map();

// Adresse d'une pochette : relayée par le serveur (navigateur, gardée hors ligne par le
// service worker), par le moteur local (PC) ou chargée directement (Android)
export function artUrl(url) {
  if (!url) return '';
  if (artOverrides.has(url)) return artOverrides.get(url);
  if (url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:')) return url;
  if (native.has('img')) return native.engineUrl(`/api/img?u=${encodeURIComponent(url)}`);
  if (native.isNative) return url;
  return `/api/img?u=${encodeURIComponent(url)}`;
}

// Adresse d'un flux du serveur lisible par <audio> (applis : jeton dans l'adresse)
export function mediaUrl(path) {
  if (!native.isNative || !path.startsWith('/')) return path;
  return `${native.server}${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(native.token)}`;
}

// Fonctions musicales (recherche, accueil, radio, playlists publiques) : le serveur s'il
// répond, sinon le moteur de l'appli (PC / Android), qui n'a besoin que d'Internet.
const FEATURE = [[/^\/api\/search/, 'search'], [/^\/api\/home/, 'home'], [/^\/api\/radio/, 'radio'], [/^\/api\/collection\/ytm\//, 'collection'], [/^\/api\/resolve/, 'resolve']];
export async function music(path, opts = {}) {
  const feature = FEATURE.find(([re]) => re.test(path))?.[1];
  const local = feature && native.has(feature);
  if (net.online || !local) {
    try {
      return await api(path, opts);
    } catch (e) {
      if (!(local && e.status === 0)) throw e;
    }
  }
  return native.engineJson(path, opts);
}
