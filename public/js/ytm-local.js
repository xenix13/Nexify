// Appli Android : YouTube Music directement depuis le téléphone, sans le serveur Nexify.
// Le module natif relaie seulement les requêtes (pas de restriction d'origine) ; la lecture
// des réponses et la logique (accueil, radio, playlists, albums, correspondances
// Spotify/Deezer) sont le même code que celui du serveur (dossier shared/).
import { native } from './native.js';
import { db } from './db.js';
import { ytmBody, YTM_CLIENT_VERSION, ytmSearchSongs, ytmCollection, ytmHome, ytmRadio, parseYtmPlaylist } from './shared/ytm.js';
import { bestMatch } from './shared/match.js';

const enabled = () => native.has('innertube');

async function call(endpoint, body) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30_000);
  try {
    const r = await fetch(native.engineUrl(`/api/innertube/${endpoint}`), {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'x-ytm-client-version': YTM_CLIENT_VERSION },
      body: JSON.stringify(ytmBody(body, { hl: 'fr', gl: 'FR' })),
    });
    if (r.status === 404) throw Object.assign(new Error('YouTube Music : élément introuvable.'), { status: 404 });
    if (!r.ok) throw Object.assign(new Error(`YouTube Music : erreur ${r.status}.`), { status: 502 });
    return await r.json();
  } catch (e) {
    if (e.name === 'AbortError' || e instanceof TypeError) throw Object.assign(new Error('Pas de connexion Internet.'), { status: 0, code: 'offline' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- correspondance d'un titre Spotify / Deezer vers YouTube Music (gardée sur l'appareil)
export async function matchLocal(track) {
  if (track.source === 'ytm') return { videoId: track.sourceId };
  const key = `match:${track.key}`;
  const cached = await db.get('kv', key).catch(() => null);
  if (cached && (cached.videoId || cached.at > Date.now() - 86_400_000)) return cached.videoId ? cached : null;
  const q = `${(track.artists || []).slice(0, 2).join(' ')} ${track.title}`.trim();
  const best = bestMatch(track, (await ytmSearchSongs(call, q)).slice(0, 10));
  const entry = best
    ? { videoId: best.track.sourceId, title: best.track.title, artists: best.track.artists, at: Date.now() }
    : { videoId: null, at: Date.now() };
  await db.put('kv', entry, key).catch(() => {});
  return entry.videoId ? entry : null;
}

// ---------- mêmes réponses que l'API du serveur, pour les fonctions musicales
const handlers = [
  [/^\/api\/search\?/, async (url) => {
    const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
    const wanted = (url.searchParams.get('sources') || 'ytm').split(',');
    if (!wanted.includes('ytm')) return { q, results: {} };
    return { q, results: { ytm: { tracks: q ? (await ytmSearchSongs(call, q)).slice(0, 25) : [], hasMore: false } } };
  }],
  [/^\/api\/home\b/, async (url) => {
    const browseId = url.searchParams.get('browseId') || 'FEmusic_home';
    if (!/^FEmusic_\w+$/.test(browseId)) throw Object.assign(new Error('Rubrique inconnue'), { status: 400 });
    const params = url.searchParams.get('params') || '';
    return { ...(await ytmHome(call, params, browseId)), params, browseId, personalized: false, at: Date.now() };
  }],
  [/^\/api\/radio$/, async (url, body) => {
    const m = await matchLocal(body.track);
    if (!m?.videoId) throw Object.assign(new Error('Aucune suggestion disponible pour ce titre.'), { status: 404 });
    return { tracks: (await ytmRadio(call, m.videoId)).slice(0, 50) };
  }],
  [/^\/api\/collection\/ytm\//, async (url) => {
    const pid = parseYtmPlaylist(decodeURIComponent(url.pathname.split('/').pop()));
    if (!pid || pid === 'LM') throw Object.assign(new Error('Cette playlist nécessite votre compte YouTube Music (serveur).'), { status: 409 });
    return { collection: await ytmCollection(call, pid) };
  }],
  [/^\/api\/resolve$/, async (url, body) => {
    const m = await matchLocal(body.track);
    if (!m?.videoId) throw Object.assign(new Error('Aucune version complète n’est disponible pour ce titre.'), { status: 404 });
    const plan = { mode: 'audio', url: `/api/ytm/stream/${m.videoId}` };
    if (body.track.source !== 'ytm') plan.via = { source: 'ytm', videoId: m.videoId, title: m.title, artists: m.artists };
    return { plan };
  }],
];

// Réponse locale pour `path` (ou null si cette fonction n'est pas disponible sur l'appareil)
export function localHandler(path) {
  if (!enabled()) return null;
  const h = handlers.find(([re]) => re.test(path));
  if (!h) return null;
  return (opts = {}) => h[1](new URL(path, 'http://local'), opts.body || {});
}
