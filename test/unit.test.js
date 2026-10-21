import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { makeCipher, hashPassword, verifyPassword } from '../server/crypto.js';
import { normalize, bestMatch, scoreCandidate } from '../server/match.js';
import { parseTracks, parsePlaylistHeader, parseLibraryPlaylists, continuationToken, parseYtmPlaylist, sapisidHash, bestThumb } from '../server/providers/ytmusic.js';
import { mapDeezerTrack, parseDeezerProfile } from '../server/providers/deezer.js';
import { mapSpotifyTrack } from '../server/providers/spotify.js';
import { sanitizeTrack, parseDuration } from '../server/track.js';
import { Router } from '../server/http.js';
import * as fx from './fixtures.js';

test('chiffrement aller-retour et refus d’un texte altéré', () => {
  const c = makeCipher('un-secret-assez-long');
  const box = c.encrypt('jeton');
  assert.notEqual(box, 'jeton');
  assert.equal(c.decrypt(box), 'jeton');
  const bad = box.slice(0, -4) + (box.endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.throws(() => c.decrypt(bad));
  assert.throws(() => makeCipher('court'));
});

test('mots de passe hachés avec scrypt', () => {
  const h = hashPassword('motdepasse');
  assert.ok(h.startsWith('scrypt:'));
  assert.equal(verifyPassword('motdepasse', h), true);
  assert.equal(verifyPassword('autre', h), false);
  assert.equal(verifyPassword('x', 'n’importe quoi'), false);
});

test('normalisation des titres', () => {
  assert.equal(normalize('Get Lucky (feat. Pharrell Williams) - Radio Edit'), 'get lucky');
  assert.equal(normalize('Bohemian Rhapsody - Remastered 2011'), 'bohemian rhapsody');
  assert.equal(normalize('Ça plane pour moi'), 'ca plane pour moi');
  assert.equal(normalize('Hey Jude [Remastered]'), 'hey jude');
});

test('correspondance : choisit la bonne version et rejette les mauvaises', () => {
  const target = { title: 'Get Lucky (feat. Pharrell Williams & Nile Rodgers)', artists: ['Daft Punk'], duration: 369 };
  const cands = [
    { title: 'Get Lucky (Cover)', artists: ['Random Band'], duration: 250 },
    { title: 'Get Lucky', artists: ['Daft Punk', 'Pharrell Williams', 'Nile Rodgers'], duration: 368 },
    { title: 'Lose Yourself to Dance', artists: ['Daft Punk'], duration: 353 },
  ];
  const best = bestMatch(target, cands);
  assert.equal(best.track.artists[0], 'Daft Punk');
  assert.equal(best.track.title, 'Get Lucky');
  assert.equal(bestMatch(target, [cands[2]]), null);
  assert.ok(scoreCandidate(target, cands[1]) > scoreCandidate(target, cands[0]));
});

test('YouTube Music : analyse des résultats de recherche', () => {
  const json = fx.ytmSearchResponse([
    { videoId: 'abcdefghijk', title: 'Get Lucky', artist: 'Daft Punk', album: 'Random Access Memories', duration: '6:09', explicit: true },
    { videoId: 'bcdefghijkl', title: 'Instant Crush', artist: 'Daft Punk', album: 'Random Access Memories', duration: '5:37' },
  ]);
  const tracks = parseTracks(json);
  assert.equal(tracks.length, 2);
  assert.deepEqual(
    { ...tracks[0], artwork: undefined },
    {
      source: 'ytm', sourceId: 'abcdefghijk', key: 'ytm:abcdefghijk', title: 'Get Lucky', artists: ['Daft Punk'],
      album: 'Random Access Memories', duration: 369, artwork: undefined, previewUrl: '',
      uri: 'https://music.youtube.com/watch?v=abcdefghijk', explicit: true,
    },
  );
  assert.match(tracks[0].artwork, /=w300-h300/);
});

test('YouTube Music : playlist, en-tête, suite paginée et bibliothèque', () => {
  const pl = fx.ytmPlaylistResponse({
    title: 'Soirée',
    items: [{ videoId: 'aaaaaaaaaaa', title: 'Un', artist: 'A', album: 'X', duration: '3:01' }],
    continuation: 'TOKEN1',
  });
  assert.deepEqual(parsePlaylistHeader(pl), { name: 'Soirée', image: 'https://lh3.googleusercontent.com/pl=w400-h400-l90-rj', owner: 'Colas' });
  const t = parseTracks(pl);
  assert.equal(t[0].duration, 181);
  assert.equal(t[0].album, 'X');
  assert.equal(continuationToken(pl), 'TOKEN1');
  assert.equal(continuationToken(fx.ytmContinuation([])), null);

  const lib = parseLibraryPlaylists(fx.ytmLibrary([{ id: 'PL123456789', name: 'Route' }, { id: 'LM', name: 'J’aime' }]));
  assert.deepEqual(lib.map((l) => l.id), ['PL123456789']);
});

test('YouTube Music : liens de playlist et signature SAPISIDHASH', () => {
  assert.equal(parseYtmPlaylist('https://music.youtube.com/playlist?list=PLabc123def456'), 'PLabc123def456');
  assert.equal(parseYtmPlaylist('VLPLabc123def456'), 'PLabc123def456');
  assert.equal(parseYtmPlaylist('LM'), 'LM');
  assert.equal(parseYtmPlaylist('pas une playlist !'), null);
  const auth = sapisidHash('SID=1; SAPISID=abc/def; HSID=2', 'https://music.youtube.com', 1_700_000_000_000);
  const expected = createHash('sha1').update('1700000000 abc/def https://music.youtube.com').digest('hex');
  assert.equal(auth, `SAPISIDHASH 1700000000_${expected}`);
  assert.equal(sapisidHash('SID=1'), null);
  assert.equal(bestThumb([{ url: '//i.ytimg.com/x.jpg', width: 10 }]), 'https://i.ytimg.com/x.jpg');
});

test('Deezer : titres et identifiants de profil', () => {
  const t = mapDeezerTrack(fx.deezerTrack(3135556, 'Harder, Better, Faster, Stronger', 'Daft Punk', 224));
  assert.equal(t.key, 'deezer:3135556');
  assert.equal(t.duration, 224);
  assert.ok(t.previewUrl.startsWith('https://'));
  assert.equal(parseDeezerProfile('https://www.deezer.com/fr/profile/123456'), '123456');
  assert.equal(parseDeezerProfile('deezer.com/user/42'), '42');
  assert.equal(parseDeezerProfile('987'), '987');
  assert.equal(parseDeezerProfile('https://example.com/profile/1'), null);
});

test('Spotify : titres (format playlist « item » ou « track »)', () => {
  const t = mapSpotifyTrack(fx.spotifyTrack('4uLU6hMCjMI75M1A2tKUQC', 'Never Gonna Give You Up', 'Rick Astley', 213573));
  assert.equal(t.uri, 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  assert.equal(t.duration, 214);
  assert.equal(t.artwork, 'https://i.scdn.co/image/4uLU6hMCjMI75M1A2tKUQC-300');
  assert.equal(mapSpotifyTrack({ id: 'x', type: 'episode' }), null);
  assert.equal(mapSpotifyTrack(null), null);
});

test('assainissement d’un titre venu du navigateur', () => {
  assert.equal(sanitizeTrack({ source: 'evil', sourceId: '1' }), null);
  const t = sanitizeTrack({ source: 'deezer', sourceId: 12, title: 'x'.repeat(1000), artwork: 'javascript:alert(1)', artists: 'pas un tableau' });
  assert.equal(t.title.length, 300);
  assert.equal(t.artwork, '');
  assert.deepEqual(t.artists, []);
  assert.equal(parseDuration('1:02:03'), 3723);
  assert.equal(parseDuration('Titre'), 0);
});

test('routeur : paramètres et méthode non autorisée', () => {
  const r = new Router();
  r.get('/api/c/:source/:id', () => 1);
  const m = r.match('GET', '/api/c/ytm/PL%20x');
  assert.deepEqual(m.params, { source: 'ytm', id: 'PL x' });
  assert.equal(r.match('POST', '/api/c/ytm/x').methodNotAllowed, true);
  assert.equal(r.match('GET', '/api/autre'), null);
});
