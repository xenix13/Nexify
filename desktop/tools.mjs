// Outils de l'appli PC : yt-dlp (extraction YouTube) et Deno (moteur JavaScript dont yt-dlp a
// besoin pour YouTube), téléchargés au premier lancement puis tenus à jour automatiquement.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const GH = 'https://github.com';

function targets() {
  const arm = process.arch === 'arm64';
  if (process.platform === 'win32') {
    return { ytdlp: 'yt-dlp.exe', ytdlpAsset: 'yt-dlp.exe', deno: 'deno.exe', denoAsset: 'deno-x86_64-pc-windows-msvc.zip' };
  }
  if (process.platform === 'darwin') {
    return { ytdlp: 'yt-dlp', ytdlpAsset: 'yt-dlp_macos', deno: 'deno', denoAsset: arm ? 'deno-aarch64-apple-darwin.zip' : 'deno-x86_64-apple-darwin.zip' };
  }
  return { ytdlp: 'yt-dlp', ytdlpAsset: arm ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux', deno: 'deno', denoAsset: arm ? 'deno-aarch64-unknown-linux-gnu.zip' : 'deno-x86_64-unknown-linux-gnu.zip' };
}

// Lecture d'une archive zip contenant un seul fichier utile (via le répertoire central)
export function unzipEntry(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive zip invalide');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Archive zip invalide');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (path.basename(name) === wanted) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${wanted} absent de l’archive`);
}

async function download(fetchImpl, url, log) {
  log(`Téléchargement de ${url}`);
  const r = await fetchImpl(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} pour ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

function writeExec(file, buf) {
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, file);
}

// Prépare yt-dlp et Deno dans `dir`. Renvoie les chemins et une promesse « prêt ».
export function ensureTools(dir, { fetchImpl = fetch, log = () => {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const t = targets();
  const ytdlp = path.join(dir, t.ytdlp);
  const deno = path.join(dir, t.deno);
  const ready = (async () => {
    if (!fs.existsSync(deno)) {
      const zip = await download(fetchImpl, `${GH}/denoland/deno/releases/latest/download/${t.denoAsset}`, log);
      writeExec(deno, unzipEntry(zip, t.deno));
    }
    if (!fs.existsSync(ytdlp)) {
      writeExec(ytdlp, await download(fetchImpl, `${GH}/yt-dlp/yt-dlp/releases/latest/download/${t.ytdlpAsset}`, log));
    } else if (Date.now() - fs.statSync(ytdlp).mtimeMs > 2 * 86_400_000) {
      // YouTube change souvent : mise à jour de yt-dlp en arrière-plan, au plus tous les 2 jours
      const child = spawn(ytdlp, ['-U'], { stdio: 'ignore', windowsHide: true });
      child.on('close', () => { try { fs.utimesSync(ytdlp, new Date(), new Date()); } catch { /* sans effet */ } });
      child.on('error', () => {});
    }
  })();
  ready.catch((e) => log(`Outils indisponibles : ${e.message}`));
  return { ytdlp, deno, ready };
}
