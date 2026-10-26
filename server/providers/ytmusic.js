// YouTube Music : API interne « InnerTube » (client WEB_REMIX), sans clé.
// Recherche et playlists publiques fonctionnent sans compte. Pour la bibliothèque
// personnelle (playlists, titres « J'aime »), l'utilisateur colle l'en-tête Cookie de
// music.youtube.com ; on signe alors les requêtes avec SAPISIDHASH comme le site.
// La lecture audio passe par yt-dlp (voir ytdlp.js).
import crypto from 'node:crypto';
import { HttpError } from '../http.js';
import { makeTrack, parseDuration } from '../track.js';

const ORIGIN = 'https://music.youtube.com';
const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

// ---------- utilitaires de parcours des réponses InnerTube ----------
export function collect(node, key, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const n of node) collect(n, key, out); return out; }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    else if (v && typeof v === 'object') collect(v, key, out);
  }
  return out;
}

const first = (node, key) => collect(node, key)[0];
const runsText = (runs) => (runs || []).map((r) => r.text).join('');

export function bestThumb(thumbs, size = 300) {
  if (!Array.isArray(thumbs) || !thumbs.length) return '';
  const t = [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  let url = t?.url || '';
  // les vignettes lh3/yt3 acceptent un suffixe de taille
  if (/googleusercontent\.com|ggpht\.com/.test(url)) url = url.replace(/=w\d+-h\d+.*$/, `=w${size}-h${size}-l90-rj`);
  if (url.startsWith('//')) url = `https:${url}`;
  return url;
}

const pageType = (run) => run?.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
  ?.browseEndpointContextMusicConfig?.pageType || '';

const TYPE_LABELS = new Set(['Titre', 'Song', 'Vidéo', 'Video', 'Épisode', 'Episode', 'Chanson']);

export function parseListItem(r) {
  if (!r) return null;
  const videoId = r.playlistItemData?.videoId || first(r.flexColumns, 'watchEndpoint')?.videoId
    || first(r.overlay, 'watchEndpoint')?.videoId;
  if (!videoId) return null;
  const cols = (r.flexColumns || []).map((c) => c.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []);
  const fixed = (r.fixedColumns || []).map((c) => c.musicResponsiveListItemFixedColumnRenderer?.text?.runs || []);
  const title = runsText(cols[0]);
  const rest = cols.slice(1).flat();
  let artists = rest.filter((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ARTIST' || pageType(x) === 'MUSIC_PAGE_TYPE_USER_CHANNEL').map((x) => x.text);
  const album = rest.find((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
  let duration = 0;
  for (const x of [...rest, ...fixed.flat()]) { const d = parseDuration(x.text); if (d) { duration = d; break; } }
  if (!artists.length) {
    const candidates = (cols[1] || []).map((x) => x.text).filter((t) => t && t.trim() !== '•' && t.trim() !== '&' && t.trim() !== ',' && !TYPE_LABELS.has(t) && !parseDuration(t));
    if (candidates[0]) artists = [candidates[0].trim()];
  }
  const thumbs = r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const explicit = collect(r.badges, 'musicInlineBadgeRenderer').some((b) => b?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE');
  return makeTrack({
    source: 'ytm',
    sourceId: videoId,
    title,
    artists: [...new Set(artists)],
    album,
    duration,
    artwork: bestThumb(thumbs),
    uri: `${ORIGIN}/watch?v=${videoId}`,
    explicit,
  });
}

export function parseTracks(json) {
  const seen = new Set();
  const out = [];
  for (const r of collect(json, 'musicResponsiveListItemRenderer')) {
    const t = parseListItem(r);
    if (t && !seen.has(t.sourceId)) { seen.add(t.sourceId); out.push(t); }
  }
  return out;
}

export function parsePlaylistHeader(json) {
  for (const k of ['musicResponsiveHeaderRenderer', 'musicDetailHeaderRenderer', 'musicEditablePlaylistDetailHeaderRenderer', 'musicImmersiveHeaderRenderer']) {
    const h = first(json, k);
    if (!h) continue;
    const title = runsText(h.title?.runs) || runsText(first(h, 'title')?.runs);
    const thumbs = first(h, 'thumbnails');
    const owner = runsText(h.straplineTextOne?.runs) || runsText(h.subtitle?.runs);
    if (title) return { name: title, image: bestThumb(thumbs, 400), owner };
  }
  return { name: 'Playlist YouTube Music', image: '', owner: '' };
}

export function parseLibraryPlaylists(json) {
  const out = [];
  const seen = new Set();
  for (const r of collect(json, 'musicTwoRowItemRenderer')) {
    const browseId = r.navigationEndpoint?.browseEndpoint?.browseId || '';
    if (!browseId.startsWith('VL')) continue;
    const id = browseId.slice(2);
    if (seen.has(id) || id === 'LM') continue;
    seen.add(id);
    out.push({
      source: 'ytm',
      id,
      kind: 'playlist',
      name: runsText(r.title?.runs),
      image: bestThumb(r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails),
      count: null,
      owner: runsText(r.subtitle?.runs),
    });
  }
  return out;
}

// File « radio » (endpoint next) : titres similaires à partir d'un titre de départ
export function parseRadio(json) {
  const out = [];
  const seen = new Set();
  for (const r of collect(json, 'playlistPanelVideoRenderer')) {
    const videoId = r?.videoId;
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    const by = r.longBylineText?.runs || [];
    let artists = by.filter((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ARTIST' || pageType(x) === 'MUSIC_PAGE_TYPE_USER_CHANNEL').map((x) => x.text);
    if (!artists.length) {
      const s = runsText(r.shortBylineText?.runs) || (by[0]?.text || '');
      if (s) artists = [s];
    }
    const album = by.find((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
    const explicit = collect(r.badges, 'musicInlineBadgeRenderer').some((b) => b?.icon?.iconType === 'MUSIC_EXPLICIT_BADGE');
    out.push(makeTrack({
      source: 'ytm',
      sourceId: videoId,
      title: runsText(r.title?.runs),
      artists: [...new Set(artists)],
      album,
      duration: parseDuration(runsText(r.lengthText?.runs)),
      artwork: bestThumb(r.thumbnail?.thumbnails),
      uri: `${ORIGIN}/watch?v=${videoId}`,
      explicit,
    }));
  }
  return out;
}

export function continuationToken(json) {
  return first(json, 'continuationCommand')?.token || first(json, 'nextContinuationData')?.continuation || null;
}

// « PLxxx », « VLPLxxx », ou URL music.youtube.com / youtube.com contenant list=
export function parseYtmPlaylist(input) {
  const s = String(input || '').trim();
  const m = s.match(/[?&]list=([A-Za-z0-9_-]{10,})/);
  let id = m ? m[1] : s;
  if (id.startsWith('VL')) id = id.slice(2);
  return /^[A-Za-z0-9_-]{2,}$/.test(id) ? id : null;
}

export function sapisidHash(cookie, origin = ORIGIN, now = Date.now()) {
  const m = String(cookie).match(/(?:^|;\s*)(?:__Secure-3PAPISID|SAPISID)=([^;]+)/);
  if (!m) return null;
  const ts = Math.floor(now / 1000);
  const hash = crypto.createHash('sha1').update(`${ts} ${m[1]} ${origin}`).digest('hex');
  return `SAPISIDHASH ${ts}_${hash}`;
}

export class YtMusicProvider {
  constructor({ config, store, cipher, fetchImpl = fetch }) {
    this.store = store;
    this.cipher = cipher;
    this.fetch = fetchImpl;
    this.hl = config.lang || 'fr';
    this.gl = config.market || 'FR';
    this.clientVersion = process.env.YTM_CLIENT_VERSION || '1.20251020.01.00';
  }

  linked(user) { return Boolean(user.ytm?.cookie); }
  status(user) {
    return { configured: true, linked: this.linked(user), displayName: user.ytm?.name || '', savedPlaylists: user.ytm?.saved || [] };
  }

  async _call(endpoint, body, user) {
    const headers = {
      'content-type': 'application/json',
      origin: ORIGIN,
      'x-origin': ORIGIN,
      referer: `${ORIGIN}/`,
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'x-youtube-client-name': '67',
      'x-youtube-client-version': this.clientVersion,
    };
    const cookie = user && this.linked(user) ? this.cipher.decrypt(user.ytm.cookie) : null;
    if (cookie) {
      headers.cookie = cookie;
      const auth = sapisidHash(cookie);
      if (auth) { headers.authorization = auth; headers['x-goog-authuser'] = '0'; }
    }
    const r = await this.fetch(`${ORIGIN}/youtubei/v1/${endpoint}?prettyPrint=false`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        context: { client: { clientName: 'WEB_REMIX', clientVersion: this.clientVersion, hl: this.hl, gl: this.gl } },
        ...body,
      }),
    });
    if (r.status === 401 || r.status === 403) {
      throw new HttpError(409, 'YouTube Music a refusé les cookies enregistrés. Collez-les à nouveau dans les paramètres.', { provider: 'ytm', code: 'not_linked' });
    }
    if (r.status === 404) throw new HttpError(404, 'YouTube Music : élément introuvable', { provider: 'ytm' });
    if (!r.ok) throw new HttpError(502, `YouTube Music : HTTP ${r.status}`, { provider: 'ytm' });
    return r.json();
  }

  async link(user, cookie) {
    const c = String(cookie || '').replace(/^cookie:\s*/i, '').trim();
    if (!sapisidHash(c)) throw new HttpError(400, 'Cookie incomplet : il doit contenir SAPISID. Copiez l’intégralité de l’en-tête Cookie d’une requête vers music.youtube.com.');
    user.ytm = { ...(user.ytm || {}), cookie: this.cipher.encrypt(c) };
    let name = 'Compte YouTube Music';
    try {
      const acc = await this._call('account/account_menu', {}, user);
      const n = runsText(first(acc, 'accountName')?.runs);
      if (n) name = n;
    } catch (e) {
      delete user.ytm.cookie;
      throw e;
    }
    user.ytm.name = name;
    this.store.putUser(user);
    return { name };
  }

  unlink(user) {
    if (user.ytm) { delete user.ytm.cookie; delete user.ytm.name; }
    this.store.putUser(user);
  }

  async search(user, q) {
    const json = await this._call('search', { query: q, params: SONGS_FILTER }, user);
    return { tracks: parseTracks(json).slice(0, 25), hasMore: false };
  }

  // utilisé pour faire correspondre un titre Spotify/Deezer : sans cookies, résultats neutres
  async searchSongs(q) {
    return parseTracks(await this._call('search', { query: q, params: SONGS_FILTER }, null));
  }

  async collections(user) {
    const saved = (user.ytm?.saved || []).map((p) => ({ ...p, source: 'ytm', kind: 'playlist', saved: true }));
    if (!this.linked(user)) {
      if (!saved.length) throw new HttpError(409, 'YouTube Music non lié', { provider: 'ytm', code: 'not_linked' });
      return saved;
    }
    const json = await this._call('browse', { browseId: 'FEmusic_liked_playlists' }, user);
    const lists = parseLibraryPlaylists(json);
    const ids = new Set(lists.map((l) => l.id));
    return [
      { source: 'ytm', id: 'LM', kind: 'liked', name: 'Titres « J’aime »', image: '', count: null },
      ...lists,
      ...saved.filter((s) => !ids.has(s.id)),
    ];
  }

  async collection(user, id, maxPages = 25) {
    const pid = parseYtmPlaylist(id);
    if (!pid) throw new HttpError(400, 'Identifiant de playlist YouTube Music invalide');
    if (pid === 'LM' && !this.linked(user)) throw new HttpError(409, 'YouTube Music non lié', { provider: 'ytm', code: 'not_linked' });
    const json = await this._call('browse', { browseId: `VL${pid}` }, user);
    const header = parsePlaylistHeader(json);
    const tracks = parseTracks(json);
    const seen = new Set(tracks.map((t) => t.sourceId));
    let token = continuationToken(json);
    for (let i = 0; token && i < maxPages; i++) {
      const more = await this._call('browse', { continuation: token }, user);
      const before = tracks.length;
      for (const t of parseTracks(more)) if (!seen.has(t.sourceId)) { seen.add(t.sourceId); tracks.push(t); }
      const next = continuationToken(more);
      if (next === token || tracks.length === before) break;
      token = next;
    }
    return { source: 'ytm', id: pid, name: pid === 'LM' ? 'Titres « J’aime » (YouTube Music)' : header.name, image: header.image, owner: header.owner, tracks };
  }

  // radio YouTube Music (mix automatique) à partir d'un titre
  async radio(videoId) {
    const json = await this._call('next', {
      videoId,
      playlistId: `RDAMVM${videoId}`,
      isAudioOnly: true,
      enablePersistentPlaylistPanel: true,
      tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
    }, null);
    return parseRadio(json).filter((t) => t.sourceId !== videoId);
  }

  // playlists publiques ajoutées par lien, sans compte
  async savePlaylist(user, input) {
    const pid = parseYtmPlaylist(input);
    if (!pid) throw new HttpError(400, 'Lien de playlist YouTube Music invalide');
    const col = await this.collection(user, pid, 0);
    user.ytm = user.ytm || {};
    user.ytm.saved = (user.ytm.saved || []).filter((p) => p.id !== pid);
    user.ytm.saved.unshift({ id: pid, name: col.name, image: col.image, count: null, owner: col.owner });
    this.store.putUser(user);
    return user.ytm.saved[0];
  }

  removeSaved(user, pid) {
    if (user.ytm?.saved) user.ytm.saved = user.ytm.saved.filter((p) => p.id !== pid);
    this.store.putUser(user);
  }
}
