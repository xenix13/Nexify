// Applis Android et PC : l'interface est embarquée dans l'appli, la musique est récupérée
// directement par l'appareil grâce à un moteur local, et le serveur Nexify ne sert plus
// qu'à la connexion et à la synchronisation.
//
//  - PC (Electron) : le moteur Nexify complet tourne dans l'appli (yt-dlp, recherche,
//    accueil, radio…) et sert aussi l'interface : même origine.
//  - Android (Capacitor) : un module natif (NewPipeExtractor) fournit la recherche et le flux audio.

const LS = 'nexify:';
const read = (k) => { try { return localStorage.getItem(LS + k) || ''; } catch { return ''; } };
const write = (k, v) => { try { if (v) localStorage.setItem(LS + k, v); else localStorage.removeItem(LS + k); } catch { /* indisponible */ } };

// module natif Android (déclaré dans MainActivity)
let pluginRef = null;
function enginePlugin() {
  const cap = window.Capacitor;
  if (!cap) return null;
  if (!pluginRef) pluginRef = cap.Plugins?.NexifyEngine || cap.registerPlugin?.('NexifyEngine') || null;
  return pluginRef;
}

function detect() {
  if (window.nexifyNative?.platform === 'desktop') return 'desktop';
  if (window.Capacitor?.isNativePlatform?.()) return 'android';
  return null;
}

class Native {
  constructor() {
    this.kind = detect();
    this.engineBase = null;
    this.features = new Set();
    this.engineVersion = '';
  }

  get isNative() { return Boolean(this.kind); }

  // adresse du serveur Nexify (applis uniquement ; dans le navigateur c'est l'origine de la page)
  get server() { return this.isNative ? read('server') : ''; }
  setServer(url) { write('server', String(url || '').trim().replace(/\/+$/, '')); }
  get token() { return this.isNative ? read('token') : ''; }
  setToken(t) { write('token', t || ''); }

  has(feature) { return Boolean(this.engineBase) && this.features.has(feature); }

  async init() {
    if (!this.kind) return;
    try {
      if (this.kind === 'desktop') this.engineBase = location.origin;
      else {
        const plugin = enginePlugin();
        if (!plugin) return;
        const { port } = await plugin.start();
        this.engineBase = `http://127.0.0.1:${port}`;
      }
      const r = await fetch(`${this.engineBase}/api/health`, { cache: 'no-store' });
      const h = await r.json();
      this.features = new Set(h.features || []);
      this.engineVersion = h.version || '';
    } catch {
      this.engineBase = null;
      this.features = new Set();
    }
  }

  engineUrl(path) { return `${this.engineBase}${path}`; }
  streamUrl(videoId) { return this.engineUrl(`/api/ytm/stream/${encodeURIComponent(videoId)}`); }

  async engineJson(path, { method = 'GET', body, timeout = 45_000 } = {}) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      const r = await fetch(this.engineUrl(path), {
        method,
        signal: ac.signal,
        headers: { 'x-nexify': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(data.error || `Erreur ${r.status}`), { status: r.status, code: data.code });
      return data;
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof TypeError) throw Object.assign(new Error('Pas de connexion Internet.'), { status: 0, code: 'offline' });
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  // Android : notification de lecture (garde l'appli active écran éteint)
  // (arrêt différé : pas de coupure de la notification entre deux titres ou pendant une courte pause)
  playback(playing, track) {
    const plugin = this.kind === 'android' ? enginePlugin() : null;
    if (!plugin) return;
    clearTimeout(this._stopTimer);
    if (playing) {
      plugin.playback({ playing: true, title: track?.title || 'Nexify', artist: (track?.artists || []).join(', ') }).catch(() => {});
    } else {
      this._stopTimer = setTimeout(() => plugin.playback({ playing: false }).catch(() => {}), 10 * 60_000);
    }
  }
}

export const native = new Native();
