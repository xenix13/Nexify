// Pages de collection : playlist d'un service, playlist Nexify, titres « J'aime ».
import { h, icon, iconButton, SOURCE_NAMES, plural, fmtTotal, fmtAgo, toast, popMenu, confirmDialog, promptDialog } from '../ui.js';
import { net, post } from '../api.js';
import { data } from '../data.js';
import { player } from '../player.js';
import { trackList, collectionHead, playButtons, downloadButton, errorBlock, loading, go, downloadTracks } from '../components.js';

function moreButton(items) {
  return iconButton('more', 'Plus d’actions', (e) => popMenu(e.currentTarget, items()));
}

// ---------- playlist d'un service (gardée sur l'appareil après ouverture)
export async function viewCollection(ctx, source, id) {
  ctx.view.replaceChildren(h('div.page', {}, loading()));
  let col = null;
  const render = () => {
    if (!ctx.alive() || !col) return;
    const context = { kind: source, id: col.id, name: col.name, href: `#/c/${source}/${encodeURIComponent(id)}` };
    const savedYtm = (data.user?.providers?.ytm?.savedPlaylists || []).some((p) => p.id === col.id);
    const imported = data.playlists().find((p) => p.importedFrom?.source === source && p.importedFrom?.id === col.id);
    const actions = [
      playButtons(col.tracks, context),
      col.tracks.length ? downloadButton(col.tracks) : null,
      h('button.icon-btn', {
        type: 'button',
        title: imported ? 'Ouvrir la copie dans votre bibliothèque' : 'Ajouter à votre bibliothèque',
        'aria-label': imported ? 'Ouvrir la copie dans votre bibliothèque' : 'Ajouter à votre bibliothèque',
        class: imported ? 'on' : '',
        onClick: () => {
          if (imported) { go(`#/p/${imported.id}`); return; }
          const p = data.createPlaylist(col.name, col.tracks, { importedFrom: { source, id: col.id } });
          toast(`« ${p.name} » a été ajoutée à votre bibliothèque`, 'info', { label: 'Ouvrir', fn: () => go(`#/p/${p.id}`) });
          render();
        },
      }, icon(imported ? 'check' : 'library-add')),
      moreButton(() => [
        { icon: 'queue', label: 'Ajouter à la file d’attente', action: () => { player.enqueue(col.tracks); toast(`${plural(col.tracks.length, 'titre')} ajoutés à la file d’attente`); } },
        { icon: 'playlist-add', label: 'Ajouter à une playlist', action: async () => (await import('../components.js')).addToPlaylist(col.tracks) },
        source === 'ytm' && !col.id.startsWith('LM') && !savedYtm && net.online
          ? { icon: 'library-add', label: 'Garder dans ma bibliothèque YouTube Music', action: async () => {
            try { const r = await post('/api/ytm/saved', { url: col.id }); await data.setUser(r.user); toast('Playlist ajoutée à votre bibliothèque'); data.refreshLibrary().catch(() => {}); } catch (e) { toast(e.message, 'error'); }
          } }
          : null,
        net.online ? { icon: 'refresh', label: 'Actualiser', action: () => load(true) } : null,
      ]),
    ];
    const note = col.stale ? `Version hors connexion enregistrée ${fmtAgo(col.cachedAt)}` : '';
    ctx.view.replaceChildren(h('div.page', {},
      collectionHead({
        image: col.image,
        kind: col.id === 'liked' || col.id === 'favorites' || col.id === 'LM' ? 'liked' : null,
        kindLabel: `Playlist • ${SOURCE_NAMES[source]}`,
        source,
        title: col.name,
        meta: [col.owner, fmtTotal(col.tracks)].filter(Boolean).join(' • '),
        actions,
        note,
      }),
      col.tracks.length ? trackList(col.tracks, { label: col.name, context }) : h('div.empty', {}, h('p.empty-title', {}, 'Cette playlist est vide'))));
  };
  async function load(refresh) {
    try {
      col = await data.collection(source, id, { refresh });
      if (!ctx.alive()) return;
      data.visit({ source, id: col.id, kind: 'playlist', name: col.name, image: col.image, owner: col.owner });
      render();
    } catch (e) {
      if (!ctx.alive()) return;
      if (col) { toast(e.message, 'error'); return; }
      ctx.view.replaceChildren(h('div.page', {}, errorBlock(e, () => viewCollection(ctx, source, id))));
    }
  }
  await load(false);
  // version enregistrée affichée tout de suite ; mise à jour en arrière-plan si le serveur répond
  if (col?.cachedAt && net.online) load(true);
}

// ---------- playlist Nexify (modifiable hors ligne)
export function viewLocal(ctx, id) {
  const render = () => {
    if (!ctx.alive()) return;
    const p = data.playlist(id);
    if (!p) {
      ctx.view.replaceChildren(h('div.page', {}, h('div.empty', {}, h('p.empty-title', {}, 'Playlist introuvable'), h('p.muted', {}, 'Elle a peut-être été supprimée depuis un autre appareil.'), h('a.btn', { href: '#/library' }, 'Retour à la bibliothèque'))));
      return;
    }
    const context = { kind: 'local', id: p.id, name: p.name, href: `#/p/${p.id}` };
    const actions = [
      playButtons(p.tracks, context),
      p.tracks.length ? downloadButton(p.tracks) : null,
      moreButton(() => [
        { icon: 'edit', label: 'Renommer', action: async () => { const name = await promptDialog('Renommer la playlist', { value: p.name }); if (name) data.renamePlaylist(p.id, name); } },
        p.tracks.length ? { icon: 'queue', label: 'Ajouter à la file d’attente', action: () => { player.enqueue(p.tracks); toast('Ajouté à la file d’attente'); } } : null,
        p.tracks.length ? { icon: 'download', label: 'Tout télécharger', action: () => downloadTracks(p.tracks) } : null,
        '-',
        { icon: 'trash', label: 'Supprimer la playlist', danger: true, action: async () => {
          if (await confirmDialog('Supprimer la playlist ?', `« ${p.name} » sera supprimée de tous vos appareils. Les titres téléchargés restent disponibles.`, 'Supprimer', { danger: true })) {
            data.deletePlaylist(p.id);
            data.forgetRecent('local', p.id);
            toast('Playlist supprimée');
            go('#/library');
          }
        } },
      ]),
    ];
    ctx.view.replaceChildren(h('div.page', {},
      collectionHead({
        image: p.tracks.find((t) => t.artwork)?.artwork,
        kindLabel: p.importedFrom ? `Playlist • copiée depuis ${SOURCE_NAMES[p.importedFrom.source]}` : 'Playlist • Nexify',
        source: 'local',
        title: p.name,
        meta: fmtTotal(p.tracks),
        actions,
      }),
      p.tracks.length
        ? trackList(p.tracks, {
          label: p.name,
          context,
          count: p.tracks.length,
          onRemove: (i) => { const t = p.tracks[i]; data.removeTrackAt(p.id, i); toast(`« ${t.title} » retiré de la playlist`); },
          onMove: (i, dir) => data.moveTrack(p.id, i, i + dir),
        })
        : h('div.empty', {}, icon('playlist-add'), h('p.empty-title', {}, 'Cette playlist est vide'), h('p.muted', {}, 'Ajoutez des titres depuis la recherche avec le menu « Plus d’actions » de chaque titre.'), h('a.btn.primary', { href: '#/search' }, 'Rechercher des titres'))));
  };
  const p = data.playlist(id);
  if (p) data.visit({ source: 'local', id, kind: 'playlist', name: p.name, image: p.tracks.find((t) => t.artwork)?.artwork });
  let last = p;
  render();
  // ne redessine que si cette playlist a changé (pas pour un simple « J'aime »)
  ctx.on(data, 'change', () => { const now = data.playlist(id); if (now?.updatedAt !== last?.updatedAt) { last = now; render(); } });
}

// ---------- titres « J'aime »
export function viewLiked(ctx) {
  const render = () => {
    const tracks = data.likedTracks();
    const context = { kind: 'liked', name: 'Titres « J’aime »', href: '#/liked' };
    ctx.view.replaceChildren(h('div.page', {},
      collectionHead({
        kind: 'liked',
        kindLabel: 'Playlist automatique',
        title: 'Titres « J’aime »',
        meta: fmtTotal(tracks),
        actions: [playButtons(tracks, context), tracks.length ? downloadButton(tracks) : null],
      }),
      tracks.length
        ? trackList(tracks, { label: 'Titres « J’aime »', context, onRemove: (i) => data.setLiked(tracks[i], false), removeLabel: 'Retirer des titres « J’aime »' })
        : h('div.empty', {}, icon('like'), h('p.empty-title', {}, 'Aucun titre pour l’instant'), h('p.muted', {}, 'Appuyez sur « J’aime » pendant l’écoute pour retrouver vos titres préférés ici, sur tous vos appareils.'))));
  };
  data.visit({ source: 'liked', id: 'liked', kind: 'liked', name: 'Titres « J’aime »' });
  render();
  ctx.on(data, 'change', render);
}
