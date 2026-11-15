// Correspondance entre sources : calcul partagé avec l'appli, cache côté serveur.
import { bestMatch } from '../public/js/shared/match.js';

export { normalize, scoreCandidate, bestMatch } from '../public/js/shared/match.js';

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
