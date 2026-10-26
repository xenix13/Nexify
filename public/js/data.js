// Données de l'utilisateur, gardées sur l'appareil (local d'abord) :
//  - playlists Nexify et titres « J'aime » : modifiables hors ligne, synchronisés avec le serveur ;
//  - historique d'écoute et collections récemment ouvertes : propres à l'appareil ;
//  - bibliothèque des services (Spotify, Deezer, YouTube Music) : copie gardée pour le mode hors ligne.
import { db } from './db.js';
import { net, get, post } from './api.js';
import { mergeUserData, emptyUserData } from './merge.js';

const HISTORY_MAX = 400;
const RECENT_MAX = 30;

export function newId(len = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  return Array.from(bytes, (b) => abc[b & 63]).join('');
}

const strip = (t) => ({
  key: t.key, source: t.source, sourceId: t.sourceId, title: t.title, artists: t.artists || [], album: t.album || '',
  duration: t.duration || 0, artwork: t.artwork || '', previewUrl: t.previewUrl || '', uri: t.uri || '', explicit: Boolean(t.explicit),
});

class Data extends EventTarget {
  constructor() {
    super();
    this.user = null; // profil gardé localement (fonctionne hors ligne)
    this.meta = {}; // { signupOpen, spotifyConfigured, version }
    this.ud = emptyUserData();
    this.history = [];
    this.recent = [];
    this.library = null; // { sources, at }
    this.lastSync = 0;
    this.syncing = false;
    this.syncError = '';
    this._saveTimer = null;
    this._syncTimer = null;
    net.addEventListener('change', () => { if (net.online) this.sync(); });
    setInterval(() => { if (net.online && document.visibilityState === 'visible') this.sync(); }, 5 * 60_000);
  }

  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  async load() {
    const [user, meta, ud, history, recent, library, lastSync] = await Promise.all([
      db.get('kv', 'user'), db.get('kv', 'meta'), db.get('kv', 'userdata'), db.get('kv', 'history'),
      db.get('kv', 'recent'), db.get('kv', 'library'), db.get('kv', 'lastSync'),
    ]);
    this.user = user || null;
    this.meta = meta || {};
    this.ud = ud || emptyUserData();
    this.history = history || [];
    this.recent = recent || [];
    this.library = library || null;
    this.lastSync = lastSync || 0;
  }

  // Changement de compte sur cet appareil : on repart de zéro
  async setUser(user, meta) {
    if (this.user && user && this.user.id !== user.id) await this.wipe();
    this.user = user;
    if (meta) this.meta = meta;
    await db.put('kv', user, 'user');
    if (meta) await db.put('kv', meta, 'meta');
    this.emit('user');
  }

  async wipe() {
    this.user = null;
    this.ud = emptyUserData();
    this.history = [];
    this.recent = [];
    this.library = null;
    this.lastSync = 0;
    await Promise.all(['kv', 'collections'].map((s) => db.clear(s)));
    this.emit();
  }

  _persist() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { db.put('kv', this.ud, 'userdata').catch(() => {}); }, 250);
  }

  _changed() {
    this._persist();
    this.emit();
    clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => this.sync(), 1500);
  }

  // ---------- synchronisation avec le serveur
  async sync() {
    if (!this.user || this.syncing || !net.online) return false;
    this.syncing = true;
    this.emit('sync');
    try {
      const sent = this.ud;
      const { data } = await post('/api/sync', sent, { timeout: 60_000 });
      // des modifications ont pu arriver pendant l'envoi : on refusionne avec l'état local actuel
      this.ud = mergeUserData(this.ud, data);
      this.lastSync = Date.now();
      this.syncError = '';
      await db.put('kv', this.ud, 'userdata');
      await db.put('kv', this.lastSync, 'lastSync');
      this.emit();
      return true;
    } catch (e) {
      this.syncError = e.status === 0 ? '' : e.message;
      return false;
    } finally {
      this.syncing = false;
      this.emit('sync');
    }
  }

  // ---------- playlists Nexify
  playlists() {
    return Object.values(this.ud.playlists).filter((p) => !p.deleted).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  playlist(id) {
    const p = this.ud.playlists[id];
    return p && !p.deleted ? p : null;
  }
  _putPlaylist(p) {
    p.updatedAt = Math.max(Date.now(), (this.ud.playlists[p.id]?.updatedAt || 0) + 1);
    this.ud.playlists[p.id] = p;
    this._changed();
    return p;
  }
  createPlaylist(name, tracks = [], extra = {}) {
    const now = Date.now();
    const seen = new Set();
    const list = tracks.filter((t) => !seen.has(t.key) && seen.add(t.key)).map(strip);
    return this._putPlaylist({ id: newId(), name: String(name).trim().slice(0, 120) || 'Nouvelle playlist', description: '', tracks: list, createdAt: now, ...extra });
  }
  renamePlaylist(id, name) {
    const p = this.playlist(id);
    if (!p) return null;
    return this._putPlaylist({ ...p, name: String(name).trim().slice(0, 120) || p.name });
  }
  addTracks(id, tracks) {
    const p = this.playlist(id);
    if (!p) return 0;
    const have = new Set(p.tracks.map((t) => t.key));
    const fresh = tracks.filter((t) => !have.has(t.key) && have.add(t.key)).map(strip);
    if (fresh.length) this._putPlaylist({ ...p, tracks: [...p.tracks, ...fresh].slice(0, 5000) });
    return fresh.length;
  }
  removeTrackAt(id, index) {
    const p = this.playlist(id);
    if (!p) return;
    const tracks = p.tracks.slice();
    tracks.splice(index, 1);
    this._putPlaylist({ ...p, tracks });
  }
  moveTrack(id, from, to) {
    const p = this.playlist(id);
    if (!p || to < 0 || to >= p.tracks.length) return;
    const tracks = p.tracks.slice();
    const [t] = tracks.splice(from, 1);
    tracks.splice(to, 0, t);
    this._putPlaylist({ ...p, tracks });
  }
  deletePlaylist(id) {
    if (!this.ud.playlists[id]) return;
    this._putPlaylist({ id, deleted: true });
  }

  // ---------- titres « J'aime »
  isLiked(key) { const l = this.ud.likes[key]; return Boolean(l && !l.removed); }
  likedTracks() {
    return Object.values(this.ud.likes).filter((l) => !l.removed && l.track).sort((a, b) => b.at - a.at).map((l) => l.track);
  }
  setLiked(track, liked) {
    const now = Math.max(Date.now(), (this.ud.likes[track.key]?.updatedAt || 0) + 1);
    this.ud.likes[track.key] = liked
      ? { key: track.key, track: strip(track), at: now, updatedAt: now }
      : { key: track.key, removed: true, updatedAt: now };
    this._changed();
    return liked;
  }
  toggleLike(track) { return this.setLiked(track, !this.isLiked(track.key)); }

  // ---------- historique et récents (propres à l'appareil)
  pushHistory(track) {
    this.history = [{ track: strip(track), at: Date.now() }, ...this.history.filter((h) => h.track.key !== track.key || Date.now() - h.at > 6 * 3600_000)].slice(0, HISTORY_MAX);
    db.put('kv', this.history, 'history').catch(() => {});
    this.emit('history');
  }
  recentTracks(n = 20) {
    const seen = new Set();
    const out = [];
    for (const h of this.history) {
      if (seen.has(h.track.key)) continue;
      seen.add(h.track.key);
      out.push(h.track);
      if (out.length >= n) break;
    }
    return out;
  }
  // titres les plus écoutés récemment (sélection rapide)
  topTracks(n = 20) {
    const score = new Map();
    const now = Date.now();
    for (const h of this.history) {
      const age = (now - h.at) / 86_400_000;
      const cur = score.get(h.track.key) || { track: h.track, s: 0 };
      cur.s += 1 / (1 + age / 7);
      score.set(h.track.key, cur);
    }
    return [...score.values()].sort((a, b) => b.s - a.s).slice(0, n).map((x) => x.track);
  }
  visit(item) {
    const entry = { source: item.source, id: item.id, kind: item.kind || 'playlist', name: item.name, image: item.image || '', owner: item.owner || '', at: Date.now() };
    this.recent = [entry, ...this.recent.filter((r) => !(r.source === entry.source && r.id === entry.id))].slice(0, RECENT_MAX);
    db.put('kv', this.recent, 'recent').catch(() => {});
  }
  forgetRecent(source, id) {
    this.recent = this.recent.filter((r) => !(r.source === source && r.id === id));
    db.put('kv', this.recent, 'recent').catch(() => {});
  }

  // ---------- bibliothèque des services, gardée hors ligne
  async refreshLibrary() {
    const data = await get('/api/library', { timeout: 60_000 });
    this.library = data;
    await db.put('kv', data, 'library');
    this.emit('library');
    return data;
  }
  async collection(source, id, { refresh = false } = {}) {
    const key = `${source}:${id}`;
    const cached = await db.get('collections', key);
    if (cached && (!refresh || !net.online)) return { ...cached.collection, cachedAt: cached.at };
    try {
      const { collection } = await get(`/api/collection/${source}/${encodeURIComponent(id)}`, { timeout: 90_000 });
      await db.put('collections', { collection, at: Date.now() }, key);
      return collection;
    } catch (e) {
      if (cached) return { ...cached.collection, cachedAt: cached.at, stale: true };
      throw e;
    }
  }

  // ---------- recherche locale (hors connexion)
  searchLocal(q, extra = []) {
    const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const words = norm(q).split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const pool = new Map();
    const add = (t) => { if (t && !pool.has(t.key)) pool.set(t.key, t); };
    extra.forEach(add);
    this.likedTracks().forEach(add);
    for (const p of this.playlists()) p.tracks.forEach(add);
    this.history.forEach((h) => add(h.track));
    return [...pool.values()].filter((t) => {
      const hay = norm(`${t.title} ${t.artists.join(' ')} ${t.album}`);
      return words.every((w) => hay.includes(w));
    }).slice(0, 100);
  }
}

export const data = new Data();
