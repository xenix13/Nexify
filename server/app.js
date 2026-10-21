// Assemblage de l'application : routes API, sessions, fichiers statiques.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { Store } from './store.js';
import { makeCipher, hashPassword, verifyPassword, randomId } from './crypto.js';
import { Router, HttpError, readJson, sendJson, redirect, parseCookies, cookie } from './http.js';
import { SpotifyProvider } from './providers/spotify.js';
import { DeezerProvider } from './providers/deezer.js';
import { YtMusicProvider } from './providers/ytmusic.js';
import { YtDlp, VIDEO_ID } from './providers/ytdlp.js';
import { Matcher } from './match.js';
import { sanitizeTrack, SOURCES } from './track.js';

const SESSION_COOKIE = 'sh_sid';
const SESSION_DAYS = 30;
const PUBLIC_DIR = path.join(ROOT, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://sdk.scdn.co",
  'frame-src https://sdk.scdn.co',
  "img-src 'self' https: data:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https: wss:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const DEFAULT_SETTINGS = { spotifyPlayback: 'sdk', deezerPlayback: 'ytm' };

export function createApp(config, deps = {}) {
  const store = deps.store || new Store(config.dataDir);
  const cipher = makeCipher(config.appSecret);
  const fetchImpl = deps.fetch || fetch;
  const spotify = new SpotifyProvider({ config, store, cipher, fetchImpl });
  const deezer = new DeezerProvider({ store, fetchImpl });
  const ytm = new YtMusicProvider({ config, store, cipher, fetchImpl });
  const ytdlp = new YtDlp({ config, fetchImpl, spawnImpl: deps.spawn });
  const matcher = new Matcher({ ytm, store });
  const providers = { spotify, deezer, ytm };
  const loginAttempts = new Map();

  const publicUser = (u) => ({
    id: u.id,
    username: u.username,
    isAdmin: Boolean(u.isAdmin),
    settings: { ...DEFAULT_SETTINGS, ...(u.settings || {}) },
    providers: { spotify: spotify.status(u), deezer: deezer.status(u), ytm: ytm.status(u) },
  });

  function startSession(res, user) {
    const sid = randomId(32);
    store.putSession(sid, { userId: user.id, expiresAt: Date.now() + SESSION_DAYS * 86_400_000 });
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400, secure: config.https }));
  }

  function currentUser(req) {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const s = sid && store.session(sid);
    return s ? store.user(s.userId) : null;
  }

  const requireUser = (req) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Connexion requise');
    return u;
  };
  const requireAdmin = (req) => {
    const u = requireUser(req);
    if (!u.isAdmin) throw new HttpError(403, 'Réservé à l’administrateur');
    return u;
  };

  function validCredentials(body) {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new HttpError(400, 'Nom d’utilisateur : 2 à 32 caractères (lettres, chiffres, . _ -).');
    if (password.length < 8) throw new HttpError(400, 'Mot de passe : 8 caractères minimum.');
    return { username, password };
  }

  function createUser({ username, password }, isAdmin) {
    if (store.userByName(username)) throw new HttpError(409, 'Ce nom d’utilisateur existe déjà.');
    return store.putUser({ id: randomId(12), username, password: hashPassword(password), isAdmin, createdAt: Date.now(), settings: { ...DEFAULT_SETTINGS } });
  }

  const signupOpen = () => config.allowSignup === 'yes' || (config.allowSignup !== 'no' && store.userCount() === 0);

  // ---- comment lire un titre donné, selon les réglages et les comptes liés
  async function playbackPlan(user, track, prefer) {
    const settings = { ...DEFAULT_SETTINGS, ...(user.settings || {}) };
    if (track.source === 'ytm') {
      if (!VIDEO_ID.test(track.sourceId)) throw new HttpError(400, 'Identifiant YouTube invalide');
      return { mode: 'audio', url: `/api/ytm/stream/${track.sourceId}` };
    }
    if (track.source === 'spotify' && prefer !== 'ytm' && settings.spotifyPlayback === 'sdk' && spotify.linked(user)) {
      return { mode: 'spotify', uri: track.uri || `spotify:track:${track.sourceId}` };
    }
    if (track.source === 'deezer' && settings.deezerPlayback === 'preview' && track.previewUrl && prefer !== 'ytm') {
      return { mode: 'audio', url: track.previewUrl, preview: true };
    }
    let match = null;
    try {
      match = await matcher.find(track);
    } catch (e) {
      if (!track.previewUrl) throw e;
    }
    if (match) return { mode: 'audio', url: `/api/ytm/stream/${match.videoId}`, via: { source: 'ytm', videoId: match.videoId, title: match.title, artists: match.artists } };
    if (track.previewUrl) return { mode: 'audio', url: track.previewUrl, preview: true };
    throw new HttpError(404, 'Aucune version lisible trouvée pour ce titre.');
  }

  // ---- routes
  const r = new Router();

  r.get('/api/health', () => ({ ok: true }));

  r.get('/api/me', (req) => {
    const u = currentUser(req);
    return {
      user: u ? publicUser(u) : null,
      signupOpen: signupOpen(),
      firstRun: store.userCount() === 0,
      spotifyConfigured: spotify.configured,
    };
  });

  r.post('/api/auth/signup', async (req, res) => {
    if (!signupOpen()) throw new HttpError(403, 'Les inscriptions sont fermées : demande un compte à l’administrateur.');
    const creds = validCredentials(await readJson(req));
    const user = createUser(creds, store.userCount() === 0);
    startSession(res, user);
    return { user: publicUser(user) };
  });

  r.post('/api/auth/login', async (req, res) => {
    const ip = req.socket.remoteAddress || '';
    const a = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Trop de tentatives, réessaie dans une minute.');
    const body = await readJson(req);
    const user = store.userByName(String(body.username || '').trim());
    if (!user || !verifyPassword(String(body.password || ''), user.password)) {
      a.n += 1;
      if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
      loginAttempts.set(ip, a);
      throw new HttpError(401, 'Identifiants incorrects.');
    }
    loginAttempts.delete(ip);
    startSession(res, user);
    return { user: publicUser(user) };
  });

  r.post('/api/auth/logout', (req, res) => {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (sid) store.deleteSession(sid);
    res.setHeader('set-cookie', cookie(SESSION_COOKIE, '', { maxAge: 0, secure: config.https }));
    return { ok: true };
  });

  r.post('/api/me/password', async (req) => {
    const u = requireUser(req);
    const body = await readJson(req);
    if (!verifyPassword(String(body.current || ''), u.password)) throw new HttpError(400, 'Mot de passe actuel incorrect.');
    const { password } = validCredentials({ username: u.username, password: body.password });
    u.password = hashPassword(password);
    store.putUser(u);
    return { ok: true };
  });

  r.patch('/api/me/settings', async (req) => {
    const u = requireUser(req);
    const body = await readJson(req);
    const s = { ...DEFAULT_SETTINGS, ...(u.settings || {}) };
    if (['sdk', 'ytm'].includes(body.spotifyPlayback)) s.spotifyPlayback = body.spotifyPlayback;
    if (['ytm', 'preview'].includes(body.deezerPlayback)) s.deezerPlayback = body.deezerPlayback;
    u.settings = s;
    store.putUser(u);
    return { user: publicUser(u) };
  });

  // administration des comptes du foyer
  r.get('/api/users', (req) => {
    requireAdmin(req);
    return { users: Object.values(store.data.users).map((u) => ({ id: u.id, username: u.username, isAdmin: Boolean(u.isAdmin), createdAt: u.createdAt })) };
  });
  r.post('/api/users', async (req) => {
    requireAdmin(req);
    const body = await readJson(req);
    const u = createUser(validCredentials(body), Boolean(body.isAdmin));
    return { user: { id: u.id, username: u.username, isAdmin: u.isAdmin } };
  });
  r.delete('/api/users/:id', (req, res, { id }) => {
    const me = requireAdmin(req);
    if (id === me.id) throw new HttpError(400, 'Tu ne peux pas supprimer ton propre compte.');
    if (!store.user(id)) throw new HttpError(404, 'Utilisateur introuvable');
    store.deleteUser(id);
    return { ok: true };
  });

  // ---- Spotify
  r.get('/api/spotify/login', (req, res) => {
    const u = currentUser(req);
    if (!u) return redirect(res, '/');
    try {
      return redirect(res, spotify.authorizeUrl(u));
    } catch (e) {
      return redirect(res, `/#/settings?error=${encodeURIComponent(e.message)}`);
    }
  });
  r.get('/api/spotify/callback', async (req, res, _p, url) => {
    try {
      await spotify.handleCallback(Object.fromEntries(url.searchParams));
      return redirect(res, '/#/settings?linked=spotify');
    } catch (e) {
      return redirect(res, `/#/settings?error=${encodeURIComponent(e.message)}`);
    }
  });
  r.post('/api/spotify/unlink', (req) => { const u = requireUser(req); spotify.unlink(u); return { user: publicUser(u) }; });
  r.get('/api/spotify/token', async (req) => {
    const u = requireUser(req);
    const t = await spotify.accessToken(u);
    return { accessToken: t.token, expiresAt: t.expiresAt };
  });
  r.get('/api/spotify/devices', async (req) => ({ devices: await spotify.devices(requireUser(req)) }));
  r.get('/api/spotify/state', async (req) => ({ state: await spotify.state(requireUser(req)) }));
  for (const action of ['play', 'resume', 'pause', 'seek', 'volume', 'transfer']) {
    r.put(`/api/spotify/${action}`, async (req) => {
      const u = requireUser(req);
      const body = await readJson(req);
      await spotify[action](u, body);
      return { ok: true };
    });
  }

  // ---- Deezer
  r.post('/api/deezer/link', async (req) => {
    const u = requireUser(req);
    await deezer.link(u, (await readJson(req)).profile);
    return { user: publicUser(u) };
  });
  r.post('/api/deezer/unlink', (req) => { const u = requireUser(req); deezer.unlink(u); return { user: publicUser(u) }; });

  // ---- YouTube Music
  r.post('/api/ytm/link', async (req) => {
    const u = requireUser(req);
    await ytm.link(u, (await readJson(req)).cookie);
    return { user: publicUser(u) };
  });
  r.post('/api/ytm/unlink', (req) => { const u = requireUser(req); ytm.unlink(u); return { user: publicUser(u) }; });
  r.post('/api/ytm/saved', async (req) => {
    const u = requireUser(req);
    const saved = await ytm.savePlaylist(u, (await readJson(req)).url);
    return { saved, user: publicUser(u) };
  });
  r.delete('/api/ytm/saved/:id', (req, res, { id }) => { const u = requireUser(req); ytm.removeSaved(u, id); return { user: publicUser(u) }; });
  r.get('/api/ytm/stream/:id', async (req, res, { id }) => {
    requireUser(req);
    await ytdlp.stream(req, res, id);
    return undefined; // réponse déjà envoyée
  });

  // ---- recherche, bibliothèque, lecture
  r.get('/api/search', async (req, res, _p, url) => {
    const u = requireUser(req);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    if (!q) return { results: {} };
    const wanted = (url.searchParams.get('sources') || SOURCES.join(',')).split(',').filter((s) => SOURCES.includes(s));
    const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
    const jobs = {
      spotify: () => spotify.search(u, q, offset),
      deezer: () => deezer.search(q, offset),
      ytm: () => ytm.search(u, q),
    };
    const settled = await Promise.allSettled(wanted.map((s) => jobs[s]()));
    const results = {};
    wanted.forEach((s, i) => {
      const x = settled[i];
      results[s] = x.status === 'fulfilled' ? x.value : { tracks: [], error: x.reason.message, code: x.reason.extra?.code };
    });
    return { q, results };
  });

  r.get('/api/library', async (req) => {
    const u = requireUser(req);
    const out = { local: store.playlistsOf(u.id).map(localSummary), sources: {} };
    const settled = await Promise.allSettled(SOURCES.map((s) => providers[s].collections(u)));
    SOURCES.forEach((s, i) => {
      const x = settled[i];
      out.sources[s] = x.status === 'fulfilled'
        ? { items: x.value }
        : { items: [], error: x.reason.message, code: x.reason.extra?.code };
    });
    return out;
  });

  r.get('/api/collection/:source/:id', async (req, res, { source, id }) => {
    const u = requireUser(req);
    if (!SOURCES.includes(source)) throw new HttpError(404, 'Source inconnue');
    return { collection: await providers[source].collection(u, id) };
  });

  r.post('/api/resolve', async (req) => {
    const u = requireUser(req);
    const body = await readJson(req);
    const track = sanitizeTrack(body.track);
    if (!track) throw new HttpError(400, 'Titre invalide');
    return { plan: await playbackPlan(u, track, body.prefer) };
  });

  r.post('/api/match/forget', async (req) => {
    requireUser(req);
    const key = String((await readJson(req)).key || '');
    matcher.forget(key);
    return { ok: true };
  });

  // ---- playlists Spotihome
  function localSummary(p) {
    return { source: 'local', id: p.id, kind: 'playlist', name: p.name, count: p.tracks.length, image: p.tracks.find((t) => t.artwork)?.artwork || '', updatedAt: p.updatedAt };
  }
  function ownPlaylist(u, id) {
    const p = store.playlist(id);
    if (!p || p.ownerId !== u.id) throw new HttpError(404, 'Playlist introuvable');
    return p;
  }
  const cleanName = (n) => {
    const name = String(n || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Donne un nom à la playlist.');
    return name;
  };
  const cleanTracks = (list) => (Array.isArray(list) ? list : []).map(sanitizeTrack).filter(Boolean);

  r.get('/api/playlists', (req) => ({ playlists: store.playlistsOf(requireUser(req).id).map(localSummary) }));
  r.post('/api/playlists', async (req) => {
    const u = requireUser(req);
    const body = await readJson(req, 5_000_000);
    const p = store.putPlaylist({ id: randomId(10), ownerId: u.id, name: cleanName(body.name), tracks: cleanTracks(body.tracks).slice(0, 5000), createdAt: Date.now() });
    return { playlist: p };
  });
  r.get('/api/playlists/:id', (req, res, { id }) => ({ playlist: ownPlaylist(requireUser(req), id) }));
  r.patch('/api/playlists/:id', async (req, res, { id }) => {
    const p = ownPlaylist(requireUser(req), id);
    const body = await readJson(req, 5_000_000);
    if (body.name !== undefined) p.name = cleanName(body.name);
    if (body.tracks !== undefined) p.tracks = cleanTracks(body.tracks).slice(0, 5000);
    return { playlist: store.putPlaylist(p) };
  });
  r.post('/api/playlists/:id/tracks', async (req, res, { id }) => {
    const p = ownPlaylist(requireUser(req), id);
    const add = cleanTracks((await readJson(req, 5_000_000)).tracks);
    const have = new Set(p.tracks.map((t) => t.key));
    const fresh = add.filter((t) => !have.has(t.key));
    p.tracks = [...p.tracks, ...fresh].slice(0, 5000);
    store.putPlaylist(p);
    return { added: fresh.length, playlist: p };
  });
  r.delete('/api/playlists/:id', (req, res, { id }) => {
    ownPlaylist(requireUser(req), id);
    store.deletePlaylist(id);
    return { ok: true };
  });
  r.post('/api/import', async (req) => {
    const u = requireUser(req);
    const { source, id, name } = await readJson(req);
    if (!SOURCES.includes(source)) throw new HttpError(400, 'Source inconnue');
    const col = await providers[source].collection(u, String(id));
    const p = store.putPlaylist({ id: randomId(10), ownerId: u.id, name: cleanName(name || col.name), tracks: col.tracks.slice(0, 5000), createdAt: Date.now(), importedFrom: { source, id: col.id } });
    return { playlist: localSummary(p) };
  });

  // ---- fichiers statiques
  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
      const ext = path.extname(file);
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': st.size,
        'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin',
      });
      if (req.method === 'HEAD') { res.end(); return; }
      fs.createReadStream(file).pipe(res);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
      serveStatic(req, res, url.pathname);
      return;
    }
    try {
      // protection CSRF : toute écriture doit venir de notre propre front (en-tête personnalisé)
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-spotihome'] !== '1') {
        throw new HttpError(403, 'Requête refusée (en-tête manquant)');
      }
      const m = r.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Route inconnue');
      if (m.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée');
      const out = await m.handler(req, res, m.params, url);
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500 && !(e instanceof HttpError)) console.error('[spotihome]', e);
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Erreur interne', ...(e.extra || {}) });
    }
  }

  return { handle, store, providers, matcher, ytdlp };
}
