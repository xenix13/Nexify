// Correspondance entre sources : trouve sur YouTube Music l'équivalent d'un titre
// Spotify ou Deezer, pour le lire en entier quand la source d'origine ne le permet pas.

const NOISE = /\s*[([](?:[^)\]]*?\b(?:feat|ft|with|avec|remaster(?:ed)?|version|edit|mono|stereo|bonus|deluxe|explicit|official|audio|lyrics?|clip|hq|hd)\b[^)\]]*)[)\]]/gi;
const DASH_NOISE = /\s+-\s+(?:.*\b(?:remaster(?:ed)?|version|edit|mono|stereo|live at|bonus)\b.*)$/i;

export function normalize(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(NOISE, ' ')
    .replace(DASH_NOISE, ' ')
    .replace(/\b(?:feat|ft)\.?\s.*$/i, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const tokens = (s) => new Set(normalize(s).split(' ').filter(Boolean));

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function scoreCandidate(target, cand, rank = 0) {
  const nt = normalize(target.title);
  const nc = normalize(cand.title);
  const title = nt && nt === nc ? 1 : Math.max(jaccard(tokens(target.title), tokens(cand.title)), nc.includes(nt) && nt.length > 3 ? 0.85 : 0);

  const ta = (target.artists || []).map(normalize).filter(Boolean);
  const ca = normalize((cand.artists || []).join(' '));
  let artist = 0;
  if (ta.length && ca) {
    if (ta.some((a) => ca.includes(a) || a.includes(ca))) artist = 1;
    else artist = jaccard(new Set(ta.join(' ').split(' ')), new Set(ca.split(' ')));
  }

  let duration = 0.6;
  if (target.duration && cand.duration) {
    const d = Math.abs(target.duration - cand.duration);
    duration = d <= 3 ? 1 : d <= 10 ? 0.8 : d <= 30 ? 0.35 : 0;
  }
  return 0.5 * title + 0.3 * artist + 0.2 * duration + Math.max(0, 0.02 * (5 - rank));
}

export function bestMatch(target, candidates, threshold = 0.62) {
  let best = null;
  candidates.forEach((c, i) => {
    const s = scoreCandidate(target, c, i);
    if (!best || s > best.score) best = { track: c, score: s };
  });
  return best && best.score >= threshold ? best : null;
}

export class Matcher {
  constructor({ ytm, store }) {
    this.ytm = ytm;
    this.store = store;
    store.data.matches = store.data.matches || {};
  }

  async find(track) {
    const cached = this.store.data.matches[track.key];
    if (cached && (cached.videoId || cached.at > Date.now() - 86_400_000)) return cached.videoId ? cached : null;
    const q = `${(track.artists || []).slice(0, 2).join(' ')} ${track.title}`.trim();
    const candidates = await this.ytm.searchSongs(q);
    const best = bestMatch(track, candidates.slice(0, 10));
    const entry = best
      ? { videoId: best.track.sourceId, title: best.track.title, artists: best.track.artists, score: Number(best.score.toFixed(3)), at: Date.now() }
      : { videoId: null, at: Date.now() };
    this.store.data.matches[track.key] = entry;
    const keys = Object.keys(this.store.data.matches);
    if (keys.length > 20000) for (const k of keys.slice(0, 2000)) delete this.store.data.matches[k];
    this.store.save();
    return entry.videoId ? entry : null;
  }

  forget(key) { delete this.store.data.matches[key]; this.store.save(); }
}
