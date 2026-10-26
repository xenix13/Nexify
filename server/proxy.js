// Relais d'images (pochettes) et d'extraits audio vers la même origine que l'appli :
//  - les pochettes peuvent ainsi être gardées par le service worker pour le mode hors ligne ;
//  - l'audio passe par Web Audio (égaliseur, fondu), qui exige un flux de même origine.
// Seuls les CDN des services pris en charge sont acceptés (pas de relais ouvert).
import { Readable } from 'node:stream';
import { HttpError } from './http.js';

export const IMAGE_HOSTS = ['.scdn.co', '.spotifycdn.com', '.dzcdn.net', '.googleusercontent.com', '.ggpht.com', '.ytimg.com'];
export const AUDIO_HOSTS = ['.dzcdn.net', '.scdn.co'];

export function allowedUrl(raw, hosts) {
  let url;
  try { url = new URL(String(raw || '')); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return hosts.some((h) => host.endsWith(h) || host === h.slice(1)) ? url : null;
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function relay(req, res, raw, { hosts, kind, fetchImpl, maxAge }) {
  const url = allowedUrl(raw, hosts);
  if (!url) throw new HttpError(400, 'Adresse non autorisée');
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  const headers = { 'user-agent': UA };
  if (req.headers.range && kind === 'audio') headers.range = req.headers.range;
  let up;
  try {
    up = await fetchImpl(url, { headers, signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    throw new HttpError(502, `Ressource injoignable : ${e.message}`);
  }
  if (!up.ok && up.status !== 206) {
    await up.body?.cancel().catch(() => {});
    throw new HttpError(up.status === 404 ? 404 : 502, `Ressource indisponible (HTTP ${up.status})`);
  }
  const type = up.headers.get('content-type') || '';
  if (kind === 'image' && !type.startsWith('image/')) {
    await up.body?.cancel().catch(() => {});
    throw new HttpError(502, 'Ce n’est pas une image');
  }
  const out = {
    'content-type': type || (kind === 'audio' ? 'audio/mpeg' : 'application/octet-stream'),
    'cache-control': `private, max-age=${maxAge}`,
    'x-content-type-options': 'nosniff',
  };
  if (kind === 'audio') out['accept-ranges'] = 'bytes';
  for (const h of ['content-length', 'content-range']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body || req.method === 'HEAD') { res.end(); return; }
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}
