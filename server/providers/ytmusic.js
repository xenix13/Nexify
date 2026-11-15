// YouTube Music : API interne « InnerTube » (client WEB_REMIX), sans clé.
// Recherche et playlists publiques fonctionnent sans compte. Pour la bibliothèque
// personnelle (playlists, titres « J'aime »), l'utilisateur colle l'en-tête Cookie de
// music.youtube.com ; on signe alors les requêtes avec SAPISIDHASH comme le site.
// La lecture audio passe par yt-dlp (voir ytdlp.js).
import crypto from 'node:crypto';
import { HttpError } from '../http.js';
import {
  ORIGIN, SONGS_FILTER, first, runsText, parseTracks, parseLibraryPlaylists, parseYtmPlaylist, ytmBody, YTM_CLIENT_VERSION,
  ytmSearchSongs, ytmCollection, ytmHome, ytmRadio,
} from '../../public/js/shared/ytm.js';

// lecture des réponses : code partagé avec l'appli
export {
  bestThumb, collect, continuationToken, parseHome, parseLibraryPlaylists, parseListItem, parsePlaylistHeader, parseRadio, parseTracks, parseTwoRowItem, parseYtmPlaylist,
} from '../../public/js/shared/ytm.js';

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
    this.clientVersion = process.env.YTM_CLIENT_VERSION || YTM_CLIENT_VERSION;
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
      body: JSON.stringify(ytmBody(body, { hl: this.hl, gl: this.gl, clientVersion: this.clientVersion })),
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

  _caller(user) { return (endpoint, body) => this._call(endpoint, body, user); }

  async search(user, q) {
    return { tracks: (await ytmSearchSongs(this._caller(user), q)).slice(0, 25), hasMore: false };
  }

  // utilisé pour faire correspondre un titre Spotify/Deezer : sans cookies, résultats neutres
  async searchSongs(q) {
    return ytmSearchSongs(this._caller(null), q);
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
    return ytmCollection(this._caller(user), pid, maxPages);
  }

  // accueil YouTube Music (personnalisé si le compte est connecté)
  async home(user, params = '', browseId = 'FEmusic_home') {
    if (!/^FEmusic_\w+$/.test(browseId)) throw new HttpError(400, 'Rubrique inconnue');
    return ytmHome(this._caller(user), params, browseId);
  }

  // radio YouTube Music (mix automatique) à partir d'un titre
  async radio(videoId) {
    return ytmRadio(this._caller(null), videoId);
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
