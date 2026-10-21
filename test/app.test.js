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
    if (url.pathname.endsWith('/account/account_menu')) return json({ actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: { accountName: { runs: [{ text: 'Colas YT' }] } } } } } } }] });
    if (url.pathname.endsWith('/browse')) {
      if (body.browseId === 'FEmusic_liked_playlists') return json(fx.ytmLibrary([{ id: 'PLytm0000001', name: 'Route' }]));
      if (body.browseId === 'VLPLytm0000001') {
        return json(fx.ytmPlaylistResponse({ title: 'Route', items: [{ videoId: 'aaaaaaaaaaa', title: 'Un', artist: 'A', album: 'X', duration: '3:00' }], continuation: 'C1' }));
      }
      if (body.continuation === 'C1') return json(fx.ytmContinuation([{ videoId: 'bbbbbbbbbbb', title: 'Deux', artist: 'B', album: 'Y', duration: '2:00' }]));
    }
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotihome-test-'));
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
    const headers = { 'x-spotihome': '1', ...(cookie ? { cookie } : {}), ...(extra.headers || {}) };
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
  const r = await admin('POST', '/api/playlists', { name: 'x' }, { headers: { 'x-spotihome': '' } });
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
  const raw = fs.readFileSync(path.join(dir, 'spotihome.json'), 'utf8');
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
  let r = await admin('POST', '/api/resolve', { track: sp });
  assert.deepEqual(r.data.plan, { mode: 'spotify', uri: 'spotify:track:sp1' });
  r = await admin('POST', '/api/resolve', { track: sp, prefer: 'ytm' });
  assert.equal(r.data.plan.mode, 'audio');

  const col = (await admin('GET', '/api/collection/deezer/9')).data.collection;
  r = await admin('POST', '/api/resolve', { track: col.tracks[0] });
  assert.equal(r.data.plan.url, '/api/ytm/stream/FGBhQbmPwH8');
  assert.equal(r.data.plan.via.artists[0], 'Daft Punk');
  // pas de correspondance fiable : extrait Deezer
  r = await admin('POST', '/api/resolve', { track: col.tracks[1] });
  assert.equal(r.data.plan.preview, true);

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

test('playlists Spotihome mélangées et import', async () => {
  const sp = (await admin('GET', '/api/search?q=x&sources=spotify')).data.results.spotify.tracks[0];
  const yt = (await admin('GET', '/api/search?q=x&sources=ytm')).data.results.ytm.tracks[0];
  let r = await admin('POST', '/api/playlists', { name: 'Mix', tracks: [sp] });
  const id = r.data.playlist.id;
  r = await admin('POST', `/api/playlists/${id}/tracks`, { tracks: [yt, sp] });
  assert.equal(r.data.added, 1);
  assert.deepEqual(r.data.playlist.tracks.map((t) => t.source), ['spotify', 'ytm']);

  r = await guest('GET', `/api/playlists/${id}`);
  assert.equal(r.status, 404, 'les playlists sont privées');

  r = await admin('PATCH', `/api/playlists/${id}`, { name: 'Mix du soir', tracks: [yt] });
  assert.equal(r.data.playlist.name, 'Mix du soir');
  assert.equal(r.data.playlist.tracks.length, 1);

  r = await admin('POST', '/api/import', { source: 'deezer', id: '9' });
  assert.equal(r.data.playlist.name, 'Été');
  assert.equal(r.data.playlist.count, 2);

  r = await admin('GET', '/api/playlists');
  assert.equal(r.data.playlists.length, 2);
  r = await admin('DELETE', `/api/playlists/${id}`);
  assert.equal(r.status, 200);
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
