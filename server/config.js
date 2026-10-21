// Configuration : variables d'environnement, avec chargement optionnel d'un fichier .env
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function getConfig(env = process.env) {
  const port = Number(env.PORT || 8443);
  const tlsCert = env.TLS_CERT || '';
  const tlsKey = env.TLS_KEY || '';
  const https = Boolean(tlsCert && tlsKey);
  return {
    port,
    host: env.HOST || '0.0.0.0',
    https,
    tlsCert,
    tlsKey,
    // URL publique utilisée pour les redirections OAuth (ex: https://192.168.1.50:8443)
    publicUrl: (env.PUBLIC_URL || `${https ? 'https' : 'http'}://127.0.0.1:${port}`).replace(/\/+$/, ''),
    dataDir: path.resolve(env.DATA_DIR || path.join(ROOT, 'data')),
    appSecret: env.APP_SECRET || '',
    allowSignup: (env.ALLOW_SIGNUP || 'first').toLowerCase(), // first | yes | no
    spotify: {
      clientId: env.SPOTIFY_CLIENT_ID || '',
      clientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    },
    ytdlp: {
      bin: env.YTDLP_BIN || 'yt-dlp',
      extraArgs: (env.YTDLP_EXTRA_ARGS || '').split(' ').filter(Boolean),
      cookiesFile: env.YTDLP_COOKIES_FILE || '',
    },
    market: env.MARKET || 'FR',
    lang: env.LANG_UI || 'fr',
  };
}
