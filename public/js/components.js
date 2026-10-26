// Composants partagés : listes de titres, menus d'actions, cartes, étagères, en-têtes.
import { h, icon, iconButton, setIcon, sourceMark, SOURCE_NAMES, fmtTime, plural, artwork, specialArt, toast, modal, popMenu } from './ui.js';
import { net } from './api.js';
import { playableWithoutServer } from './source.js';
import { player } from './player.js';
import { data } from './data.js';
import { downloads } from './downloads.js';

export const go = (hash) => { if (location.hash !== hash) location.hash = hash; else window.dispatchEvent(new HashChangeEvent('hashchange')); };
const touch = window.matchMedia('(hover: none)');

const eqBars = () => h('span.eq-bars', { 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));

function dlIndicator(key) {
  const st = downloads.state(key);
  if (!st) return null;
  if (st.status === 'done') return icon('downloaded', 'dl-mark');
  if (st.status === 'error') return null;
  return h(`span.dl-progress${st.status === 'queued' ? '.queued' : ''}`, { style: { '--p': Math.round((st.progress || 0) * 100) }, title: 'Téléchargement en cours' });
}

// ---------- liste de titres
// opts : { label, context, onRemove(i), onMove(i, dir), numbered }
export function trackList(tracks, opts = {}) {
  const list = h('ol.tracks', { 'aria-label': opts.label || 'Titres' });
  tracks.forEach((t, i) => list.append(trackRow(t, i, tracks, opts)));
  refreshRows(list);
  return list;
}

export function trackRow(t, i, tracks, opts = {}) {
  const play = () => {
    if (player.current?.key === t.key && player.mode) { player.toggle(); return; }
    if (opts.onPlay) { opts.onPlay(i); return; }
    player.playList(tracks, i, opts.context || null);
  };
  const like = iconButton(data.isLiked(t.key) ? 'liked' : 'like', 'J’aime', (e) => {
    e.stopPropagation();
    const on = data.toggleLike(t);
    toast(on ? 'Ajouté à vos titres « J’aime »' : 'Retiré de vos titres « J’aime »');
  }, { class: `track-like${data.isLiked(t.key) ? ' on' : ''}` });
  const row = h('li.track', {
    dataset: { key: t.key, source: t.source },
    onDblclick: (e) => { if (!e.target.closest('button')) play(); },
    onClick: (e) => { if (touch.matches && !e.target.closest('button')) play(); },
    onContextmenu: (e) => { e.preventDefault(); trackMenu(e.currentTarget.querySelector('.track-more') || e.currentTarget, t, i, opts); },
  },
  h('div.track-lead', {},
    artwork(t.artwork),
    h('button.track-play', { type: 'button', 'aria-label': `Lire ${t.title}`, onClick: (e) => { e.stopPropagation(); play(); } }, icon('play'), icon('pause'), eqBars())),
  h('div.track-main', {},
    h('span.track-title', {}, t.explicit ? h('span.explicit', { title: 'Explicite' }, 'E') : null, h('span.t', {}, t.title)),
    h('span.track-artists', {}, h('span.dl-slot'), sourceMark(t.source), h('span.t', {}, t.artists.join(', ') || 'Artiste inconnu'))),
  h('span.track-album', {}, t.album),
  h('div.track-flags', {}, like),
  h('span.track-time', {}, t.duration ? fmtTime(t.duration) : ''),
  iconButton('more', `Plus d’actions pour ${t.title}`, (e) => { e.stopPropagation(); trackMenu(e.currentTarget, t, i, opts); }, { class: 'track-more' }));
  return row;
}

// État de chaque ligne : en cours, téléchargé, disponible hors ligne, aimé
export function refreshRows(root = document) {
  const cur = player.current?.key;
  const offline = !net.online;
  for (const row of root.querySelectorAll('.track[data-key]')) {
    const key = row.dataset.key;
    row.classList.toggle('is-current', key === cur);
    row.classList.toggle('is-playing', key === cur && player.playing);
    row.classList.toggle('is-unavailable', offline && !playableWithoutServer({ key, source: row.dataset.source }));
    const slot = row.querySelector('.dl-slot');
    if (slot) slot.replaceChildren(dlIndicator(key) || '');
    const like = row.querySelector('.track-like');
    if (like) {
      const on = data.isLiked(key);
      like.classList.toggle('on', on);
      setIcon(like, on ? 'liked' : 'like');
    }
  }
}
let rowsQueued = false;
const queueRefresh = () => {
  if (rowsQueued) return;
  rowsQueued = true;
  requestAnimationFrame(() => { rowsQueued = false; refreshRows(); });
};
player.addEventListener('track', queueRefresh);
player.addEventListener('change', queueRefresh);
downloads.addEventListener('change', queueRefresh);
data.addEventListener('change', queueRefresh);
net.addEventListener('change', queueRefresh);

export function openUrl(t) {
  if (t.source === 'spotify') return `https://open.spotify.com/track/${t.sourceId}`;
  if (t.source === 'deezer') return `https://www.deezer.com/track/${t.sourceId}`;
  return `https://music.youtube.com/watch?v=${t.sourceId}`;
}

export function trackMenu(anchor, t, i, opts = {}) {
  const st = downloads.state(t.key);
  const liked = data.isLiked(t.key);
  popMenu(anchor, [
    { icon: 'radio', label: 'Démarrer la radio', action: () => { if (!net.online) { toast('La radio nécessite une connexion au serveur.', 'error'); return; } player.startRadio(t); } },
    { icon: 'next', label: 'Lire ensuite', action: () => { player.enqueue(t, true); toast('Ce titre sera lu juste après'); } },
    { icon: 'queue', label: 'Ajouter à la file d’attente', action: () => { player.enqueue(t); toast('Ajouté à la file d’attente'); } },
    '-',
    { icon: liked ? 'liked' : 'like', label: liked ? 'Retirer des titres « J’aime »' : 'Ajouter aux titres « J’aime »', action: () => data.toggleLike(t) },
    { icon: 'playlist-add', label: 'Ajouter à une playlist', action: () => addToPlaylist([t]) },
    st?.status === 'done'
      ? { icon: 'trash', label: 'Supprimer le téléchargement', action: () => { downloads.remove(t.key); toast('Téléchargement supprimé'); } }
      : st && st.status !== 'error'
        ? { icon: 'close', label: 'Annuler le téléchargement', action: () => downloads.cancel(t.key) }
        : { icon: 'download', label: 'Télécharger', action: () => downloadTracks([t]) },
    opts.onMove && i > 0 ? { icon: 'up', label: 'Monter', action: () => opts.onMove(i, -1) } : null,
    opts.onMove && opts.count && i < opts.count - 1 ? { icon: 'down', label: 'Descendre', action: () => opts.onMove(i, 1) } : null,
    opts.onRemove ? { icon: 'trash', label: opts.removeLabel || 'Retirer de cette playlist', action: () => opts.onRemove(i), danger: true } : null,
    '-',
    { icon: 'external', label: `Ouvrir dans ${SOURCE_NAMES[t.source]}`, action: () => window.open(openUrl(t), '_blank', 'noopener') },
  ], h('div.menu-head', {}, artwork(t.artwork), h('div', {}, h('b', {}, t.title), h('small', {}, t.artists.join(', ')))));
}

export function downloadTracks(tracks) {
  const n = downloads.enqueue(tracks);
  if (!n) { toast('Déjà téléchargé'); return; }
  toast(net.online
    ? `${plural(n, 'titre')} en cours de téléchargement`
    : `${plural(n, 'titre')} en attente : le téléchargement démarrera au retour de la connexion`);
}

export function addToPlaylist(tracks) {
  const listBox = h('div.pick-list');
  const pls = data.playlists();
  listBox.replaceChildren(...(pls.length
    ? pls.map((p) => h('button.pick', {
      type: 'button',
      onClick: () => {
        const added = data.addTracks(p.id, tracks);
        toast(added ? `Ajouté à « ${p.name} »` : `Déjà présent dans « ${p.name} »`);
        dlg.close();
      },
    }, artwork(p.tracks.find((t) => t.artwork)?.artwork, 'xs'), h('span', {}, p.name), h('span.muted', {}, plural(p.tracks.length, 'titre'))))
    : [h('p.muted', {}, 'Vous n’avez pas encore de playlist.')]));
  const nameInput = h('input', { name: 'name', placeholder: 'Nom de la nouvelle playlist', maxlength: 120, 'aria-label': 'Nom de la nouvelle playlist' });
  const create = () => {
    if (!nameInput.value.trim()) { nameInput.focus(); return; }
    const p = data.createPlaylist(nameInput.value, tracks);
    toast(`Playlist « ${p.name} » créée`);
    dlg.close();
  };
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } });
  const dlg = modal(tracks.length > 1 ? `Ajouter ${plural(tracks.length, 'titre')} à une playlist` : 'Ajouter à une playlist', h('div.stack', {},
    listBox,
    h('div.inline-form', {}, nameInput, h('button.btn.primary', { type: 'button', onClick: create }, 'Créer'))), [], { closeLabel: 'Fermer' });
}

// ---------- cartes et étagères
// item : { title, sub, image, kind ('liked'|'downloads'), href, onPlay, round }
export function card(item) {
  const art = item.kind === 'liked' || item.kind === 'downloads' ? specialArt(item.kind) : artwork(item.image);
  const open = item.href
    ? (cls, child) => h(`a.${cls}`, { href: item.href, 'aria-label': cls === 'card-art' ? item.title : null }, child)
    : (cls, child) => h(`button.${cls}.card-btn`, { type: 'button', 'aria-label': cls === 'card-art' ? `Lire ${item.title}` : null, onClick: () => item.onPlay?.() }, child);
  return h(`div.card${item.round ? '.round' : ''}${item.wide ? '.wide' : ''}`, {
    onContextmenu: item.track ? (e) => { e.preventDefault(); trackMenu(e.currentTarget, item.track, 0); } : null,
  },
  h('div.card-media', {},
    open('card-art', art),
    item.onPlay ? h('button.card-play', { type: 'button', 'aria-label': `Lire ${item.title}`, onClick: (e) => { e.preventDefault(); item.onPlay(); } }, icon('play')) : null),
  open('card-title', item.title),
  item.sub ? h('span.card-sub', {}, item.sub) : null);
}

export function shelf(title, content, { kicker, more, thumb } = {}) {
  const row = content;
  const scroll = (dir) => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: 'smooth' });
  return h('section.shelf', {},
    h('header.shelf-head', {},
      thumb ? artwork(thumb, 'shelf-thumb') : null,
      h('div', {}, kicker ? h('span.kicker', {}, kicker) : null, h('h2.section-title', {}, title)),
      h('div.shelf-nav', {},
        more ? h('a.btn.ghost', { href: more.href }, more.label) : null,
        iconButton('left', 'Précédent', () => scroll(-1)),
        iconButton('right', 'Suivant', () => scroll(1)))),
    row);
}

export const cardRow = (items, wide = false) => h(`div.shelf-row${wide ? '.wide' : ''}`, {}, items.map(card));

// ---------- en-tête de collection (playlist, J'aime, téléchargements)
export function collectionHead({ image, kind, kindLabel, source, title, meta, actions, note }) {
  const cover = kind === 'liked' || kind === 'downloads' ? specialArt(kind, 'cover') : artwork(image, 'cover');
  return h('header.collection-head', {},
    cover,
    h('div.collection-info', {},
      h('span.collection-kind', {}, source ? sourceMark(source) : null, kindLabel),
      h('h1.collection-title', {}, title),
      h('p.collection-meta', {}, meta),
      note ? h('span.stale', {}, note) : null,
      h('div.collection-actions', {}, actions)));
}

export function playButtons(tracks, context) {
  if (!tracks.length) return null;
  return [
    h('button.btn.primary.lg', { type: 'button', onClick: () => { if (player.shuffle) player.toggleShuffle(); player.playList(tracks, 0, context); } }, icon('play'), 'Lire'),
    h('button.btn.lg', {
      type: 'button',
      onClick: () => { if (!player.shuffle) player.toggleShuffle(); player.playList(tracks, Math.floor(Math.random() * tracks.length), context); },
    }, icon('shuffle'), 'Aléatoire'),
  ];
}

// Bouton « Télécharger » d'une collection, avec progression
export function downloadButton(tracks) {
  const btn = h('button.icon-btn', { type: 'button' }, icon('download'));
  const update = () => {
    if (!btn.isConnected && btn._wired) { downloads.removeEventListener('change', update); return; }
    const total = tracks.length;
    const done = tracks.filter((t) => downloads.has(t.key)).length;
    const pending = tracks.filter((t) => { const s = downloads.state(t.key); return s && s.status !== 'done' && s.status !== 'error'; }).length;
    const all = total > 0 && done === total;
    setIcon(btn, all ? 'downloaded' : 'download');
    btn.classList.toggle('on', all || pending > 0);
    const label = all ? 'Téléchargé : appuyez pour supprimer les téléchargements'
      : pending ? `Téléchargement : ${done} sur ${total}`
        : 'Télécharger';
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  btn.addEventListener('click', async () => {
    const done = tracks.filter((t) => downloads.has(t.key));
    if (tracks.length && done.length === tracks.length) {
      const { confirmDialog } = await import('./ui.js');
      if (await confirmDialog('Supprimer les téléchargements ?', `${plural(done.length, 'titre')} ne seront plus disponibles hors connexion.`, 'Supprimer', { danger: true })) {
        for (const t of done) await downloads.remove(t.key);
        toast('Téléchargements supprimés');
      }
      return;
    }
    downloadTracks(tracks);
  });
  btn._wired = true;
  downloads.addEventListener('change', update);
  update();
  return btn;
}

export function errorBlock(e, retry) {
  return h('div.notice.error', { role: 'alert' }, icon(e.status === 0 ? 'offline' : 'close'), h('p', {}, e.message), retry ? h('button.btn', { type: 'button', onClick: retry }, 'Réessayer') : null);
}

export const loading = (label = 'Chargement…') => h('p.loading', { role: 'status' }, label);
