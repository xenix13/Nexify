// Accueil : étagères construites à partir des données gardées sur l'appareil.
import { h, icon, plural, SOURCE_NAMES, toast } from '../ui.js';
import { net, get, store } from '../api.js';
import { db } from '../db.js';
import { data } from '../data.js';
import { downloads } from '../downloads.js';
import { player } from '../player.js';
import { trackList, card, cardRow, shelf, go } from '../components.js';

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Bonne nuit' : hr < 18 ? 'Bonjour' : 'Bonsoir';
}

export function hrefFor(item) {
  if (item.source === 'local') return `#/p/${item.id}`;
  if (item.source === 'liked') return '#/liked';
  if (item.source === 'downloads') return '#/library/downloads';
  return `#/c/${item.source}/${encodeURIComponent(item.id)}`;
}

export async function playCollection(item) {
  try {
    let tracks = [];
    if (item.source === 'local') tracks = data.playlist(item.id)?.tracks || [];
    else if (item.source === 'liked') tracks = data.likedTracks();
    else if (item.source === 'downloads') tracks = downloads.tracks();
    else tracks = (await data.collection(item.source, item.id)).tracks;
    if (!tracks.length) { toast('Cette playlist est vide.'); return; }
    player.playList(tracks, 0, { kind: item.source, id: item.id, name: item.name, href: hrefFor(item) });
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---------- fil d'accueil YouTube Music (gardé sur l'appareil pour le mode hors ligne)
function feedCard(item, shelfTitle) {
  if (item.type === 'song') return { title: item.title, sub: item.subtitle, image: item.image, wide: item.wide, track: item.track, onPlay: () => player.startRadio(item.track) };
  if (item.type === 'artist') return { title: item.title, sub: item.subtitle || 'Artiste', image: item.image, round: true, href: `#/search?q=${encodeURIComponent(item.title)}` };
  return {
    title: item.title,
    sub: item.subtitle,
    image: item.image,
    wide: item.wide,
    href: `#/c/ytm/${encodeURIComponent(item.id)}`,
    onPlay: () => playCollection({ source: 'ytm', id: item.id, name: item.title, image: item.image, from: shelfTitle }),
  };
}

function feedShelves(feed) {
  return feed.shelves.map((sh) => {
    const opts = { kicker: sh.strapline || null, thumb: sh.strapline ? sh.thumb : null };
    if (sh.layout === 'list') {
      const tracks = sh.items.map((i) => i.track);
      const list = trackList(tracks, { label: sh.title, context: { kind: 'mix', name: sh.title } });
      list.classList.add('quick');
      return shelf(sh.title, list, opts);
    }
    return shelf(sh.title, cardRow(sh.items.map((i) => feedCard(i, sh.title)), sh.layout === 'wide'), opts);
  });
}

export function viewHome(ctx) {
  // filtre d'ambiance choisi : { title, params, browseId } ou null (accueil général)
  let mood = store.get('homeMood', null);
  if (!mood || typeof mood !== 'object') mood = null;
  let feed = null;
  let baseChips = []; // filtres de l'accueil général, toujours affichés pour pouvoir changer ou revenir
  let feedLoading = false;
  let feedError = '';
  const feedKey = (m) => `home:${m ? `${m.browseId}:${m.params}` : 'FEmusic_home:'}`;
  const feedUrl = (m) => `/api/home?browseId=${encodeURIComponent(m?.browseId || 'FEmusic_home')}&params=${encodeURIComponent(m?.params || '')}`;

  async function fetchFeed(m, refresh) {
    const key = feedKey(m);
    const cached = await db.get('kv', key).catch(() => null);
    if (cached && (!net.online || (!refresh && Date.now() - cached.at < 15 * 60_000))) return { data: cached, fresh: false };
    if (!net.online) return { data: null, fresh: false };
    try {
      const data = await get(feedUrl(m), { timeout: 45_000 });
      await db.put('kv', data, key).catch(() => {});
      return { data, fresh: true };
    } catch (e) {
      if (cached) return { data: cached, fresh: false };
      throw e;
    }
  }

  async function loadFeed(refresh = false) {
    const m = mood;
    const key = feedKey(m);
    const cached = await db.get('kv', key).catch(() => null);
    if (!ctx.alive() || feedKey(mood) !== key) return;
    feed = cached;
    feedError = '';
    feedLoading = !cached && net.online;
    draw();
    // filtres de l'accueil général (pour pouvoir changer de filtre ou revenir)
    if (m) fetchFeed(null, false).then(({ data }) => { if (data?.chips?.length && ctx.alive()) { baseChips = data.chips; draw(); } }).catch(() => {});
    try {
      const { data } = await fetchFeed(m, refresh);
      if (!ctx.alive() || feedKey(mood) !== key) return;
      if (data) feed = data;
      if (!m && data?.chips?.length) baseChips = data.chips;
    } catch (e) {
      if (feedKey(mood) === key) feedError = e.message;
    }
    feedLoading = false;
    if (ctx.alive() && feedKey(mood) === key) draw();
  }

  const moodChips = () => {
    const chips = baseChips.length ? baseChips : (!mood ? feed?.chips || [] : []);
    if (!chips.length && !mood) return null;
    const select = (m) => { mood = m; store.set('homeMood', m); ctx.view.scrollTop = 0; loadFeed(); };
    return h('div.chips.mood-chips', { role: 'group', 'aria-label': 'Ambiances' },
      h('button.chip', { type: 'button', 'aria-pressed': String(!mood), onClick: () => { if (mood) select(null); } }, 'Tout'),
      chips.map((c) => h('button.chip', {
        type: 'button',
        'aria-pressed': String(mood?.title === c.title),
        onClick: () => select(mood?.title === c.title ? null : { title: c.title, params: c.params, browseId: c.browseId }),
      }, c.title)));
  };

  const draw = () => {
    if (!ctx.alive()) return;
    const top = data.topTracks(20);
    const recent = data.recent.slice(0, 16);
    const pls = data.playlists();
    const liked = data.likedTracks();
    const dls = downloads.tracks();
    const hist = data.recentTracks(16);
    const blocks = [];

    const hasFeed = Boolean(feed?.shelves?.length);
    const chipsBar = moodChips();
    if (hasFeed || feedLoading || chipsBar) {
      blocks.push(h('h1.visually-hidden', {}, 'Accueil'));
      blocks.push(chipsBar || '');
      if (mood && !hasFeed && !feedLoading && !feedError) {
        blocks.push(h('div.empty', {}, h('p.empty-title', {}, `Aucun contenu disponible pour « ${mood.title} »`),
          h('p.muted', {}, net.online ? 'Ce filtre ne propose pas encore de contenu lisible dans Nexify.' : 'Ce filtre n’a pas été enregistré pour une utilisation hors connexion.'),
          h('button.btn', { type: 'button', onClick: () => { mood = null; store.set('homeMood', null); loadFeed(); } }, 'Revenir à l’accueil')));
      }
    } else {
      blocks.push(h('h1.page-title', {}, `${greeting()}${data.user ? `, ${data.user.username}` : ''}`));
    }

    if (!net.online) {
      blocks.push(h('div.notice', {}, icon('offline'), h('p', {}, dls.length
        ? `Vous êtes hors connexion. ${plural(dls.length, 'titre téléchargé', 'titres téléchargés')} restent disponibles.`
        : 'Vous êtes hors connexion. Téléchargez des titres pour les écouter sans connexion.'),
      dls.length ? h('a.btn', { href: '#/library/downloads' }, 'Mes téléchargements') : null));
    }

    if (feedLoading) {
      blocks.push(h('section.shelf.skeleton', {}, h('header.shelf-head', {}, h('h2.section-title', {}, 'Chargement de votre accueil…')), h('div.shelf-row', {}, Array.from({ length: 6 }, () => h('div')))));
    }
    if (hasFeed) blocks.push(...feedShelves(feed));
    if (feedError && !hasFeed && net.online) blocks.push(h('div.notice', {}, h('p', {}, `Accueil YouTube Music indisponible : ${feedError}`), h('button.btn', { type: 'button', onClick: () => loadFeed(true) }, 'Réessayer')));

    if (!hasFeed && !feedLoading && !top.length && !pls.length && !liked.length) {
      blocks.push(h('section.hero', {},
        h('h1', {}, 'Toute votre musique, ', h('span.grad-text', {}, 'au même endroit'), '.'),
        h('p', {}, 'Recherchez parmi YouTube Music, Spotify et Deezer, créez vos playlists et téléchargez vos titres pour les écouter partout, même sans connexion.'),
        h('div.actions', {},
          h('a.btn.primary.lg', { href: '#/search' }, icon('search'), 'Rechercher de la musique'),
          h('a.btn.lg', { href: '#/settings/services' }, 'Connecter mes services'))));
    }

    if (!hasFeed && top.length >= 4) {
      const quick = trackList(top, { label: 'Sélection rapide', context: { kind: 'mix', name: 'Sélection rapide' } });
      quick.classList.add('quick');
      blocks.push(shelf('Sélection rapide', quick, { kicker: 'D’après vos écoutes' }));
    }

    if (recent.length) {
      blocks.push(shelf('Écoutés récemment', cardRow(recent.map((r) => ({
        title: r.name,
        sub: r.source === 'local' ? 'Playlist Nexify' : r.source === 'liked' ? 'Playlist automatique' : r.source === 'downloads' ? 'Disponible hors connexion' : `Playlist • ${SOURCE_NAMES[r.source]}`,
        image: r.image,
        kind: r.source === 'liked' ? 'liked' : r.source === 'downloads' ? 'downloads' : r.kind === 'liked' ? 'liked' : null,
        href: hrefFor(r),
        onPlay: () => playCollection(r),
      })))));
    }

    const mine = [
      { title: 'Titres « J’aime »', sub: `Playlist automatique • ${plural(liked.length, 'titre')}`, kind: 'liked', href: '#/liked', onPlay: liked.length ? () => playCollection({ source: 'liked', name: 'Titres « J’aime »' }) : null },
      ...pls.map((p) => ({ title: p.name, sub: `Playlist • ${plural(p.tracks.length, 'titre')}`, image: p.tracks.find((t) => t.artwork)?.artwork, href: `#/p/${p.id}`, onPlay: p.tracks.length ? () => playCollection({ source: 'local', id: p.id, name: p.name }) : null })),
    ];
    if (pls.length || liked.length) blocks.push(shelf('Vos playlists', cardRow(mine), { more: { href: '#/library', label: 'Tout afficher' } }));

    if (dls.length) {
      blocks.push(shelf('Téléchargés', cardRow([
        { title: 'Téléchargements', sub: plural(dls.length, 'titre'), kind: 'downloads', href: '#/library/downloads', onPlay: () => playCollection({ source: 'downloads', name: 'Téléchargements' }) },
        ...dls.slice(0, 15).map((t, i) => ({ title: t.title, sub: t.artists.join(', '), image: t.artwork, href: '#/library/downloads', onPlay: () => player.playList(dls, i, { kind: 'downloads', name: 'Téléchargements', href: '#/library/downloads' }) })),
      ]), { kicker: 'Disponible hors connexion' }));
    }

    if (hist.length) {
      blocks.push(shelf('Titres écoutés récemment', cardRow(hist.map((t, i) => ({
        title: t.title, sub: t.artists.join(', '), image: t.artwork, href: '#/history', onPlay: () => player.playList(hist, i, { kind: 'history', name: 'Historique', href: '#/history' }),
      }))), { more: { href: '#/history', label: 'Historique' } }));
    }

    const lib = data.library?.sources || {};
    for (const s of ['ytm', 'spotify', 'deezer']) {
      const items = (lib[s]?.items || []).slice(0, 16);
      if (!items.length) continue;
      blocks.push(shelf(SOURCE_NAMES[s], cardRow(items.map((c) => ({
        title: c.name,
        sub: c.kind === 'liked' ? 'Playlist automatique' : [c.count != null ? plural(c.count, 'titre') : '', c.owner].filter(Boolean).join(' • ') || 'Playlist',
        image: c.image,
        kind: c.kind === 'liked' ? 'liked' : null,
        href: `#/c/${s}/${encodeURIComponent(c.id)}`,
        onPlay: () => playCollection({ source: s, id: c.id, name: c.name, image: c.image }),
      }))), { kicker: 'Depuis votre compte' }));
    }

    ctx.view.replaceChildren(h('div.page', {}, blocks));
  };
  draw();
  loadFeed();
  ctx.on(data, 'library', draw);
  ctx.on(net, 'change', () => { draw(); if (net.online) loadFeed(); });
  if (net.online && (!data.library || Date.now() - data.library.at > 10 * 60_000)) data.refreshLibrary().catch(() => {});
}

export function viewHistory(ctx) {
  const draw = () => {
    const tracks = data.recentTracks(200);
    ctx.view.replaceChildren(h('div.page', {},
      h('header.page-head', {}, h('h1.page-title', {}, 'Historique')),
      tracks.length
        ? trackList(tracks, { label: 'Historique', context: { kind: 'history', name: 'Historique', href: '#/history' } })
        : h('div.empty', {}, icon('history'), h('p.empty-title', {}, 'Aucune écoute pour l’instant'), h('p.muted', {}, 'Les titres que vous écoutez apparaîtront ici.'))));
  };
  draw();
  ctx.on(data, 'history', draw);
}

export { go };
