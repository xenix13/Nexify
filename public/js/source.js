// D'où lire (ou télécharger) un titre :
//  1. Appli PC / Android : l'appareil récupère lui-même l'audio (moteur local), sans le serveur.
//  2. Sinon, ou en cas d'échec : le serveur Nexify (correspondance et relais du flux).
import { net, post, mediaUrl } from './api.js';
import { native } from './native.js';
import { downloads } from './downloads.js';
import { matchLocal } from './ytm-local.js';

export function offlineError() {
  return Object.assign(new Error(native.isNative
    ? 'Pas de connexion Internet. Ce titre n’est pas téléchargé.'
    : 'Ce titre n’est pas téléchargé. Il sera disponible au retour de la connexion.'), { code: 'offline' });
}

// Peut-on lire ce titre sans le serveur ?
export function playableWithoutServer(track) {
  if (!track) return false;
  if (downloads.has(track.key) || native.has('resolve')) return true;
  if (!native.has('stream')) return false;
  return track.source === 'ytm' || native.has('innertube'); // Android : correspondance faite sur le téléphone
}
export const playable = (track) => net.online || playableWithoutServer(track);

export async function resolveSource(track, { prefer, download = false, remoteOnly = false } = {}) {
  if (!remoteOnly) {
    if (native.has('stream') && track.source === 'ytm') {
      const url = native.streamUrl(track.sourceId);
      return { plan: { mode: 'audio', url, local: true }, url };
    }
    // Android : titre Spotify / Deezer mis en correspondance par le téléphone lui-même
    if (native.has('stream') && native.has('innertube') && track.source !== 'ytm') {
      try {
        const m = await matchLocal(track);
        if (m?.videoId) {
          const url = native.streamUrl(m.videoId);
          return { plan: { mode: 'audio', url, local: true, via: { source: 'ytm', videoId: m.videoId, title: m.title, artists: m.artists } }, url };
        }
      } catch (e) {
        if (!net.online) throw e.code === 'offline' ? offlineError() : e;
      }
      if (!net.online) throw Object.assign(new Error('Aucune version complète n’est disponible pour ce titre.'), { status: 404 });
    }
    if (native.has('resolve')) {
      try {
        const { plan } = await native.engineJson('/api/resolve', { method: 'POST', body: { track, prefer: 'ytm', download } });
        return { plan: { ...plan, local: true }, url: native.engineUrl(plan.url) };
      } catch (e) {
        if (!net.online) throw e.code === 'offline' ? offlineError() : e;
      }
    }
  }
  if (!net.online) throw offlineError();
  const { plan } = await post('/api/resolve', { track, prefer, download });
  if (plan.mode !== 'audio') return { plan, url: null };
  // Android : le serveur ne fait que trouver la bonne version, l'audio vient du téléphone
  if (!remoteOnly && plan.via?.videoId && native.has('stream')) {
    const url = native.streamUrl(plan.via.videoId);
    return { plan: { ...plan, local: true }, url };
  }
  return { plan, url: mediaUrl(plan.url) };
}
