// Test de bout en bout : vrai serveur HTTP, services externes simulés
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createApp } from '../server/app.js';
import { getConfig } from '../server/config.js';
import * as fx from './fixtures.js';

const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const AUDIO = Buffer.alloc(1000, 7);

async function fakeFetch(input, opts = {}) {
  const url = new URL(String(input));
  calls.push({ host: url.host, path: url.pathname, method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} });
  if (url.host === 'accounts.spotify.com') {
    const p = new URLSearchParams(opts.body);
    return json({ access_token: `at-${p.get('grant_type')}`, refresh_token: 'rt-1', expires_in: 3600, scope: 'streaming' });
  }
  if (url.host === 'api.spotify.com') {
    const p = url.pathname.replace('/v1', '');
    if (p === '/me') return json({ id: 'colas', display_name: 'Colas' });
    if (p === '/search') return json({ tracks: { items: [fx.spotifyTrack('sp1', 'Get Lucky', 'Daft Punk', 369000)], next: 'x' } });
    if (p === '/me/playlists') return json({ items: [{ id: 'plA', name: 'Mienne', images: [], owner: { id: 'colas', display_name: 'Colas' }, items: { total: 1 } }], next: null });
    if (p === '/playlists/plA') return json({ id: 'plA', name: 'Mienne', images: [], owner: { display_name: 'Colas' } });
    if (p === '/playlists/plA/items') return json({ items: [{ item: fx.spotifyTrack('sp2', 'Digital Love', 'Daft Punk', 301000) }], next: null });
    if (p === '/me/player/play') return new Response(null, { status: 204 });
    return json({ error: { status: 404, message: 'not found' } }, 404);
  }
  if (url.host === 'api.deezer.com') {
    if (url.pathname === '/search') return json({ data: [fx.deezerTrack(11, 'One More Time', 'Daft Punk', 320)], next: 'x' });
    if (url.pathname === '/user/42') return json({ id: 42, name: 'colas_dz' });
    if (url.pathname === '/user/404') return json({ error: { type: 'DataException', message: 'no data', code: 800 } });
    if (url.pathname === '/user/42/playlists') return json({ data: [{ id: 9, title: 'Été', nb_tracks: 2, picture_medium: '', is_loved_track: false }, { id: 10, title: 'Loved', is_loved_track: true }] });
    if (url.pathname === '/user/42/tracks') return json({ data: [fx.deezerTrack(12, 'Aerodynamic', 'Daft Punk', 207)] });
    if (url.pathname === '/playlist/9') return json({ id: 9, title: 'Été', picture_medium: '', creator: { name: 'colas_dz' } });
    if (url.pathname === '/playlist/9/tracks') return json({ data: [fx.deezerTrack(11, 'One More Time', 'Daft Punk', 320), fx.deezerTrack(13, 'Voyager', 'Daft Punk', 227)], next: null });
  }
  if (url.host === 'music.youtube.com') {
    const body = JSON.parse(opts.body || '{}');
    if (url.pathname.endsWith('/search')) {
      if (/One More Time/i.test(body.query)) {
        return json(fx.ytmSearchResponse([
          { videoId: 'wrongwrong1', title: 'One More Time (Karaoke)', artist: 'Karaoke Kings', album: 'K', duration: '4:10' },
          { videoId: 'FGBhQbmPwH8', title: 'One More Time', artist: 'Daft Punk', album: 'Discovery', duration: '5:21' },
        ]));
      }
      if (/Voyager/i.test(body.query)) return json(fx.ytmSearchResponse([{ videoId: 'zzzzzzzzzzz', title: 'Something Else', artist: 'Nobody', album: 'N', duration: '1:00' }]));
      return json(fx.ytmSearchResponse([{ videoId: 'abcdefghijk', title: 'Get Lucky', artist: 'Daft Punk', album: 'RAM', duration: '6:09' }]));
    }
    if (url.pathname.endsWith('/next') && body.playlistId === 'RDTMAK5uy_mix') {
      return json({ ...fx.ytmRadioResponse([{ videoId: 'mmmmmmmmmm1', title: 'Dans le mix', artist: 'ISK', album: 'A', duration: '3:00' }]), playlistPanelRendererTitle: 1 });
    }
    if (url.pathname.endsWith('/next')) {
      return json(fx.ytmRadioResponse([
        { videoId: body.videoId, title: 'Seed', artist: 'Daft Punk', album: 'RAM', duration: '6:09' },
        { videoId: 'rrrrrrrrrr1', title: 'Instant Crush', artist: 'Daft Punk', album: 'RAM', duration: '5:37' },
        { videoId: 'rrrrrrrrrr2', title: 'Lose Yourself to Dance', artist: 'Daft Punk', album: 'RAM', duration: '5:53' },
      ]));
    }
    if (url.pathname.endsWith('/account/account_menu')) return json({ actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: { accountName: { runs: [{ text: 'Colas YT' }] } } } } } } }] });
    if (url.pathname.endsWith('/browse')) {
      if (body.browseId === 'FEmusic_liked_playlists') return json(fx.ytmLibrary([{ id: 'PLytm0000001', name: 'Route' }]));
      if (body.browseId === 'VLPLytm0000001') {
        return json(fx.ytmPlaylistResponse({ title: 'Route', items: [{ videoId: 'aaaaaaaaaaa', title: 'Un', artist: 'A', album: 'X', duration: '3:00' }], continuation: 'C1' }));
      }
      if (body.browseId === 'FEmusic_home') return json(fx.ytmHomeResponse());
      if (body.continuation === 'HOME2') return json(fx.ytmHomeContinuation());
      if (body.browseId === 'MPREb_album01') return json(fx.ytmAlbumResponse());
      if (body.continuation === 'C1') return json(fx.ytmContinuation([{ videoId: 'bbbbbbbbbbb', title: 'Deux', artist: 'B', album: 'Y', duration: '2:00' }]));
    }
  }
  if (url.host === 'i.scdn.co') {
    if (url.pathname.includes('not-image')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    return new Response(Buffer.from('PNGDATA'), { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '7' } });
  }
  if (url.host === 'cdnt-preview.dzcdn.net') {
    return new Response(AUDIO.subarray(0, 300), { status: 200, headers: { 'content-type': 'audio/mpeg', 'content-length': '300' } });
  }
  if (url.host === 'rr1.googlevideo.example') {
    const range = opts.headers?.range;
    if (range) {
      const [, s, e] = range.match(/bytes=(\d+)-(\d*)/);
      const start = Number(s);
      const end = e ? Number(e) : AUDIO.length - 1;
      return new Response(AUDIO.subarray(start, end + 1), { status: 206, headers: { 'content-type': 'audio/mp4', 'content-range': `bytes ${start}-${end}/${AUDIO.length}`, 'content-length': String(end - start + 1) } });
    }
    return new Response(AUDIO, { status: 200, headers: { 'content-type': 'audio/mp4', 'content-length': String(AUDIO.length) } });
  }
  throw new Error(`requête inattendue : ${url}`);
}

const spawned = [];
function fakeSpawn(bin, args) {
  spawned.push(args);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {};
  const id = args[args.length - 1].split('v=')[1];
  setImmediate(() => {
    child.stdout.end(`https://rr1.googlevideo.example/videoplayback?id=${id}&expire=${Math.floor(Date.now() / 1000) + 21600}\n`);
    child.emit('close', 0);
  });
  return child;
}

let app;
let server;
let base;
let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexify-test-'));
  const config = getConfig({ APP_SECRET: 'secret-de-test-assez-long', DATA_DIR: dir, PORT: '0', SPOTIFY_CLIENT_ID: 'cid', SPOTIFY_CLIENT_SECRET: 'csecret', PUBLIC_URL: 'https://hifi.local:8443' });
  app = createApp(config, { fetch: fakeFetch, spawn: fakeSpawn });
  server = http.createServer((q, s) => app.handle(q, s));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async function call(method, p, body, extra = {}) {
    const headers = { 'x-nexify': '1', ...(cookie ? { cookie } : {}), ...(extra.headers || {}) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, headers: r.headers, data: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) };
  };
}

const admin = client();
const guest = client();

test('premier compte = administrateur, puis inscriptions fermées', async () => {
  let r = await admin('GET', '/api/me');
  assert.equal(r.data.firstRun, true);
  r = await admin('POST', '/api/auth/signup', { username: 'colas', password: 'court' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/auth/signup', { username: 'colas', password: 'motdepasse1' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isAdmin, true);
  r = await guest('POST', '/api/auth/signup', { username: 'intrus', password: 'motdepasse1' });
  assert.equal(r.status, 403);
  r = await guest('GET', '/api/library');
  assert.equal(r.status, 401);
});

test('protection CSRF sur les écritures', async () => {
  const r = await admin('POST', '/api/sync', { playlists: {} }, { headers: { 'x-nexify': '' } });
  assert.equal(r.status, 403);
});

test('l’admin crée un compte, qui peut se connecter', async () => {
  let r = await admin('POST', '/api/users', { username: 'lea', password: 'motdepasse2' });
  assert.equal(r.status, 200);
  r = await guest('POST', '/api/auth/login', { username: 'lea', password: 'mauvais' });
  assert.equal(r.status, 401);
  r = await guest('POST', '/api/auth/login', { username: 'LEA', password: 'motdepasse2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.isAdmin, false);
  r = await guest('GET', '/api/users');
  assert.equal(r.status, 403);
});

test('recherche groupée : Spotify sans compte (jeton d’appli), Deezer, YouTube Music', async () => {
  const r = await admin('GET', '/api/search?q=daft%20punk');
  assert.equal(r.status, 200);
  assert.equal(r.data.results.spotify.tracks[0].key, 'spotify:sp1');
  assert.equal(r.data.results.deezer.tracks[0].key, 'deezer:11');
  assert.equal(r.data.results.ytm.tracks[0].key, 'ytm:abcdefghijk');
  const tok = calls.find((c) => c.host === 'accounts.spotify.com');
  assert.match(tok.body, /grant_type=client_credentials/);
});

test('liaison Spotify par OAuth avec PKCE', async () => {
  let r = await admin('GET', '/api/spotify/login');
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'accounts.spotify.com');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://hifi.local:8443/api/spotify/callback');
  assert.equal(loc.searchParams.get('code_challenge_method'), 'S256');
  const state = loc.searchParams.get('state');

  r = await admin('GET', '/api/spotify/callback?code=abc&state=faux');
  assert.match(r.headers.get('location'), /error=/);

  r = await admin('GET', `/api/spotify/callback?code=abc&state=${state}`);
  assert.equal(r.headers.get('location'), '/#/settings?linked=spotify');
  const exch = calls.filter((c) => c.host === 'accounts.spotify.com').pop();
  assert.match(exch.body, /code_verifier=/);

  r = await admin('GET', '/api/me');
  assert.equal(r.data.user.providers.spotify.linked, true);
  assert.equal(r.data.user.providers.spotify.displayName, 'Colas');

  // les jetons sont chiffrés sur disque
  app.store.flush();
  const raw = fs.readFileSync(path.join(dir, 'nexify.json'), 'utf8');
  assert.ok(!raw.includes('rt-1'));
});

test('liaison Deezer par profil public et YouTube Music par cookie', async () => {
  let r = await admin('POST', '/api/deezer/link', { profile: 'https://www.deezer.com/fr/profile/404' });
  assert.equal(r.status, 404);
  r = await admin('POST', '/api/deezer/link', { profile: 'https://www.deezer.com/fr/profile/42' });
  assert.equal(r.data.user.providers.deezer.displayName, 'colas_dz');

  r = await admin('POST', '/api/ytm/link', { cookie: 'SID=1; HSID=2' });
  assert.equal(r.status, 400);
  r = await admin('POST', '/api/ytm/link', { cookie: 'cookie: SID=1; SAPISID=sapi/xyz; HSID=2' });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.providers.ytm.displayName, 'Colas YT');
  const call = calls.filter((c) => c.host === 'music.youtube.com').pop();
  assert.match(call.headers.authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
});

test('bibliothèque réunie et contenu des playlists', async () => {
  let r = await admin('GET', '/api/library');
  assert.deepEqual(r.data.sources.spotify.items.map((i) => i.id), ['liked', 'plA']);
  assert.deepEqual(r.data.sources.deezer.items.map((i) => i.id), ['favorites', '9']);
  assert.deepEqual(r.data.sources.ytm.items.map((i) => i.id), ['LM', 'PLytm0000001']);

  r = await admin('GET', '/api/collection/ytm/PLytm0000001');
  assert.deepEqual(r.data.collection.tracks.map((t) => t.title), ['Un', 'Deux']);
  r = await admin('GET', '/api/collection/spotify/plA');
  assert.equal(r.data.collection.tracks[0].title, 'Digital Love');

  // un autre utilisateur sans comptes liés : erreurs propres par source
  r = await guest('GET', '/api/library');
  assert.equal(r.data.sources.deezer.code, 'not_linked');
  assert.equal(r.data.sources.spotify.code, 'not_linked');
});

test('plan de lecture : Spotify via SDK, Deezer via correspondance YouTube Music', async () => {
  const sp = (await admin('GET', '/api/search?q=x&sources=spotify')).data.results.spotify.tracks[0];
  // par défaut, tout passe par le moteur audio de Nexify (version YouTube Music)
  let r = await admin('POST', '/api/resolve', { track: sp });
  assert.equal(r.data.plan.mode, 'audio');
  await admin('PATCH', '/api/me/settings', { spotifyPlayback: 'sdk' });
  r = await admin('POST', '/api/resolve', { track: sp });
  assert.deepEqual(r.data.plan, { mode: 'spotify', uri: 'spotify:track:sp1' });
  // un téléchargement veut toujours un fichier complet
  r = await admin('POST', '/api/resolve', { track: sp, download: true });
  assert.equal(r.data.plan.mode, 'audio');
  r = await admin('POST', '/api/resolve', { track: sp, prefer: 'ytm' });
  assert.equal(r.data.plan.mode, 'audio');

  const col = (await admin('GET', '/api/collection/deezer/9')).data.collection;
  r = await admin('POST', '/api/resolve', { track: col.tracks[0] });
  assert.equal(r.data.plan.url, '/api/ytm/stream/FGBhQbmPwH8');
  assert.equal(r.data.plan.via.artists[0], 'Daft Punk');
  // pas de correspondance fiable : extrait Deezer
  r = await admin('POST', '/api/resolve', { track: col.tracks[1] });
  assert.equal(r.data.plan.preview, true);
  assert.match(r.data.plan.url, /^\/api\/preview\?u=https%3A%2F%2Fcdnt-preview\.dzcdn\.net/, 'extrait relayé (même origine pour Web Audio)');
  r = await admin('POST', '/api/resolve', { track: col.tracks[1], download: true });
  assert.equal(r.status, 404, 'pas de téléchargement d’un simple extrait');

  await admin('PATCH', '/api/me/settings', { deezerPlayback: 'preview' });
  r = await admin('POST', '/api/resolve', { track: col.tracks[0] });
  assert.equal(r.data.plan.preview, true);
});

test('relais audio YouTube avec requêtes partielles (avance rapide)', async () => {
  let r = await admin('GET', '/api/ytm/stream/FGBhQbmPwH8', undefined, { headers: { range: 'bytes=100-199' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000');
  assert.equal(r.data.length, 100);
  r = await admin('GET', '/api/ytm/stream/FGBhQbmPwH8');
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 1000);
  assert.equal(spawned.length, 1, 'l’URL résolue est mise en cache');
  r = await admin('GET', '/api/ytm/stream/pas-valide');
  assert.equal(r.status, 400);
  r = await guest('GET', '/api/ytm/stream/FGBhQbmPwH8');
  assert.equal(r.status, 200, 'tout utilisateur connecté peut lire');
});

test('synchronisation : playlists et « J’aime » fusionnés entre appareils, privés par utilisateur', async () => {
  const sp = (await admin('GET', '/api/search?q=x&sources=spotify')).data.results.spotify.tracks[0];
  const yt = (await admin('GET', '/api/search?q=x&sources=ytm')).data.results.ytm.tracks[0];
  const t0 = Date.now() - 10_000;
  // appareil 1 : crée une playlist mélangée et aime un titre
  let r = await admin('POST', '/api/sync', {
    playlists: { mixMix0001: { id: 'mixMix0001', name: 'Mix', tracks: [sp, yt], createdAt: t0, updatedAt: t0 } },
    likes: { [yt.key]: { key: yt.key, track: yt, at: t0, updatedAt: t0 } },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.data.playlists.mixMix0001.tracks.map((t) => t.source), ['spotify', 'ytm']);
  // appareil 2 (hors ligne pendant ce temps) : renomme plus tard, et ajoute des données invalides
  r = await admin('POST', '/api/sync', {
    playlists: {
      mixMix0001: { id: 'mixMix0001', name: 'Mix du soir', tracks: [yt], updatedAt: t0 + 5000 },
      'bad id!': { id: 'bad id!', name: 'x', tracks: [], updatedAt: t0 },
      vide000001: { id: 'vide000001', name: '   ', tracks: [], updatedAt: t0 },
    },
    likes: { 'ytm:faux': { key: 'ytm:autre', track: yt, updatedAt: t0 } },
  });
  assert.equal(r.data.data.playlists.mixMix0001.name, 'Mix du soir');
  assert.equal(r.data.data.playlists['bad id!'], undefined);
  assert.equal(r.data.data.playlists.vide000001, undefined);
  assert.equal(r.data.data.likes['ytm:faux'], undefined);
  assert.ok(r.data.data.likes[yt.key], 'le « J’aime » de l’autre appareil est conservé');
  // un envoi plus ancien ne remplace pas la version récente
  r = await admin('POST', '/api/sync', { playlists: { mixMix0001: { id: 'mixMix0001', name: 'Vieux nom', tracks: [], updatedAt: t0 + 1000 } } });
  assert.equal(r.data.data.playlists.mixMix0001.name, 'Mix du soir');
  // suppression
  r = await admin('POST', '/api/sync', { playlists: { mixMix0001: { id: 'mixMix0001', deleted: true, updatedAt: t0 + 6000 } } });
  assert.equal(r.data.data.playlists.mixMix0001.deleted, true);
  // les données sont propres à chaque utilisateur
  r = await guest('GET', '/api/sync');
  assert.deepEqual(r.data.data.playlists, {});
  r = await admin('GET', '/api/sync');
  assert.ok(r.data.data.likes[yt.key]);
});

test('relais des pochettes et des extraits (même origine, hôtes autorisés seulement)', async () => {
  let r = await admin('GET', `/api/img?u=${encodeURIComponent('https://i.scdn.co/image/abc')}`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.data.toString(), 'PNGDATA');
  r = await admin('GET', `/api/img?u=${encodeURIComponent('https://i.scdn.co/not-image')}`);
  assert.equal(r.status, 502);
  r = await admin('GET', `/api/img?u=${encodeURIComponent('https://evil.example/a.png')}`);
  assert.equal(r.status, 400);
  r = await fetch(`${base}/api/img?u=${encodeURIComponent('https://i.scdn.co/image/abc')}`);
  assert.equal(r.status, 401, 'réservé aux utilisateurs connectés');
  r = await admin('GET', `/api/preview?u=${encodeURIComponent('https://cdnt-preview.dzcdn.net/11.mp3')}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.length, 300);
});

test('radio : titres similaires à partir d’un titre YouTube Music ou Deezer', async () => {
  const yt = (await admin('GET', '/api/search?q=x&sources=ytm')).data.results.ytm.tracks[0];
  let r = await admin('POST', '/api/radio', { track: yt });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.tracks.map((t) => t.title), ['Instant Crush', 'Lose Yourself to Dance'], 'sans le titre de départ');
  const dz = (await admin('GET', '/api/collection/deezer/9')).data.collection.tracks[0];
  r = await admin('POST', '/api/radio', { track: dz });
  assert.equal(r.status, 200);
  const next = calls.filter((c) => c.path.endsWith('/next')).pop();
  assert.equal(JSON.parse(next.body).videoId, 'FGBhQbmPwH8', 'via la correspondance YouTube Music');
});

test('accueil YouTube Music, album et mix personnalisé', async () => {
  let r = await admin('GET', '/api/home');
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.shelves.map((s) => s.title), ['Sélection rapide', 'Réécouter', 'Nouveautés et classiques', 'Favoris à redécouvrir']);
  assert.equal(r.data.chips.length, 3);
  r = await admin('GET', '/api/home?browseId=FEmusic_home&params=P1');
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(calls.filter((c) => c.path.endsWith('/browse')).find((c) => JSON.parse(c.body).params === 'P1').body).browseId, 'FEmusic_home');
  r = await admin('GET', '/api/home?browseId=VLautre');
  assert.equal(r.status, 400, 'seules les rubriques FEmusic_ sont acceptées');
  const n = calls.filter((c) => c.path.endsWith('/browse')).length;
  await admin('GET', '/api/home');
  assert.equal(calls.filter((c) => c.path.endsWith('/browse')).length, n, 'gardé en cache');
  r = await admin('GET', '/api/collection/ytm/MPREb_album01');
  assert.equal(r.data.collection.kind, 'album');
  assert.equal(r.data.collection.tracks[0].title, 'Catalogue');
  assert.deepEqual(r.data.collection.tracks[0].artists, ['La Fouine'], 'artiste repris de l’en-tête');
  assert.match(r.data.collection.tracks[0].artwork, /alb=/);
  r = await admin('GET', '/api/collection/ytm/RDTMAK5uy_mix');
  assert.equal(r.data.collection.tracks[0].title, 'Dans le mix');
});

test('applis Android / PC : jeton, accès d’une autre origine, jeton dans l’adresse des médias', async () => {
  let r = await fetch(`${base}/api/auth/login`, { method: 'OPTIONS', headers: { origin: 'http://localhost', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,x-nexify' } });
  assert.equal(r.status, 204);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  assert.match(r.headers.get('access-control-allow-headers'), /authorization/);
  r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json', 'x-nexify': '1', 'x-nexify-client': 'native' }, body: JSON.stringify({ username: 'colas', password: 'motdepasse1' }) });
  const { token } = await r.json();
  assert.ok(token && token.length > 30);
  const auth = { origin: 'http://localhost', authorization: `Bearer ${token}` };
  r = await fetch(`${base}/api/sync`, { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('access-control-allow-origin'), '*');
  r = await fetch(`${base}/api/ytm/stream/FGBhQbmPwH8?access_token=${token}`, { headers: { origin: 'http://localhost', range: 'bytes=0-9' } });
  assert.equal(r.status, 206);
  assert.match(r.headers.get('access-control-expose-headers'), /content-range/);
  r = await fetch(`${base}/api/sync?access_token=${token}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexify': '1' }, body: '{}' });
  assert.equal(r.status, 401, 'jeton dans l’adresse : lecture seule');
  r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexify': '1' }, body: JSON.stringify({ username: 'colas', password: 'motdepasse1' }) });
  assert.equal((await r.json()).token, undefined, 'pas de jeton pour le navigateur');
  r = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { ...auth, 'x-nexify': '1' } });
  r = await fetch(`${base}/api/sync`, { headers: auth });
  assert.equal(r.status, 401, 'jeton révoqué à la déconnexion');
});

test('moteur local de l’appli PC : sans compte, yt-dlp attendu avant la première lecture', async () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nexify-local-'));
  let release;
  const ready = new Promise((r) => { release = r; });
  const config = { ...getConfig({ APP_SECRET: 'secret-local-assez-long', DATA_DIR: d }), localMode: true };
  const local = createApp(config, { fetch: fakeFetch, spawn: fakeSpawn, ytdlpReady: ready });
  const srv = http.createServer((q, s) => local.handle(q, s));
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const lb = `http://127.0.0.1:${srv.address().port}`;
  try {
    let r = await (await fetch(`${lb}/api/health`)).json();
    assert.equal(r.engine, 'desktop');
    assert.ok(r.features.includes('stream'));
    r = await fetch(`${lb}/api/search?q=daft&sources=ytm`);
    assert.equal(r.status, 200, 'aucune connexion requise');
    const before = spawned.length;
    const pending = fetch(`${lb}/api/ytm/stream/abcdefghijk`, { headers: { range: 'bytes=0-9' } });
    await new Promise((x) => setTimeout(x, 100));
    assert.equal(spawned.length, before, 'attend que yt-dlp soit prêt');
    release();
    r = await pending;
    assert.equal(r.status, 206);
  } finally {
    srv.close();
    fs.rmSync(d, { recursive: true, force: true });
  }
});

test('service worker : liste des fichiers et empreinte de version', async () => {
  const r = await fetch(`${base}/sw.js`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const body = await r.text();
  assert.doesNotMatch(body, /__BUILD__|__ASSETS__/);
  assert.match(body, /const BUILD = '1\.1\.0-[0-9a-f]{10}'/);
  const assets = JSON.parse(body.match(/const ASSETS = (\[.*?\]);/)[1]);
  for (const a of ['/', '/css/style.css', '/js/app.js', '/js/audio.js', '/manifest.webmanifest', '/icons/icon-192.png']) assert.ok(assets.includes(a), a);
  assert.ok(!assets.includes('/sw.js'));
  const m = await fetch(`${base}/manifest.webmanifest`);
  assert.equal(m.headers.get('content-type'), 'application/manifest+json');
  const etag = m.headers.get('etag');
  const again = await fetch(`${base}/manifest.webmanifest`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
});

test('suppression d’un compte : ses données synchronisées disparaissent', async () => {
  const users = (await admin('GET', '/api/users')).data.users;
  const lea = users.find((u) => u.username === 'lea');
  await guest('POST', '/api/sync', { playlists: { lea0000001: { id: 'lea0000001', name: 'Léa', tracks: [], updatedAt: Date.now() } } });
  assert.ok(app.store.data.userdata[lea.id].playlists.lea0000001);
  const r = await admin('DELETE', `/api/users/${lea.id}`);
  assert.equal(r.status, 200);
  assert.equal(app.store.data.userdata[lea.id], undefined);
  assert.equal((await guest('GET', '/api/sync')).status, 401);
});

test('fichiers statiques et en-têtes de sécurité', async () => {
  let r = await fetch(`${base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /sdk\.scdn\.co/);
  r = await fetch(`${base}/library`);
  assert.equal(r.status, 200, 'retombe sur index.html');
  r = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notEqual(r.status, 200);
});
