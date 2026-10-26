// Copie l'interface Nexify (dossier public) dans www/, embarqué dans l'appli Android.
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname);
const src = path.resolve(here, '..', '..', 'public');
const dst = path.resolve(here, '..', 'www');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true, filter: (f) => !f.endsWith(`${path.sep}sw.js`) });
console.log(`Interface copiée dans ${dst}`);
