// Téléchargements : fichiers audio complets gardés sur l'appareil pour l'écoute hors connexion.
// Les titres sont téléchargés un par un ; la file reprend d'elle-même au retour de la connexion.
import { db } from './db.js';
import { net, post, artUrl } from './api.js';

const PINNED = 'nexify-art-pinned';

class Downloads extends EventTarget {
  constructor() {
    super();
    this.items = new Map(); // key -> fiche { key, track, size, type, at }
    this.jobs = new Map(); // key -> { track, status: 'queued'|'active'|'error', progress, error }
    this.running = false;
    this._abort = null;
    net.addEventListener('change', () => { if (net.online) this._run(); });
  }

  emit(key) { this.dispatchEvent(new CustomEvent('change', { detail: { key } })); }

  async load() {
    const list = await db.all('downloads').catch(() => []);
    this.items = new Map(list.map((d) => [d.key, d]));
  }

  has(key) { return this.items.has(key); }
  state(key) {
    if (this.items.has(key)) return { status: 'done' };
    return this.jobs.get(key) || null;
  }
  list() { return [...this.items.values()].sort((a, b) => b.at - a.at); }
  tracks() { return this.list().map((d) => d.track); }
  totalSize() { let n = 0; for (const d of this.items.values()) n += d.size || 0; return n; }
  pending() { return [...this.jobs.values()].filter((j) => j.status !== 'error').length; }

  enqueue(tracks) {
    let added = 0;
    for (const t of Array.isArray(tracks) ? tracks : [tracks]) {
      if (this.items.has(t.key)) continue;
      const j = this.jobs.get(t.key);
      if (j && j.status !== 'error') continue;
      this.jobs.set(t.key, { track: t, status: 'queued', progress: 0 });
      added++;
      this.emit(t.key);
    }
    if (added) {
      navigator.storage?.persist?.().catch(() => {});
      this._run();
    }
    return added;
  }

  cancel(key) {
    const j = this.jobs.get(key);
    if (!j) return;
    if (j.status === 'active') this._abort?.abort();
    this.jobs.delete(key);
    this.emit(key);
  }

  async remove(key) {
    this.cancel(key);
    const d = this.items.get(key);
    this.items.delete(key);
    await db.del('audio', key).catch(() => {});
    await db.del('downloads', key).catch(() => {});
    if (d?.track?.artwork && 'caches' in window) caches.open(PINNED).then((c) => c.delete(artUrl(d.track.artwork))).catch(() => {});
    this.emit(key);
  }

  async removeAll() {
    for (const key of [...this.jobs.keys()]) this.cancel(key);
    this.items.clear();
    await db.clear('audio').catch(() => {});
    await db.clear('downloads').catch(() => {});
    if ('caches' in window) await caches.delete(PINNED).catch(() => {});
    this.emit(null);
  }

  // URL lisible par <audio> pour un titre téléchargé (à libérer avec URL.revokeObjectURL)
  async objectUrl(key) {
    const blob = await db.get('audio', key);
    return blob ? URL.createObjectURL(blob) : null;
  }

  async _run() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        if (!net.online) break;
        const job = [...this.jobs.values()].find((j) => j.status === 'queued');
        if (!job) break;
        await this._download(job);
      }
    } finally {
      this.running = false;
    }
  }

  async _download(job) {
    const t = job.track;
    job.status = 'active';
    job.progress = 0;
    this.emit(t.key);
    const ac = new AbortController();
    this._abort = ac;
    try {
      const { plan } = await post('/api/resolve', { track: t, download: true }, { timeout: 60_000 });
      const res = await fetch(plan.url, { signal: ac.signal, credentials: 'same-origin' });
      if (!res.ok) {
        const msg = await res.json().then((d) => d.error).catch(() => '');
        throw new Error(msg || `Téléchargement impossible (HTTP ${res.status})`);
      }
      const total = Number(res.headers.get('content-length')) || 0;
      const type = res.headers.get('content-type') || 'audio/mp4';
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      let lastEmit = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) job.progress = got / total;
        if (Date.now() - lastEmit > 250) { lastEmit = Date.now(); this.emit(t.key); }
      }
      if (!got) throw new Error('Fichier audio vide');
      const blob = new Blob(chunks, { type });
      await db.put('audio', blob, t.key);
      const entry = { key: t.key, track: t, size: blob.size, type, at: Date.now(), via: plan.via || null };
      await db.put('downloads', entry, t.key);
      this.items.set(t.key, entry);
      this.jobs.delete(t.key);
      this._pinArtwork(t);
      this.emit(t.key);
    } catch (e) {
      if (!this.jobs.has(t.key)) return; // annulé
      const cut = e.status === 0 || e.code === 'offline' || (e.name === 'TypeError' && !(await net.check()));
      if (cut) {
        job.status = 'queued'; // coupure réseau : reprise automatique plus tard
      } else if (e.name === 'QuotaExceededError') {
        job.status = 'error';
        job.error = 'Espace de stockage insuffisant sur cet appareil.';
      } else {
        job.status = 'error';
        job.error = e.message || 'Échec du téléchargement';
      }
      this.emit(t.key);
    } finally {
      this._abort = null;
    }
  }

  async _pinArtwork(t) {
    if (!t.artwork || !('caches' in window)) return;
    try {
      const url = artUrl(t.artwork);
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.ok) await (await caches.open(PINNED)).put(url, res);
    } catch { /* pochette facultative */ }
  }
}

export const downloads = new Downloads();

export function fmtSize(bytes) {
  if (!bytes) return '0 Mo';
  if (bytes < 1e9) return `${(bytes / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: bytes < 1e7 ? 1 : 0 })} Mo`;
  return `${(bytes / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} Go`;
}
