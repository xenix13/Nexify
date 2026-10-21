// Résolution des flux audio YouTube via yt-dlp, puis relais HTTP (avec Range, donc avance
// rapide possible) : les URL googlevideo sont liées à l'adresse IP du serveur, le navigateur
// ne peut pas les lire directement.
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { HttpError } from '../http.js';

export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export class YtDlp {
  constructor({ config, spawnImpl = spawn, fetchImpl = fetch }) {
    this.cfg = config.ytdlp;
    this.spawn = spawnImpl;
    this.fetch = fetchImpl;
    this.cache = new Map(); // videoId -> { url, expiresAt }
    this.inflight = new Map();
  }

  args(videoId) {
    const a = ['-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio', '-g', '--no-playlist', '--no-warnings', '--quiet'];
    if (this.cfg.cookiesFile) a.push('--cookies', this.cfg.cookiesFile);
    a.push(...this.cfg.extraArgs, `https://music.youtube.com/watch?v=${videoId}`);
    return a;
  }

  resolve(videoId) {
    if (!VIDEO_ID.test(videoId)) return Promise.reject(new HttpError(400, 'Identifiant vidéo invalide'));
    const hit = this.cache.get(videoId);
    if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.url);
    if (this.inflight.has(videoId)) return this.inflight.get(videoId);
    const p = new Promise((resolve, reject) => {
      let out = '';
      let err = '';
      let child;
      try {
        child = this.spawn(this.cfg.bin, this.args(videoId), { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new HttpError(500, `yt-dlp introuvable (${e.message})`));
        return;
      }
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 45_000);
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(new HttpError(500, e.code === 'ENOENT' ? 'yt-dlp n’est pas installé sur le serveur.' : `yt-dlp : ${e.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const url = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'));
        if (code !== 0 || !url) {
          const msg = (err.trim().split('\n').pop() || `code ${code}`).replace(/^ERROR:\s*/, '');
          reject(new HttpError(502, `Lecture YouTube impossible : ${msg}`, { provider: 'ytm' }));
          return;
        }
        const expire = Number(new URL(url).searchParams.get('expire')) * 1000;
        const expiresAt = Math.min(expire ? expire - 10 * 60_000 : Infinity, Date.now() + 4 * 3600_000);
        this.cache.set(videoId, { url, expiresAt });
        if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
        resolve(url);
      });
    }).finally(() => this.inflight.delete(videoId));
    this.inflight.set(videoId, p);
    return p;
  }

  async stream(req, res, videoId) {
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = await this.resolve(videoId);
      const headers = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' };
      if (req.headers.range) headers.range = req.headers.range;
      let up;
      try {
        up = await this.fetch(url, { headers, signal: ac.signal });
      } catch (e) {
        if (ac.signal.aborted) return;
        throw new HttpError(502, `Flux YouTube injoignable : ${e.message}`);
      }
      if ((up.status === 403 || up.status === 410) && attempt === 0) {
        this.cache.delete(videoId); // URL expirée ou refusée : on en redemande une
        await up.body?.cancel().catch(() => {});
        continue;
      }
      if (!up.ok && up.status !== 206) throw new HttpError(502, `Flux YouTube : HTTP ${up.status}`);
      const out = { 'cache-control': 'private, max-age=3600', 'accept-ranges': 'bytes' };
      for (const h of ['content-type', 'content-length', 'content-range']) {
        const v = up.headers.get(h);
        if (v) out[h] = v;
      }
      if (!out['content-type'] || out['content-type'] === 'application/octet-stream') out['content-type'] = 'audio/mp4';
      res.writeHead(up.status, out);
      if (!up.body) { res.end(); return; }
      Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
      return;
    }
    throw new HttpError(502, 'Flux YouTube refusé');
  }
}
