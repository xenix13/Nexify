// Petite base JSON : tout tient en mémoire, écriture atomique et différée sur disque.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ version: 1, users: {}, sessions: {}, playlists: {}, oauthStates: {} });

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'spotihome.json');
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.data = EMPTY();
    if (fs.existsSync(this.file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
    this._timer = null;
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
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
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
    for (const [sid, s] of Object.entries(this.data.sessions)) if (s.userId === id) delete this.data.sessions[sid];
    for (const [pid, p] of Object.entries(this.data.playlists)) if (p.ownerId === id) delete this.data.playlists[pid];
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

  // --- playlists Spotihome (mélangeant les sources)
  playlistsOf(userId) {
    return Object.values(this.data.playlists)
      .filter((p) => p.ownerId === userId)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  playlist(id) { return this.data.playlists[id] || null; }
  putPlaylist(p) { p.updatedAt = Date.now(); this.data.playlists[p.id] = p; this.save(); return p; }
  deletePlaylist(id) { delete this.data.playlists[id]; this.save(); }
}
