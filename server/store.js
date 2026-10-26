// Petite base JSON : tout tient en mémoire, écriture atomique et différée sur disque.
import fs from 'node:fs';
import path from 'node:path';
import { emptyUserData } from '../public/js/merge.js';

const EMPTY = () => ({ version: 2, users: {}, sessions: {}, userdata: {}, oauthStates: {}, matches: {} });

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'nexify.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = EMPTY();
    const legacy = path.join(dataDir, 'spotihome.json');
    const source = fs.existsSync(this.file) ? this.file : fs.existsSync(legacy) ? legacy : null;
    if (source) this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(source, 'utf8')) };
    this._migrate();
    this._timer = null;
  }

  // version 1 : playlists stockées à plat côté serveur → données utilisateur synchronisées
  _migrate() {
    const old = this.data.playlists;
    if (old && typeof old === 'object') {
      for (const p of Object.values(old)) {
        const ud = this.userData(p.ownerId);
        ud.playlists[p.id] = { id: p.id, name: p.name, tracks: p.tracks || [], createdAt: p.createdAt || Date.now(), updatedAt: p.updatedAt || Date.now() };
      }
      delete this.data.playlists;
    }
    this.data.version = 2;
  }

  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => this.flush(), 200);
    this._timer.unref?.();
  }

  flush() {
    clearTimeout(this._timer);
    this._timer = null;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // --- utilisateurs
  userByName(username) {
    const key = String(username).toLowerCase();
    return Object.values(this.data.users).find((u) => u.username.toLowerCase() === key) || null;
  }
  user(id) { return this.data.users[id] || null; }
  userCount() { return Object.keys(this.data.users).length; }
  putUser(u) { this.data.users[u.id] = u; this.save(); return u; }
  deleteUser(id) {
    delete this.data.users[id];
    delete this.data.userdata[id];
    for (const [sid, s] of Object.entries(this.data.sessions)) if (s.userId === id) delete this.data.sessions[sid];
    this.save();
  }

  // --- sessions
  session(id) {
    const s = this.data.sessions[id];
    if (!s) return null;
    if (s.expiresAt < Date.now()) { delete this.data.sessions[id]; this.save(); return null; }
    return s;
  }
  putSession(id, s) { this.data.sessions[id] = s; this.save(); }
  deleteSession(id) { delete this.data.sessions[id]; this.save(); }

  // --- états OAuth temporaires
  putOAuthState(state, v) {
    const now = Date.now();
    for (const [k, o] of Object.entries(this.data.oauthStates)) if (o.expiresAt < now) delete this.data.oauthStates[k];
    this.data.oauthStates[state] = { ...v, expiresAt: now + 10 * 60_000 };
    this.save();
  }
  takeOAuthState(state) {
    const v = this.data.oauthStates[state];
    delete this.data.oauthStates[state];
    this.save();
    return v && v.expiresAt > Date.now() ? v : null;
  }

  // --- données synchronisées de chaque utilisateur (playlists, titres « J'aime »)
  userData(userId) {
    if (!this.data.userdata[userId]) this.data.userdata[userId] = emptyUserData();
    return this.data.userdata[userId];
  }
  putUserData(userId, data) { this.data.userdata[userId] = data; this.save(); return data; }
}
