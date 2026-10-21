// Spotify : OAuth (code + PKCE), Web API, et jetons pour le Web Playback SDK du navigateur.
// Rappel (février 2026) : en « mode développement », le propriétaire de l'appli doit être Premium,
// 5 utilisateurs maximum, recherche limitée à 10 résultats par page, contenu des playlists
// lisible seulement pour les playlists possédées ou collaboratives.
import { HttpError } from '../http.js';
import { makeTrack, pickImage } from '../track.js';
import { pkcePair, randomId } from '../crypto.js';

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';

export const SPOTIFY_SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-library-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
].join(' ');

export function mapSpotifyTrack(t) {
  if (!t || !t.id || t.type === 'episode') return null;
  return makeTrack({
    source: 'spotify',
    sourceId: t.id,
    title: t.name,
    artists: (t.artists || []).map((a) => a.name),
    album: t.album?.name || '',
    duration: (t.duration_ms || 0) / 1000,
    artwork: pickImage(t.album?.images),
    previewUrl: t.preview_url || '',
    uri: t.uri || `spotify:track:${t.id}`,
    explicit: t.explicit,
  });
}

export class SpotifyProvider {
  constructor({ config, store, cipher, fetchImpl = fetch }) {
    this.cfg = config.spotify;
    this.market = config.market;
    this.redirectUri = `${config.publicUrl}/api/spotify/callback`;
    this.store = store;
    this.cipher = cipher;
    this.fetch = fetchImpl;
    this.appToken = null; // jeton « client credentials » pour chercher sans compte lié
  }

  get configured() { return Boolean(this.cfg.clientId && this.cfg.clientSecret); }

  linked(user) { return Boolean(user.spotify?.refreshToken); }

  status(user) {
    return {
      configured: this.configured,
      linked: this.linked(user),
      displayName: user.spotify?.displayName || '',
      redirectUri: this.redirectUri,
    };
  }

  authorizeUrl(user) {
    if (!this.configured) throw new HttpError(400, 'Spotify n’est pas configuré sur le serveur (SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET).');
    const state = randomId();
    const { verifier, challenge } = pkcePair();
    this.store.putOAuthState(state, { provider: 'spotify', userId: user.id, verifier });
    const q = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: SPOTIFY_SCOPES,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    return `${ACCOUNTS}/authorize?${q}`;
  }

  async _tokenRequest(params) {
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const r = await this.fetch(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new HttpError(r.status === 400 ? 400 : 502, `Spotify a refusé l’authentification : ${body.error_description || body.error || r.status}`);
    }
    return body;
  }

  async handleCallback({ code, state, error }) {
    const st = state && this.store.takeOAuthState(state);
    if (!st || st.provider !== 'spotify') throw new HttpError(400, 'Lien de connexion Spotify expiré, recommence depuis les réglages.');
    if (error) throw new HttpError(400, `Connexion Spotify annulée (${error}).`);
    const user = this.store.user(st.userId);
    if (!user) throw new HttpError(400, 'Utilisateur introuvable');
    const tok = await this._tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri,
      code_verifier: st.verifier,
    });
    user.spotify = {
      accessToken: this.cipher.encrypt(tok.access_token),
      refreshToken: this.cipher.encrypt(tok.refresh_token),
      expiresAt: Date.now() + (tok.expires_in - 60) * 1000,
      scope: tok.scope,
    };
    const me = await this.api(user, 'GET', '/me').catch(() => null);
    user.spotify.displayName = me?.display_name || me?.id || 'Compte Spotify';
    user.spotify.userId = me?.id || '';
    this.store.putUser(user);
    return user;
  }

  unlink(user) { delete user.spotify; this.store.putUser(user); }

  async accessToken(user) {
    const s = user.spotify;
    if (!s?.refreshToken) throw new HttpError(409, 'Compte Spotify non lié', { provider: 'spotify', code: 'not_linked' });
    if (s.accessToken && s.expiresAt > Date.now()) return { token: this.cipher.decrypt(s.accessToken), expiresAt: s.expiresAt };
    let tok;
    try {
      tok = await this._tokenRequest({ grant_type: 'refresh_token', refresh_token: this.cipher.decrypt(s.refreshToken) });
    } catch (e) {
      if (e.status === 400) { // jeton révoqué : on délie pour que l'utilisateur reconnecte
        this.unlink(user);
        throw new HttpError(409, 'La connexion Spotify a expiré, reconnecte ton compte.', { provider: 'spotify', code: 'not_linked' });
      }
      throw e;
    }
    s.accessToken = this.cipher.encrypt(tok.access_token);
    if (tok.refresh_token) s.refreshToken = this.cipher.encrypt(tok.refresh_token);
    s.expiresAt = Date.now() + (tok.expires_in - 60) * 1000;
    this.store.putUser(user);
    return { token: tok.access_token, expiresAt: s.expiresAt };
  }

  async _appAccessToken() {
    if (this.appToken && this.appToken.expiresAt > Date.now()) return this.appToken.token;
    const tok = await this._tokenRequest({ grant_type: 'client_credentials' });
    this.appToken = { token: tok.access_token, expiresAt: Date.now() + (tok.expires_in - 60) * 1000 };
    return this.appToken.token;
  }

  async api(user, method, path, { query, body, appToken = false } = {}) {
    const url = new URL(API + path);
    if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, v);
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = appToken ? await this._appAccessToken() : (await this.accessToken(user)).token;
      const r = await this.fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 401 && attempt === 0) {
        if (appToken) this.appToken = null; else user.spotify.expiresAt = 0;
        continue;
      }
      if (r.status === 204 || r.status === 202) return null;
      const text = await r.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      if (!r.ok) {
        const msg = data?.error?.message || text || `HTTP ${r.status}`;
        if (r.status === 429) throw new HttpError(429, 'Spotify limite les requêtes, réessaie dans un instant.', { retryAfter: r.headers.get('retry-after') });
        if (r.status === 404 && /device/i.test(msg)) throw new HttpError(404, 'Aucun appareil Spotify actif trouvé.', { provider: 'spotify', code: 'no_device' });
        if (r.status === 403 && path.includes('/playlists/')) {
          throw new HttpError(403, 'Spotify ne donne accès qu’au contenu de tes propres playlists (ou collaboratives) en mode développement.', { provider: 'spotify' });
        }
        if (r.status === 403 && /premium/i.test(msg)) throw new HttpError(403, 'La lecture Spotify demande un compte Premium.', { provider: 'spotify', code: 'premium' });
        throw new HttpError(r.status >= 500 ? 502 : r.status, `Spotify : ${msg}`, { provider: 'spotify' });
      }
      return data;
    }
    throw new HttpError(502, 'Spotify : authentification impossible');
  }

  async search(user, q, offset = 0) {
    const useApp = !this.linked(user);
    if (useApp && !this.configured) throw new HttpError(409, 'Spotify non configuré', { code: 'not_configured' });
    const data = await this.api(user, 'GET', '/search', {
      query: { q, type: 'track', limit: 10, offset, market: this.market },
      appToken: useApp,
    });
    return {
      tracks: (data?.tracks?.items || []).map(mapSpotifyTrack).filter(Boolean),
      hasMore: Boolean(data?.tracks?.next),
    };
  }

  async collections(user) {
    const out = [{ source: 'spotify', id: 'liked', kind: 'liked', name: 'Titres likés', image: '', count: null }];
    let url = '/me/playlists';
    let offset = 0;
    for (let page = 0; page < 4; page++) {
      const data = await this.api(user, 'GET', url, { query: { limit: 50, offset } });
      for (const p of data?.items || []) {
        if (!p) continue;
        const total = p.items?.total ?? p.tracks?.total ?? null;
        out.push({
          source: 'spotify',
          id: p.id,
          kind: 'playlist',
          name: p.name,
          image: pickImage(p.images),
          count: total,
          owner: p.owner?.display_name || '',
          readable: !user.spotify?.userId || p.owner?.id === user.spotify.userId || p.collaborative,
        });
      }
      if (!data?.next) break;
      offset += 50;
    }
    return out;
  }

  async collection(user, id) {
    if (id === 'liked') {
      const tracks = [];
      let offset = 0;
      for (let page = 0; page < 20; page++) {
        const data = await this.api(user, 'GET', '/me/tracks', { query: { limit: 50, offset, market: this.market } });
        for (const it of data?.items || []) { const t = mapSpotifyTrack(it.track || it.item); if (t) tracks.push(t); }
        if (!data?.next) break;
        offset += 50;
      }
      return { source: 'spotify', id, name: 'Titres likés (Spotify)', image: '', tracks };
    }
    const meta = await this.api(user, 'GET', `/playlists/${encodeURIComponent(id)}`, {
      query: { fields: 'id,name,images,owner(display_name),description' },
    });
    const tracks = [];
    let offset = 0;
    for (let page = 0; page < 20; page++) {
      const data = await this.api(user, 'GET', `/playlists/${encodeURIComponent(id)}/items`, { query: { limit: 100, offset, market: this.market } });
      for (const it of data?.items || []) { const t = mapSpotifyTrack(it.item || it.track); if (t) tracks.push(t); }
      if (!data?.next) break;
      offset += 100;
    }
    return { source: 'spotify', id, name: meta?.name || 'Playlist', image: pickImage(meta?.images), owner: meta?.owner?.display_name || '', tracks };
  }

  // --- pilotage de la lecture (Web Playback SDK ou appareils Spotify Connect)
  devices(user) { return this.api(user, 'GET', '/me/player/devices').then((d) => d?.devices || []); }
  state(user) { return this.api(user, 'GET', '/me/player', { query: { market: this.market } }); }
  play(user, { deviceId, uris, positionMs }) {
    return this.api(user, 'PUT', '/me/player/play', {
      query: { device_id: deviceId },
      body: { uris: (uris || []).slice(0, 50), position_ms: Math.max(0, Math.round(positionMs || 0)) },
    });
  }
  resume(user, { deviceId }) { return this.api(user, 'PUT', '/me/player/play', { query: { device_id: deviceId } }); }
  pause(user, { deviceId }) { return this.api(user, 'PUT', '/me/player/pause', { query: { device_id: deviceId } }); }
  seek(user, { deviceId, positionMs }) {
    return this.api(user, 'PUT', '/me/player/seek', { query: { device_id: deviceId, position_ms: Math.round(positionMs || 0) } });
  }
  volume(user, { deviceId, percent }) {
    return this.api(user, 'PUT', '/me/player/volume', { query: { device_id: deviceId, volume_percent: Math.round(percent) } });
  }
  transfer(user, { deviceId, play = false }) {
    return this.api(user, 'PUT', '/me/player', { body: { device_ids: [deviceId], play } });
  }
}
