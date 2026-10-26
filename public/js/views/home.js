// Accueil : étagères construites à partir des données gardées sur l'appareil.
import { h, icon, plural, SOURCE_NAMES, toast } from '../ui.js';
import { net } from '../api.js';
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

export function viewHome(ctx) {
  const draw = () => {
    if (!ctx.alive()) return;
    const top = data.topTracks(20);
    const recent = data.recent.slice(0, 16);
    const pls = data.playlists();
    const liked = data.likedTracks();
    const dls = downloads.tracks();
    const hist = data.recentTracks(16);
    const blocks = [];

    blocks.push(h('h1.page-title', {}, `${greeting()}${data.user ? `, ${data.user.username}` : ''}`));

    if (!net.online) {
      blocks.push(h('div.notice', {}, icon('offline'), h('p', {}, dls.length
        ? `Vous êtes hors connexion. ${plural(dls.length, 'titre téléchargé', 'titres téléchargés')} restent disponibles.`
        : 'Vous êtes hors connexion. Téléchargez des titres pour les écouter sans connexion.'),
      dls.length ? h('a.btn', { href: '#/library/downloads' }, 'Mes téléchargements') : null));
    }

    if (!top.length && !pls.length && !liked.length) {
      blocks.push(h('section.hero', {},
        h('h1', {}, 'Toute votre musique, ', h('span.grad-text', {}, 'au même endroit'), '.'),
        h('p', {}, 'Recherchez parmi YouTube Music, Spotify et Deezer, créez vos playlists et téléchargez vos titres pour les écouter partout, même sans connexion.'),
        h('div.actions', {},
          h('a.btn.primary.lg', { href: '#/search' }, icon('search'), 'Rechercher de la musique'),
          h('a.btn.lg', { href: '#/settings/services' }, 'Connecter mes services'))));
    }

    if (top.length >= 4) {
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
  ctx.on(data, 'library', draw);
  ctx.on(net, 'change', draw);
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
