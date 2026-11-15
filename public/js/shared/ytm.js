// YouTube Music (API InnerTube) : lecture des réponses et logique commune.
// Partagé entre le serveur et l'appli : sur Android, le téléphone fait les mêmes appels
// via son module natif, sans passer par le serveur Nexify.
import { makeTrack, parseDuration } from './track.js';

export const ORIGIN = 'https://music.youtube.com';
export const SONGS_FILTER = 'EgWKAQIIAWoMEA4QChADEAQQCRAF';

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

export const first = (node, key) => collect(node, key)[0];
export const runsText = (runs) => (runs || []).map((r) => r.text).join('');

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

// ---------- accueil (FEmusic_home) : filtres d'ambiance et étagères ----------
const navPageType = (nav) => nav?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType || '';
const COUNT_TEXT = /\b(vues|lectures|views|plays|abonnés|subscribers|titres|songs|tracks)\b/i;

function largestThumb(thumbs) {
  return Array.isArray(thumbs) && thumbs.length ? [...thumbs].sort((a, b) => (b.width || 0) - (a.width || 0))[0] : null;
}

export function parseTwoRowItem(r) {
  if (!r) return null;
  const title = runsText(r.title?.runs);
  const subRuns = r.subtitle?.runs || [];
  const subtitle = runsText(subRuns);
  const thumbs = r.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail?.thumbnails;
  const big = largestThumb(thumbs);
  const wide = Boolean(big?.width && big?.height && big.width / big.height > 1.3);
  const image = bestThumb(thumbs, 544);
  const nav = r.navigationEndpoint || {};
  const base = { title, subtitle, image, wide };
  if (nav.watchEndpoint?.videoId) {
    const videoId = nav.watchEndpoint.videoId;
    let artists = subRuns.filter((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ARTIST' || pageType(x) === 'MUSIC_PAGE_TYPE_USER_CHANNEL').map((x) => x.text);
    if (!artists.length) {
      const c = subRuns.map((x) => x.text.trim()).filter((t) => t && t !== '•' && !TYPE_LABELS.has(t) && !COUNT_TEXT.test(t));
      if (c[0]) artists = [c[0]];
    }
    const album = subRuns.find((x) => pageType(x) === 'MUSIC_PAGE_TYPE_ALBUM')?.text || '';
    return {
      ...base,
      type: 'song',
      track: makeTrack({ source: 'ytm', sourceId: videoId, title, artists: [...new Set(artists)], album, duration: 0, artwork: image, uri: `${ORIGIN}/watch?v=${videoId}` }),
    };
  }
  if (nav.watchPlaylistEndpoint?.playlistId) return { ...base, type: 'playlist', id: nav.watchPlaylistEndpoint.playlistId };
  const bid = nav.browseEndpoint?.browseId || '';
  const pt = navPageType(nav);
  if (!bid) return null;
  if (pt === 'MUSIC_PAGE_TYPE_ALBUM' || bid.startsWith('MPRE')) return { ...base, type: 'album', id: bid };
  if (pt === 'MUSIC_PAGE_TYPE_PLAYLIST' || bid.startsWith('VL')) return { ...base, type: 'playlist', id: bid.replace(/^VL/, '') };
  if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || bid.startsWith('UC')) return { ...base, type: 'artist', id: bid };
  return null;
}

export function parseHome(json) {
  const chips = collect(json, 'chipCloudChipRenderer').map((c) => ({
    title: runsText(c.text?.runs),
    params: c.navigationEndpoint?.browseEndpoint?.params || '',
    browseId: c.navigationEndpoint?.browseEndpoint?.browseId || 'FEmusic_home',
    selected: Boolean(c.isSelected),
  })).filter((c) => c.title && (c.params || c.browseId !== 'FEmusic_home') && /^FEmusic_\w+$/.test(c.browseId));
  const shelves = [];
  for (const sh of collect(json, 'musicCarouselShelfRenderer')) {
    const head = sh.header?.musicCarouselShelfBasicHeaderRenderer || {};
    const title = runsText(head.title?.runs);
    const items = [];
    for (const it of sh.contents || []) {
      if (it.musicResponsiveListItemRenderer) {
        const t = parseListItem(it.musicResponsiveListItemRenderer);
        if (t) items.push({ type: 'song', title: t.title, subtitle: t.artists.join(', '), image: t.artwork, wide: false, track: t, row: true });
      } else if (it.musicTwoRowItemRenderer) {
        const x = parseTwoRowItem(it.musicTwoRowItemRenderer);
        if (x) items.push(x);
      }
    }
    if (!title || !items.length) continue;
    const rows = items.filter((i) => i.row).length;
    shelves.push({
      title,
      strapline: runsText(head.strapline?.runs),
      thumb: bestThumb(head.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails, 88),
      layout: rows > items.length / 2 ? 'list' : items.filter((i) => i.wide).length > items.length / 2 ? 'wide' : 'cards',
      items,
    });
  }
  return { chips, shelves };
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

export const YTM_CLIENT_VERSION = '1.20251020.01.00';

// Corps d'une requête InnerTube (client « WEB_REMIX » = site YouTube Music)
export function ytmBody(body, { hl = 'fr', gl = 'FR', clientVersion = YTM_CLIENT_VERSION } = {}) {
  return { context: { client: { clientName: 'WEB_REMIX', clientVersion, hl, gl } }, ...body };
}

// ---------- logique commune ; `call(endpoint, body)` renvoie la réponse JSON d'InnerTube

export async function ytmSearchSongs(call, q) {
  return parseTracks(await call('search', { query: q, params: SONGS_FILTER }));
}

export async function ytmPlaylist(call, pid, maxPages = 25) {
  const json = await call('browse', { browseId: `VL${pid}` });
  const header = parsePlaylistHeader(json);
  const tracks = parseTracks(json);
  const seen = new Set(tracks.map((t) => t.sourceId));
  let token = continuationToken(json);
  for (let i = 0; token && i < maxPages; i++) {
    const more = await call('browse', { continuation: token });
    const before = tracks.length;
    for (const t of parseTracks(more)) if (!seen.has(t.sourceId)) { seen.add(t.sourceId); tracks.push(t); }
    const next = continuationToken(more);
    if (next === token || tracks.length === before) break;
    token = next;
  }
  return { source: 'ytm', id: pid, name: pid === 'LM' ? 'Titres « J’aime » (YouTube Music)' : header.name, image: header.image, owner: header.owner, tracks };
}

// album : les lignes n'ont ni pochette ni artiste, on les reprend de l'en-tête
export async function ytmAlbum(call, browseId) {
  const json = await call('browse', { browseId });
  const header = parsePlaylistHeader(json);
  const artist = header.owner.split('•')[0].trim();
  const tracks = parseTracks(json).map((t) => makeTrack({
    ...t,
    artists: t.artists.length ? t.artists : [artist].filter(Boolean),
    album: t.album || header.name,
    artwork: t.artwork || header.image,
  }));
  return { source: 'ytm', id: browseId, kind: 'album', name: header.name, image: header.image, owner: artist, tracks };
}

// mix personnalisé (identifiant RD…) : lu comme une file « radio »
export async function ytmMix(call, playlistId) {
  const json = await call('next', { playlistId, isAudioOnly: true, enablePersistentPlaylistPanel: true });
  const panel = first(json, 'playlistPanelRenderer');
  const tracks = parseRadio(json);
  return { source: 'ytm', id: playlistId, kind: 'mix', name: (typeof panel?.title === 'string' ? panel.title : runsText(panel?.title?.runs)) || 'Mix', image: tracks[0]?.artwork || '', owner: 'YouTube Music', tracks };
}

// playlist, album ou mix selon l'identifiant
export function ytmCollection(call, pid, maxPages = 25) {
  if (pid.startsWith('MPRE')) return ytmAlbum(call, pid);
  if (pid.startsWith('RD')) return ytmMix(call, pid);
  return ytmPlaylist(call, pid, maxPages);
}

// accueil (ou rubrique FEmusic_…), avec 2 suites
export async function ytmHome(call, params = '', browseId = 'FEmusic_home') {
  const json = await call('browse', { browseId, ...(params ? { params } : {}) });
  const out = parseHome(json);
  let token = continuationToken(json);
  for (let i = 0; token && i < 2; i++) {
    const more = await call('browse', { continuation: token }).catch(() => null);
    if (!more) break;
    out.shelves.push(...parseHome(more).shelves);
    const next = continuationToken(more);
    if (next === token) break;
    token = next;
  }
  return out;
}

// radio (mix automatique) à partir d'un titre YouTube Music
export async function ytmRadio(call, videoId) {
  const json = await call('next', {
    videoId,
    playlistId: `RDAMVM${videoId}`,
    isAudioOnly: true,
    enablePersistentPlaylistPanel: true,
    tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
  });
  return parseRadio(json).filter((t) => t.sourceId !== videoId);
}
