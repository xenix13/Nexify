// D'où lire (ou télécharger) un titre :
//  1. Appli PC / Android : l'appareil récupère lui-même l'audio (moteur local), sans le serveur.
//  2. Sinon, ou en cas d'échec : le serveur Nexify (correspondance et relais du flux).
import { net, post, mediaUrl } from './api.js';
import { native } from './native.js';
import { downloads } from './downloads.js';

export function offlineError() {
  return Object.assign(new Error(native.isNative
    ? 'Pas de connexion Internet. Ce titre n’est pas téléchargé.'
    : 'Ce titre n’est pas téléchargé. Il sera disponible au retour de la connexion.'), { code: 'offline' });
}

// Peut-on lire ce titre sans le serveur ?
export function playableWithoutServer(track) {
  if (!track) return false;
  return downloads.has(track.key) || native.has('resolve') || (native.has('stream') && track.source === 'ytm');
}
export const playable = (track) => net.online || playableWithoutServer(track);

export async function resolveSource(track, { prefer, download = false, remoteOnly = false } = {}) {
  if (!remoteOnly) {
    if (native.has('stream') && track.source === 'ytm') {
      const url = native.streamUrl(track.sourceId);
      return { plan: { mode: 'audio', url, local: true }, url };
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
