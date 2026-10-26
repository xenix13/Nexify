// Assemblage de l'application : routes API, sessions, synchronisation, fichiers statiques.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
import { relay, IMAGE_HOSTS, AUDIO_HOSTS } from './proxy.js';
import { mergeUserData } from '../public/js/merge.js';

const SESSION_COOKIE = 'nx_sid';
const SESSION_DAYS = 365; // l'appli doit rester utilisable longtemps sans repasser par la connexion
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2', '.webp': 'image/webp',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://sdk.scdn.co",
  'frame-src https://sdk.scdn.co',
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https: wss:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

// Par défaut, tout passe par le moteur audio de Nexify (égaliseur, fondu, téléchargement).
const DEFAULT_SETTINGS = { spotifyPlayback: 'ytm', deezerPlayback: 'ytm' };
const PLAYLIST_ID = /^[A-Za-z0-9_-]{6,40}$/;

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
    if (!s) return null;
    // session glissante : prolongée à chaque usage
    if (s.expiresAt - Date.now() < (SESSION_DAYS - 7) * 86_400_000) {
      s.expiresAt = Date.now() + SESSION_DAYS * 86_400_000;
      store.save();
    }
    return store.user(s.userId);
  }

  const requireUser = (req) => {
    const u = currentUser(req);
    if (!u) throw new HttpError(401, 'Votre session a expiré. Reconnectez-vous.');
    return u;
  };
  const requireAdmin = (req) => {
    const u = requireUser(req);
    if (!u.isAdmin) throw new HttpError(403, 'Action réservée à l’administrateur.');
    return u;
  };

  function validCredentials(body) {
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!/^[\p{L}\p{N}._-]{2,32}$/u.test(username)) throw new HttpError(400, 'Le nom d’utilisateur doit contenir de 2 à 32 caractères (lettres, chiffres, . _ -).');
    if (password.length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères.');
    return { username, password };
  }

  function createUser({ username, password }, isAdmin) {
    if (store.userByName(username)) throw new HttpError(409, 'Ce nom d’utilisateur est déjà pris.');
    return store.putUser({ id: randomId(12), username, password: hashPassword(password), isAdmin, createdAt: Date.now(), settings: { ...DEFAULT_SETTINGS } });
  }

  const signupOpen = () => config.allowSignup === 'yes' || (config.allowSignup !== 'no' && store.userCount() === 0);
  const previewUrl = (u) => `/api/preview?u=${encodeURIComponent(u)}`;

  // ---- comment lire un titre donné, selon les réglages et les comptes liés
  // download : on veut un fichier complet, lisible par le moteur audio de l'appli
  async function playbackPlan(user, track, { prefer, download = false } = {}) {
    const settings = { ...DEFAULT_SETTINGS, ...(user.settings || {}) };
    if (track.source === 'ytm') {
      if (!VIDEO_ID.test(track.sourceId)) throw new HttpError(400, 'Identifiant YouTube invalide');
      return { mode: 'audio', url: `/api/ytm/stream/${track.sourceId}` };
    }
    if (!download && track.source === 'spotify' && prefer !== 'ytm' && settings.spotifyPlayback === 'sdk' && spotify.linked(user)) {
      return { mode: 'spotify', uri: track.uri || `spotify:track:${track.sourceId}` };
    }
    if (!download && track.source === 'deezer' && settings.deezerPlayback === 'preview' && track.previewUrl && prefer !== 'ytm') {
      return { mode: 'audio', url: previewUrl(track.previewUrl), preview: true };
    }
    let match = null;
    try {
      match = await matcher.find(track);
    } catch (e) {
      if (!track.previewUrl || download) throw e;
    }
    if (match) return { mode: 'audio', url: `/api/ytm/stream/${match.videoId}`, via: { source: 'ytm', videoId: match.videoId, title: match.title, artists: match.artists } };
    if (download) throw new HttpError(404, 'Aucune version complète n’est disponible pour ce titre.');
    if (track.previewUrl) return { mode: 'audio', url: previewUrl(track.previewUrl), preview: true };
    throw new HttpError(404, 'Ce titre n’est pas disponible pour le moment.');
  }

  // ---- nettoyage des données synchronisées reçues d'un appareil
  const clampTime = (v) => Math.min(Math.max(0, Number(v) || 0), Date.now() + 60_000);
  const cleanName = (n) => {
    const name = String(n || '').trim().slice(0, 120);
    if (!name) throw new HttpError(400, 'Donnez un nom à la playlist.');
    return name;
  };
  const cleanTracks = (list) => (Array.isArray(list) ? list : []).slice(0, 5000).map(sanitizeTrack).filter(Boolean);

  function cleanUserData(body) {
    const out = { playlists: {}, likes: {} };
    const pls = Object.values(body?.playlists || {}).slice(0, 2000);
    for (const p of pls) {
      if (!p || !PLAYLIST_ID.test(String(p.id))) continue;
      const updatedAt = clampTime(p.updatedAt);
      if (p.deleted) { out.playlists[p.id] = { id: p.id, deleted: true, updatedAt }; continue; }
      let name;
      try { name = cleanName(p.name); } catch { continue; }
      out.playlists[p.id] = {
        id: p.id,
        name,
        description: String(p.description || '').slice(0, 500),
        tracks: cleanTracks(p.tracks),
        createdAt: clampTime(p.createdAt) || updatedAt,
        updatedAt,
        ...(p.importedFrom && SOURCES.includes(p.importedFrom.source) ? { importedFrom: { source: p.importedFrom.source, id: String(p.importedFrom.id).slice(0, 100) } } : {}),
      };
    }
    const likes = Object.values(body?.likes || {}).slice(0, 20000);
    for (const l of likes) {
      if (!l || typeof l.key !== 'string') continue;
      const updatedAt = clampTime(l.updatedAt);
      if (l.removed) { out.likes[l.key] = { key: l.key.slice(0, 200), removed: true, updatedAt }; continue; }
      const track = sanitizeTrack(l.track);
      if (!track || track.key !== l.key) continue;
      out.likes[track.key] = { key: track.key, track, at: clampTime(l.at) || updatedAt, updatedAt };
    }
    return out;
  }

  // ---- routes
  const r = new Router();

  r.get('/api/health', () => ({ ok: true, version: VERSION }));

  r.get('/api/me', (req) => {
    const u = currentUser(req);
    return {
      user: u ? publicUser(u) : null,
      signupOpen: signupOpen(),
      firstRun: store.userCount() === 0,
      spotifyConfigured: spotify.configured,
      version: VERSION,
    };
  });

  r.post('/api/auth/signup', async (req, res) => {
    if (!signupOpen()) throw new HttpError(403, 'Les inscriptions sont fermées. Demandez un compte à l’administrateur.');
    const creds = validCredentials(await readJson(req));
    const user = createUser(creds, store.userCount() === 0);
    startSession(res, user);
    return { user: publicUser(user) };
  });

  r.post('/api/auth/login', async (req, res) => {
    const ip = req.socket.remoteAddress || '';
    const a = loginAttempts.get(ip) || { n: 0, until: 0 };
    if (a.until > Date.now()) throw new HttpError(429, 'Trop de tentatives. Réessayez dans une minute.');
    const body = await readJson(req);
    const user = store.userByName(String(body.username || '').trim());
    if (!user || !verifyPassword(String(body.password || ''), user.password)) {
      a.n += 1;
      if (a.n >= 5) { a.n = 0; a.until = Date.now() + 60_000; }
      loginAttempts.set(ip, a);
      throw new HttpError(401, 'Nom d’utilisateur ou mot de passe incorrect.');
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
    if (!verifyPassword(String(body.current || ''), u.password)) throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
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

  // ---- synchronisation des données de l'appli (playlists, titres « J'aime »)
  r.get('/api/sync', (req) => ({ data: store.userData(requireUser(req).id), at: Date.now() }));
  r.post('/api/sync', async (req) => {
    const u = requireUser(req);
    const incoming = cleanUserData(await readJson(req, 30_000_000));
    const merged = mergeUserData(store.userData(u.id), incoming);
    store.putUserData(u.id, merged);
    return { data: merged, at: Date.now() };
  });

  // administration des comptes
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
    if (id === me.id) throw new HttpError(400, 'Vous ne pouvez pas supprimer votre propre compte.');
    if (!store.user(id)) throw new HttpError(404, 'Utilisateur introuvable.');
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

  // ---- relais de pochettes et d'extraits (même origine : cache hors ligne et Web Audio)
  r.get('/api/img', async (req, res, _p, url) => {
    requireUser(req);
    await relay(req, res, url.searchParams.get('u'), { hosts: IMAGE_HOSTS, kind: 'image', fetchImpl, maxAge: 7 * 86400 });
    return undefined;
  });
  r.get('/api/preview', async (req, res, _p, url) => {
    requireUser(req);
    await relay(req, res, url.searchParams.get('u'), { hosts: AUDIO_HOSTS, kind: 'audio', fetchImpl, maxAge: 3600 });
    return undefined;
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
    const out = { sources: {}, at: Date.now() };
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
    return { plan: await playbackPlan(u, track, { prefer: body.prefer, download: Boolean(body.download) }) };
  });

  // accueil YouTube Music (étagères et filtres d'ambiance), gardé 10 min par utilisateur
  const homeCache = new Map();
  r.get('/api/home', async (req, res, _p, url) => {
    const u = requireUser(req);
    const params = (url.searchParams.get('params') || '').slice(0, 500);
    const key = `${u.id}:${params}`;
    const hit = homeCache.get(key);
    if (hit && hit.at > Date.now() - 10 * 60_000 && url.searchParams.get('refresh') !== '1') return hit.data;
    const data = { ...(await ytm.home(u, params)), params, personalized: ytm.linked(u), at: Date.now() };
    homeCache.set(key, { at: Date.now(), data });
    if (homeCache.size > 200) homeCache.delete(homeCache.keys().next().value);
    return data;
  });

  // titres similaires (radio YouTube Music) à partir de n'importe quel titre
  r.post('/api/radio', async (req) => {
    requireUser(req);
    const track = sanitizeTrack((await readJson(req)).track);
    if (!track) throw new HttpError(400, 'Titre invalide');
    let videoId = track.source === 'ytm' ? track.sourceId : (await matcher.find(track))?.videoId;
    if (!videoId || !VIDEO_ID.test(videoId)) throw new HttpError(404, 'Aucune suggestion disponible pour ce titre.');
    return { tracks: (await ytm.radio(videoId)).slice(0, 50) };
  });

  r.post('/api/match/forget', async (req) => {
    requireUser(req);
    const key = String((await readJson(req)).key || '');
    matcher.forget(key);
    return { ok: true };
  });

  // ---- fichiers statiques
  // Le service worker reçoit la liste des fichiers à garder hors ligne et une empreinte
  // de leur contenu : toute modification du dossier public déclenche une mise à jour de l'appli.
  let swCache = { at: 0, body: '' };
  function listAssets(dir = PUBLIC_DIR) {
    const out = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...listAssets(full));
      else if (e.name !== 'sw.js' && !e.name.startsWith('.') && !full.includes(`${path.sep}fonts${path.sep}`)) out.push(full);
    }
    return out;
  }
  function serviceWorker() {
    if (Date.now() - swCache.at < 2000) return swCache.body;
    const files = listAssets().sort();
    const hash = crypto.createHash('sha256');
    for (const f of files) hash.update(f).update(fs.readFileSync(f));
    const assets = ['/', ...files.map((f) => `/${path.relative(PUBLIC_DIR, f).split(path.sep).join('/')}`).filter((p) => p !== '/index.html')];
    const body = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8')
      .replace('__BUILD__', `${VERSION}-${hash.digest('hex').slice(0, 10)}`)
      .replace('__ASSETS__', JSON.stringify(assets));
    swCache = { at: Date.now(), body };
    return body;
  }

  const baseHeaders = (type) => ({
    'content-type': type,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });

  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); res.end(); return; }
    if (rel === '/sw.js') {
      const body = serviceWorker();
      res.writeHead(200, { ...baseHeaders(MIME['.js']), 'cache-control': 'no-cache', 'service-worker-allowed': '/' });
      res.end(req.method === 'HEAD' ? undefined : body);
      return;
    }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Introuvable'); return; }
      const ext = path.extname(file);
      const etag = `W/"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
      const headers = {
        ...baseHeaders(MIME[ext] || 'application/octet-stream'),
        etag,
        // le service worker garde l'appli ; le navigateur revalide toujours auprès du serveur
        'cache-control': rel.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache',
      };
      if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
      res.writeHead(200, { ...headers, 'content-length': st.size });
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
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-nexify'] !== '1') {
        throw new HttpError(403, 'Requête refusée (en-tête manquant)');
      }
      const m = r.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Route inconnue');
      if (m.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée');
      const out = await m.handler(req, res, m.params, url);
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500 && !(e instanceof HttpError)) console.error('[nexify]', e);
      if (res.headersSent) { res.destroy(); return; }
      sendJson(res, status, { error: e instanceof HttpError ? e.message : 'Erreur interne du serveur.', ...(e.extra || {}) });
    }
  }

  return { handle, store, providers, matcher, ytdlp };
}
