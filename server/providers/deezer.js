// Deezer : API publique (sans clé). Deezer n'accepte plus de nouvelles applications OAuth,
// on « relie » donc un compte par son identifiant de profil public : playlists et coups de cœur
// sont lus tels que Deezer les expose publiquement. La lecture complète passe par une
// correspondance YouTube Music (voir match.js) ; sinon extrait de 30 s.
import { HttpError } from '../http.js';
import { makeTrack } from '../track.js';

const API = 'https://api.deezer.com';

export function mapDeezerTrack(t) {
  if (!t || !t.id || (t.type && t.type !== 'track')) return null;
  return makeTrack({
    source: 'deezer',
    sourceId: t.id,
    title: t.title || t.title_short,
    artists: [t.artist?.name].filter(Boolean),
    album: t.album?.title || '',
    duration: t.duration,
    artwork: t.album?.cover_medium || t.album?.cover_big || '',
    previewUrl: t.preview || '',
    uri: t.link || `https://www.deezer.com/track/${t.id}`,
    explicit: t.explicit_lyrics,
  });
}

// Accepte « 123456 », « https://www.deezer.com/fr/profile/123456 », « deezer.com/user/123456 »
export function parseDeezerProfile(input) {
  const s = String(input || '').trim();
  if (/^\d{1,15}$/.test(s)) return s;
  const m = s.match(/deezer\.com\/(?:[a-z]{2}\/)?(?:profile|user)\/(\d{1,15})/i);
  return m ? m[1] : null;
}

export class DeezerProvider {
  constructor({ store, fetchImpl = fetch }) {
    this.store = store;
    this.fetch = fetchImpl;
  }

  linked(user) { return Boolean(user.deezer?.userId); }
  status(user) { return { configured: true, linked: this.linked(user), displayName: user.deezer?.name || '' }; }

  async api(path, query = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const r = await this.fetch(url);
    if (!r.ok) throw new HttpError(502, `Deezer : HTTP ${r.status}`, { provider: 'deezer' });
    const data = await r.json();
    if (data?.error) {
      const code = data.error.code;
      if (code === 800) throw new HttpError(404, 'Deezer : élément introuvable', { provider: 'deezer' });
      if (code === 4) throw new HttpError(429, 'Deezer limite les requêtes, réessaie dans un instant.', { provider: 'deezer' });
      if (code === 200 || data.error.type === 'OAuthException') {
        throw new HttpError(403, 'Deezer : ce contenu n’est pas public (vérifie la confidentialité de ton profil).', { provider: 'deezer' });
      }
      throw new HttpError(502, `Deezer : ${data.error.message || 'erreur'}`, { provider: 'deezer' });
    }
    return data;
  }

  async _paged(path, max = 1000) {
    const out = [];
    let index = 0;
    while (out.length < max) {
      const data = await this.api(path, { limit: 100, index });
      out.push(...(data.data || []));
      if (!data.next || !(data.data || []).length) break;
      index += (data.data || []).length;
    }
    return out;
  }

  async link(user, input) {
    const id = parseDeezerProfile(input);
    if (!id) throw new HttpError(400, 'Identifiant ou lien de profil Deezer invalide.');
    const profile = await this.api(`/user/${id}`);
    user.deezer = { userId: String(profile.id), name: profile.name || `Profil ${profile.id}` };
    this.store.putUser(user);
    return user.deezer;
  }

  unlink(user) { delete user.deezer; this.store.putUser(user); }

  async search(q, offset = 0) {
    const data = await this.api('/search', { q, limit: 25, index: offset });
    return { tracks: (data.data || []).map(mapDeezerTrack).filter(Boolean), hasMore: Boolean(data.next) };
  }

  async collections(user) {
    if (!this.linked(user)) throw new HttpError(409, 'Compte Deezer non lié', { provider: 'deezer', code: 'not_linked' });
    const uid = user.deezer.userId;
    const lists = await this._paged(`/user/${uid}/playlists`, 500);
    const out = [{ source: 'deezer', id: 'favorites', kind: 'liked', name: 'Coups de cœur', image: '', count: null }];
    for (const p of lists) {
      if (p.is_loved_track) continue; // déjà représenté par « Coups de cœur »
      out.push({ source: 'deezer', id: String(p.id), kind: 'playlist', name: p.title, image: p.picture_medium || '', count: p.nb_tracks ?? null, owner: p.creator?.name || '' });
    }
    return out;
  }

  async collection(user, id) {
    if (id === 'favorites') {
      if (!this.linked(user)) throw new HttpError(409, 'Compte Deezer non lié', { provider: 'deezer', code: 'not_linked' });
      const items = await this._paged(`/user/${user.deezer.userId}/tracks`, 2000);
      return { source: 'deezer', id, name: 'Coups de cœur (Deezer)', image: '', tracks: items.map(mapDeezerTrack).filter(Boolean) };
    }
    if (!/^\d+$/.test(id)) throw new HttpError(400, 'Identifiant de playlist Deezer invalide');
    const meta = await this.api(`/playlist/${id}`);
    const items = await this._paged(`/playlist/${id}/tracks`, 2000);
    return {
      source: 'deezer',
      id,
      name: meta.title,
      image: meta.picture_medium || '',
      owner: meta.creator?.name || '',
      tracks: items.map(mapDeezerTrack).filter(Boolean),
    };
  }
}
