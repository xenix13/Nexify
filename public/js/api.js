// Appels à l'API Nexify et suivi de la connexion au serveur.
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
    if (navigator.onLine === false) { this.set(false); return false; }
    try {
      const r = await fetchWithTimeout('/api/health', { cache: 'no-store' }, 5000);
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
  let r;
  try {
    r = await fetchWithTimeout(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' }, timeout);
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

// Adresse d'une pochette, relayée par le serveur (gardée hors ligne par le service worker)
export function artUrl(url) {
  if (!url) return '';
  if (url.startsWith('/') || url.startsWith('blob:') || url.startsWith('data:')) return url;
  return `/api/img?u=${encodeURIComponent(url)}`;
}
