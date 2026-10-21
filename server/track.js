// Modèle de titre commun aux trois sources.
// { key, source, sourceId, title, artists[], album, duration (s), artwork, previewUrl, uri, explicit }

export const SOURCES = ['spotify', 'deezer', 'ytm'];

export function makeTrack(t) {
  const track = {
    source: t.source,
    sourceId: String(t.sourceId),
    title: t.title || 'Sans titre',
    artists: (t.artists || []).filter(Boolean),
    album: t.album || '',
    duration: Math.round(Number(t.duration) || 0),
    artwork: t.artwork || '',
    previewUrl: t.previewUrl || '',
    uri: t.uri || '',
    explicit: Boolean(t.explicit),
  };
  track.key = `${track.source}:${track.sourceId}`;
  return track;
}

// Nettoie un titre reçu du client avant stockage dans une playlist locale
export function sanitizeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  if (!SOURCES.includes(t.source) || !t.sourceId) return null;
  const str = (v, max = 300) => String(v ?? '').slice(0, max);
  return makeTrack({
    source: t.source,
    sourceId: str(t.sourceId, 100),
    title: str(t.title),
    artists: Array.isArray(t.artists) ? t.artists.slice(0, 10).map((a) => str(a, 200)) : [],
    album: str(t.album),
    duration: Number(t.duration) || 0,
    artwork: /^https:\/\//.test(t.artwork || '') ? str(t.artwork, 1000) : '',
    previewUrl: /^https:\/\//.test(t.previewUrl || '') ? str(t.previewUrl, 1000) : '',
    uri: str(t.uri, 200),
    explicit: Boolean(t.explicit),
  });
}

export function parseDuration(text) {
  if (typeof text !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(text.trim())) return 0;
  return text.trim().split(':').reduce((acc, n) => acc * 60 + Number(n), 0);
}

export function pickImage(images, prefer = 300) {
  if (!Array.isArray(images) || !images.length) return '';
  const sorted = [...images].filter((i) => i && i.url).sort((a, b) => (a.width || 0) - (b.width || 0));
  return (sorted.find((i) => (i.width || 0) >= prefer) || sorted[sorted.length - 1] || {}).url || '';
}
