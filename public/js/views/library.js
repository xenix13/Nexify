// Bibliothèque : playlists Nexify, téléchargements et playlists des services connectés.
import { h, icon, iconButton, sourceMark, SOURCE_NAMES, plural, toast, fmtAgo, confirmDialog, promptDialog } from '../ui.js';
import { net } from '../api.js';
import { data } from '../data.js';
import { downloads, fmtSize } from '../downloads.js';
import { player } from '../player.js';
import { card, trackList, collectionHead, playButtons, errorBlock, loading, go } from '../components.js';
import { playCollection } from './home.js';

const TABS = [['playlists', 'Playlists'], ['downloads', 'Téléchargements'], ['ytm', 'YouTube Music'], ['spotify', 'Spotify'], ['deezer', 'Deezer']];

export async function newPlaylist() {
  const name = await promptDialog('Nouvelle playlist', { placeholder: 'Nom de la playlist', confirm: 'Créer' });
  if (!name) return;
  const p = data.createPlaylist(name);
  go(`#/p/${p.id}`);
}

export function parsePlaylistLink(input) {
  const s = String(input || '').trim();
  let m = s.match(/deezer\.com\/(?:[a-z]{2}\/)?playlist\/(\d+)/i);
  if (m) return { source: 'deezer', id: m[1] };
  m = s.match(/(?:youtube\.com|youtu\.be)\/.*[?&]list=([A-Za-z0-9_-]{10,})/i);
  if (m) return { source: 'ytm', id: m[1] };
  m = s.match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?playlist\/([A-Za-z0-9]+)/i);
  if (m) return { source: 'spotify', id: m[1] };
  return null;
}

export function viewLibrary(ctx, tab = 'playlists') {
  if (!TABS.some(([id]) => id === tab)) tab = 'playlists';
  const chips = h('nav.chips', { 'aria-label': 'Sections de la bibliothèque' }, TABS.map(([id, label]) => h('a.chip', {
    href: id === 'playlists' ? '#/library' : `#/library/${id}`,
    'aria-current': id === tab ? 'page' : null,
  }, ['ytm', 'spotify', 'deezer'].includes(id) ? sourceMark(id) : null, label)));
  const body = h('div');
  ctx.view.replaceChildren(h('div.page', {},
    tab === 'downloads' ? null : h('header.page-head', {}, h('h1.page-title', {}, 'Bibliothèque')),
    chips, body));
  if (tab === 'playlists') return drawPlaylists(ctx, body);
  if (tab === 'downloads') return drawDownloads(ctx, body);
  return drawSource(ctx, body, tab);
}

function drawPlaylists(ctx, body) {
  const draw = () => {
    const liked = data.likedTracks();
    const dls = downloads.list();
    const items = [
      { title: 'Titres « J’aime »', sub: `Playlist automatique • ${plural(liked.length, 'titre')}`, kind: 'liked', href: '#/liked', onPlay: liked.length ? () => playCollection({ source: 'liked', name: 'Titres « J’aime »' }) : null },
      { title: 'Téléchargements', sub: plural(dls.length, 'titre'), kind: 'downloads', href: '#/library/downloads', onPlay: dls.length ? () => playCollection({ source: 'downloads', name: 'Téléchargements' }) : null },
      ...data.playlists().map((p) => ({
        title: p.name,
        sub: `Playlist • ${plural(p.tracks.length, 'titre')}`,
        image: p.tracks.find((t) => t.artwork)?.artwork,
        href: `#/p/${p.id}`,
        onPlay: p.tracks.length ? () => playCollection({ source: 'local', id: p.id, name: p.name }) : null,
      })),
    ];
    const linkInput = h('input', { placeholder: 'Coller le lien d’une playlist YouTube Music, Spotify ou Deezer', 'aria-label': 'Lien de playlist', inputmode: 'url' });
    body.replaceChildren(
      h('div.page-head', {},
        h('button.btn.primary', { type: 'button', onClick: newPlaylist }, icon('plus'), 'Nouvelle playlist'),
        h('form.inline-form', {
          style: { flex: '1 1 340px', maxWidth: '560px' },
          onSubmit: (e) => {
            e.preventDefault();
            const target = parsePlaylistLink(linkInput.value);
            if (!target) { toast('Lien non reconnu. Collez le lien de partage d’une playlist.', 'error'); return; }
            go(`#/c/${target.source}/${encodeURIComponent(target.id)}`);
          },
        }, linkInput, h('button.btn', { type: 'submit' }, icon('link'), 'Ouvrir'))),
      h('div.grid-cards', {}, items.map(card)));
  };
  draw();
  ctx.on(data, 'change', draw);
  ctx.on(downloads, 'change', () => { clearTimeout(draw.t); draw.t = setTimeout(draw, 300); });
}

async function drawSource(ctx, body, source) {
  const me = data.user;
  const render = (lib, refreshing) => {
    const res = lib?.sources?.[source];
    const head = h('div.section-head', { style: { display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '16px', flexWrap: 'wrap' } },
      h('span.muted', { style: { fontSize: '13px', flex: '1' } }, lib ? `Mise à jour ${fmtAgo(lib.at)}` : ''),
      net.online ? h('button.btn.ghost', { type: 'button', disabled: refreshing, onClick: () => refresh() }, icon('refresh'), refreshing ? 'Actualisation…' : 'Actualiser') : null);
    if (!res && !lib) { body.replaceChildren(net.online ? loading() : errorBlock({ message: 'Bibliothèque indisponible hors connexion. Elle sera enregistrée sur cet appareil à la prochaine connexion.', status: 0 })); return; }
    if (!res) { body.replaceChildren(head); return; }
    if (res.error) {
      const linkable = res.code === 'not_linked';
      body.replaceChildren(head, h('div.empty', {}, sourceMark(source),
        h('p.empty-title', {}, linkable ? `Connectez votre compte ${SOURCE_NAMES[source]}` : `${SOURCE_NAMES[source]} est indisponible`),
        h('p.muted', {}, linkable ? 'Retrouvez vos playlists et vos titres favoris directement dans Nexify.' : res.error),
        linkable ? h('a.btn.primary', { href: '#/settings/services' }, 'Connecter') : null));
      return;
    }
    body.replaceChildren(head, h('div.grid-cards', {}, res.items.map((c) => card({
      title: c.name,
      sub: c.kind === 'liked' ? 'Playlist automatique' : [c.count != null ? plural(c.count, 'titre') : '', c.owner].filter(Boolean).join(' • ') || 'Playlist',
      image: c.image,
      kind: c.kind === 'liked' ? 'liked' : null,
      href: `#/c/${source}/${encodeURIComponent(c.id)}`,
      onPlay: () => playCollection({ source, id: c.id, name: c.name, image: c.image }),
    }))));
  };
  async function refresh() {
    render(data.library, true);
    try { await data.refreshLibrary(); } catch (e) { if (ctx.alive()) toast(e.message, 'error'); }
    if (ctx.alive()) render(data.library, false);
  }
  render(data.library, false);
  if (me && net.online && (!data.library || Date.now() - data.library.at > 5 * 60_000)) refresh();
}

function drawDownloads(ctx, body) {
  const draw = async () => {
    const list = downloads.list();
    const tracks = list.map((d) => d.track);
    const pendingJobs = [...downloads.jobs.values()];
    if (!ctx.alive()) return;
    const used = downloads.totalSize();
    const actions = [
      playButtons(tracks, { kind: 'downloads', name: 'Téléchargements', href: '#/library/downloads' }),
      list.length ? h('button.btn.ghost.danger', {
        type: 'button',
        onClick: async () => {
          if (await confirmDialog('Supprimer tous les téléchargements ?', 'Ces titres ne seront plus disponibles hors connexion. Vous pourrez les télécharger à nouveau.', 'Tout supprimer', { danger: true })) {
            await downloads.removeAll();
            toast('Téléchargements supprimés');
          }
        },
      }, icon('trash'), 'Tout supprimer') : null,
    ];
    data.visit({ source: 'downloads', id: 'all', kind: 'downloads', name: 'Téléchargements' });
    body.replaceChildren(
      collectionHead({ kind: 'downloads', kindLabel: 'Disponible hors connexion', title: 'Téléchargements', meta: list.length ? `${plural(list.length, 'titre')} • ${fmtSize(used)}` : plural(0, 'titre'), actions }),
      pendingJobs.length ? h('section.lib-section', { style: { marginTop: '24px' } },
        h('h2.sub', {}, `En cours (${pendingJobs.length})`),
        h('ul.tracks', {}, pendingJobs.map((j) => h('li.track', { style: { gridTemplateColumns: '48px minmax(0,1fr) auto 40px' } },
          h('div.track-lead', {}, h('div.art.art-empty', {}, icon('download'))),
          h('div.track-main', {}, h('span.track-title', {}, h('span.t', {}, j.track.title)), h('span.track-artists', {}, h('span.t', {}, j.status === 'error' ? j.error : j.status === 'active' ? `Téléchargement… ${Math.round((j.progress || 0) * 100)} %` : net.online ? 'En attente' : 'En attente de connexion'))),
          j.status === 'error' ? h('button.btn.ghost', { type: 'button', onClick: () => { downloads.jobs.delete(j.track.key); downloads.enqueue(j.track); } }, 'Réessayer') : h('span'),
          iconButton('close', 'Annuler', () => downloads.cancel(j.track.key)))))) : '',
      h('div', { style: { marginTop: '24px' } }, tracks.length
        ? trackList(tracks, { label: 'Téléchargements', context: { kind: 'downloads', name: 'Téléchargements', href: '#/library/downloads' }, onRemove: (i) => downloads.remove(tracks[i].key), removeLabel: 'Supprimer le téléchargement' })
        : h('div.empty', {}, icon('download'), h('p.empty-title', {}, 'Aucun téléchargement'),
          h('p.muted', {}, 'Téléchargez des titres ou des playlists entières pour les écouter sans connexion. Utilisez le bouton Télécharger d’une playlist ou le menu d’un titre.'))));
  };
  draw();
  let t;
  ctx.on(downloads, 'change', () => { clearTimeout(t); t = setTimeout(draw, 400); });
  ctx.on(net, 'change', draw);
}

export { player };
