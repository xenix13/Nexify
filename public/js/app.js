// Spotihome : interface principale (navigation, vues, barre de lecture)
import { get, post, patch, del, store, ApiError } from './api.js';
import { Player } from './player.js';
import { h, icon, iconButton, sourceMark, SOURCE_NAMES, fmtTime, fmtTotal, artwork, toast, modal, popMenu } from './ui.js';

const $ = (sel) => document.querySelector(sel);
const player = new Player();
const state = { me: null, signupOpen: false, firstRun: false, spotifyConfigured: false, local: [] };
let viewToken = 0;

// ================= démarrage et authentification =================
async function boot() {
  try {
    const me = await get('/api/me');
    Object.assign(state, { me: me.user, signupOpen: me.signupOpen, firstRun: me.firstRun, spotifyConfigured: me.spotifyConfigured });
  } catch (e) {
    $('#auth').hidden = false;
    $('#auth').replaceChildren(h('div.auth-card', {}, h('h1.brand', {}, 'Spotihome'), h('p.error', {}, e.message)));
    return;
  }
  if (!state.me) return showAuth();
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  await refreshLocal();
  renderPlayer();
  route();
}

function showAuth() {
  $('#shell').hidden = true;
  const auth = $('#auth');
  auth.hidden = false;
  let mode = state.firstRun ? 'signup' : 'login';
  const draw = () => {
    const err = h('p.error', { role: 'alert' });
    const form = h('form.auth-form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        try {
          await post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
          await boot();
        } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
      },
    },
    h('label.field', {}, h('span', {}, 'Nom d’utilisateur'), h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 2, maxlength: 32, autofocus: true })),
    h('label.field', {}, h('span', {}, 'Mot de passe'), h('input', { name: 'password', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: mode === 'signup' ? 8 : 1 })),
    err,
    h('button.btn.primary.wide', { type: 'submit' }, mode === 'signup' ? 'Créer le compte' : 'Se connecter'),
    state.signupOpen && !state.firstRun
      ? h('button.link', { type: 'button', onClick: () => { mode = mode === 'signup' ? 'login' : 'signup'; draw(); } }, mode === 'signup' ? 'J’ai déjà un compte' : 'Créer un compte')
      : null);
    auth.replaceChildren(h('div.auth-card', {},
      h('h1.brand', {}, 'Spotihome'),
      h('p.lede', {}, state.firstRun
        ? 'Premier lancement : crée le compte administrateur du foyer. Tu pourras ensuite ajouter les autres membres.'
        : 'Ta musique Spotify, Deezer et YouTube Music au même endroit.'),
      form));
  };
  draw();
}

async function refreshLocal() {
  try { state.local = (await get('/api/playlists')).playlists; } catch { state.local = []; }
  renderSidebarPlaylists();
}

// ================= navigation =================
function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs || '') };
}

function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }

window.addEventListener('hashchange', route);

function route() {
  if (!state.me) return;
  const { parts, query } = parseHash();
  const token = ++viewToken;
  const view = $('#view');
  view.scrollTop = 0;
  const [first, a, b] = parts;
  for (const link of document.querySelectorAll('[data-nav]')) {
    link.toggleAttribute('aria-current', link.dataset.nav === (first || 'search'));
  }
  const ctx = { token, view, query };
  if (!first || first === 'search') return viewSearch(ctx);
  if (first === 'library') return viewLibrary(ctx);
  if (first === 'c' && a && b) return viewCollection(ctx, a, b);
  if (first === 'p' && a) return viewLocal(ctx, a);
  if (first === 'queue') return viewQueue(ctx);
  if (first === 'settings') return viewSettings(ctx);
  view.replaceChildren(h('div.page', {}, h('h1.page-title', {}, 'Page introuvable'), h('a.btn', { href: '#/' }, 'Retour à la recherche')));
}

const alive = (ctx) => ctx.token === viewToken;
const loading = (label = 'Chargement…') => h('p.loading', { role: 'status' }, label);

function errorBlock(e, retry) {
  return h('div.notice.error', { role: 'alert' }, h('p', {}, e.message), retry ? h('button.btn', { type: 'button', onClick: retry }, 'Réessayer') : null);
}

// ================= liste de titres =================
const touch = window.matchMedia('(hover: none)');

function trackList(tracks, opts = {}) {
  const list = h('ol.tracks', { 'aria-label': opts.label || 'Titres' });
  tracks.forEach((t, i) => {
    const play = () => player.playList(tracks, i);
    const row = h('li.track', {
      dataset: { key: t.key },
      onDblclick: play,
      // sur écran tactile, un simple appui sur la ligne lance le titre
      onClick: (e) => { if (touch.matches && !e.target.closest('button')) play(); },
    },
      h('button.track-play', { type: 'button', 'aria-label': `Lire ${t.title}`, onClick: play },
        h('span.track-num', {}, String(i + 1)), icon('play')),
      artwork(t.artwork, '', 'sm'),
      h('div.track-main', {},
        h('span.track-title', {}, t.explicit ? h('span.explicit', { title: 'Explicite' }, 'E') : null, t.title),
        h('span.track-artists', {}, t.artists.join(', ') || 'Artiste inconnu')),
      h('span.track-album', {}, t.album),
      sourceMark(t.source),
      h('span.track-time', {}, t.duration ? fmtTime(t.duration) : ''),
      iconButton('more', `Actions pour ${t.title}`, (e) => trackMenu(e.currentTarget, t, i, opts)));
    list.append(row);
  });
  markCurrent(list);
  return list;
}

function markCurrent(root = document) {
  const key = player.current?.key;
  for (const row of root.querySelectorAll('.track')) row.classList.toggle('is-current', row.dataset.key === key);
}
player.addEventListener('track', () => markCurrent());

function openUrl(t) {
  if (t.source === 'spotify') return `https://open.spotify.com/track/${t.sourceId}`;
  if (t.source === 'deezer') return `https://www.deezer.com/track/${t.sourceId}`;
  return `https://music.youtube.com/watch?v=${t.sourceId}`;
}

function trackMenu(anchor, t, i, opts) {
  popMenu(anchor, [
    { icon: 'next', label: 'Lire ensuite', action: () => { player.enqueue(t, true); toast('Ajouté juste après le titre en cours'); } },
    { icon: 'queue', label: 'Ajouter à la file', action: () => { player.enqueue(t); toast('Ajouté à la file d’attente'); } },
    { icon: 'plus', label: 'Ajouter à une playlist…', action: () => addToPlaylist([t]) },
    opts.onRemove ? { icon: 'trash', label: 'Retirer de la playlist', action: () => opts.onRemove(i) } : null,
    { icon: 'external', label: `Ouvrir dans ${SOURCE_NAMES[t.source]}`, action: () => window.open(openUrl(t), '_blank', 'noopener') },
  ]);
}

function addToPlaylist(tracks) {
  const listBox = h('div.pick-list');
  const fill = () => listBox.replaceChildren(...(state.local.length
    ? state.local.map((p) => h('button.pick', {
      type: 'button',
      onClick: async () => {
        try {
          const r = await post(`/api/playlists/${p.id}/tracks`, { tracks });
          toast(r.added ? `${r.added} titre${r.added > 1 ? 's' : ''} ajouté${r.added > 1 ? 's' : ''} à « ${p.name} »` : `Déjà dans « ${p.name} »`);
          dlg.close();
          refreshLocal();
        } catch (e) { toast(e.message, 'error'); }
      },
    }, artwork(p.image, '', 'xs'), h('span', {}, p.name), h('span.muted', {}, `${p.count}`)))
    : [h('p.muted', {}, 'Aucune playlist pour l’instant.')]));
  fill();
  const nameInput = h('input', { name: 'name', placeholder: 'Nom de la nouvelle playlist', maxlength: 120 });
  const createForm = h('div.inline-form', {}, nameInput, h('button.btn', {
    type: 'button',
    onClick: async () => {
      if (!nameInput.value.trim()) { nameInput.focus(); return; }
      try {
        const { playlist } = await post('/api/playlists', { name: nameInput.value, tracks });
        toast(`Playlist « ${playlist.name} » créée`);
        dlg.close();
        refreshLocal();
      } catch (e) { toast(e.message, 'error'); }
    },
  }, 'Créer et ajouter'));
  const dlg = modal(tracks.length > 1 ? `Ajouter ${tracks.length} titres à…` : `Ajouter « ${tracks[0].title} » à…`, h('div', {}, listBox, createForm));
}

// ================= vue Recherche =================
const ALL_SOURCES = ['spotify', 'deezer', 'ytm'];

function viewSearch(ctx) {
  const q = ctx.query.get('q') || '';
  let sources = store.get('searchSources', ALL_SOURCES);
  const input = h('input.search-input', { type: 'search', name: 'q', value: q, placeholder: 'Un titre, un artiste, un album…', 'aria-label': 'Rechercher', autocomplete: 'off', enterkeyhint: 'search' });
  const results = h('div.results');
  const chips = h('div.chips', { role: 'group', 'aria-label': 'Sources' }, ALL_SOURCES.map((s) => h('button.chip', {
    type: 'button',
    'aria-pressed': String(sources.includes(s)),
    dataset: { source: s },
    onClick: (e) => {
      const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      const next = on ? [...sources, s] : sources.filter((x) => x !== s);
      if (!next.length) return;
      sources = ALL_SOURCES.filter((x) => next.includes(x));
      store.set('searchSources', sources);
      e.currentTarget.setAttribute('aria-pressed', String(on));
      if (input.value.trim()) run(input.value.trim());
    },
  }, sourceMark(s), SOURCE_NAMES[s])));

  const form = h('form.search', {
    role: 'search',
    onSubmit: (e) => {
      e.preventDefault();
      const v = input.value.trim();
      history.replaceState(null, '', v ? `#/search?q=${encodeURIComponent(v)}` : '#/');
      if (v) run(v);
    },
  }, icon('search'), input);

  ctx.view.replaceChildren(h('div.page', {},
    h('h1.page-title.visually-hidden', {}, 'Recherche'),
    form, chips, results));
  if (!q) results.append(emptySearch());
  else run(q);
  if (!q) input.focus();

  async function run(query) {
    results.replaceChildren(loading('Recherche en cours…'));
    let data;
    try {
      data = await get(`/api/search?q=${encodeURIComponent(query)}&sources=${sources.join(',')}`);
    } catch (e) { if (alive(ctx)) results.replaceChildren(errorBlock(e, () => run(query))); return; }
    if (!alive(ctx)) return;
    results.replaceChildren(...sources.map((s) => resultSection(s, query, data.results[s])));
  }

  function resultSection(source, query, res) {
    const head = h('header.section-head', {}, h('h2', {}, sourceMark(source), SOURCE_NAMES[source]));
    const sec = h(`section.result-group.group-${source}`, {}, head);
    if (!res) return sec;
    if (res.error) {
      const fixable = ['not_linked', 'not_configured'].includes(res.code);
      sec.append(h('p.notice', {}, res.error, fixable ? h('a.link', { href: '#/settings' }, ' Ouvrir les connexions') : null));
      return sec;
    }
    if (!res.tracks.length) { sec.append(h('p.muted', {}, 'Aucun résultat.')); return sec; }
    const tracks = res.tracks.slice();
    let list = trackList(tracks, { label: `Résultats ${SOURCE_NAMES[source]}` });
    sec.append(list);
    if (res.hasMore && source !== 'ytm') {
      let offset = tracks.length;
      const more = h('button.btn.ghost', {
        type: 'button',
        onClick: async () => {
          more.disabled = true;
          try {
            const d = await get(`/api/search?q=${encodeURIComponent(query)}&sources=${source}&offset=${offset}`);
            const r = d.results[source];
            tracks.push(...r.tracks);
            offset += r.tracks.length;
            const fresh = trackList(tracks, { label: `Résultats ${SOURCE_NAMES[source]}` });
            list.replaceWith(fresh);
            list = fresh;
            if (!r.hasMore) more.remove(); else more.disabled = false;
          } catch (e) { toast(e.message, 'error'); more.disabled = false; }
        },
      }, 'Plus de résultats');
      sec.append(more);
    }
    return sec;
  }
}

function emptySearch() {
  const p = state.me.providers;
  const missing = ALL_SOURCES.filter((s) => !p[s].linked);
  return h('div.empty', {},
    h('p.empty-title', {}, 'Cherche dans tes trois services en même temps.'),
    h('p.muted', {}, 'Les résultats arrivent groupés par source. Un titre Deezer ou Spotify se lit en entier via YouTube Music si besoin.'),
    missing.length ? h('p', {}, h('a.link', { href: '#/settings' }, `Relier ${missing.map((s) => SOURCE_NAMES[s]).join(', ')}`), ' pour retrouver aussi tes playlists.') : null);
}

// ================= vue Bibliothèque =================
async function viewLibrary(ctx) {
  const linkInput = h('input', { placeholder: 'Lien d’une playlist Deezer ou YouTube Music', 'aria-label': 'Lien de playlist', inputmode: 'url' });
  const linkForm = h('form.inline-form.open-link', {
    onSubmit: (e) => {
      e.preventDefault();
      const target = parsePlaylistLink(linkInput.value);
      if (!target) { toast('Lien non reconnu : colle un lien deezer.com/playlist/… ou music.youtube.com/playlist?list=…', 'error'); return; }
      go(`#/c/${target.source}/${encodeURIComponent(target.id)}`);
    },
  }, linkInput, h('button.btn', { type: 'submit' }, 'Ouvrir'));

  const body = h('div.library', {}, loading());
  ctx.view.replaceChildren(h('div.page', {},
    h('header.page-head', {}, h('h1.page-title', {}, 'Bibliothèque'), linkForm),
    body));

  let data;
  try { data = await get('/api/library'); } catch (e) { if (alive(ctx)) body.replaceChildren(errorBlock(e, () => viewLibrary(ctx))); return; }
  if (!alive(ctx)) return;
  state.local = data.local;
  renderSidebarPlaylists();

  const localSec = h('section.lib-section', {},
    h('header.section-head', {}, h('h2', {}, sourceMark('local'), 'Mes playlists Spotihome'),
      h('button.btn.ghost', { type: 'button', onClick: newPlaylist }, icon('plus'), 'Nouvelle playlist')),
    data.local.length
      ? tiles(data.local.map((p) => ({ ...p, href: `#/p/${p.id}` })))
      : h('p.muted', {}, 'Mélange des titres des trois services dans une même playlist, ou importe une playlist existante depuis sa page.'));

  const srcSecs = ALL_SOURCES.map((s) => {
    const res = data.sources[s];
    const sec = h(`section.lib-section.group-${s}`, {}, h('header.section-head', {}, h('h2', {}, sourceMark(s), SOURCE_NAMES[s])));
    if (res.error) {
      sec.append(res.code === 'not_linked'
        ? h('p.muted', {}, 'Compte non relié. ', h('a.link', { href: '#/settings' }, `Relier ${SOURCE_NAMES[s]}`))
        : h('p.notice', {}, res.error));
    } else {
      sec.append(tiles(res.items.map((c) => ({ ...c, href: `#/c/${s}/${encodeURIComponent(c.id)}` }))));
    }
    return sec;
  });
  body.replaceChildren(localSec, ...srcSecs);
}

function tiles(items) {
  return h('ul.tiles', {}, items.map((c) => h('li', {},
    h('a.tile', { href: c.href },
      c.kind === 'liked' ? h('div.art.art-liked', { 'aria-hidden': 'true' }, icon('heart')) : artwork(c.image, '', 'tile-art'),
      h('span.tile-name', {}, c.name),
      h('span.tile-meta', {}, [c.count != null ? `${c.count} titre${c.count > 1 ? 's' : ''}` : '', c.owner].filter(Boolean).join(', ') || ' ')))));
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

function newPlaylist() {
  const input = h('input', { name: 'name', required: true, maxlength: 120, placeholder: 'Ex. Dimanche matin', 'aria-label': 'Nom' });
  const dlg = modal('Nouvelle playlist', h('div', {}, input), [h('button.btn.primary', {
    type: 'button',
    onClick: async () => {
      if (!input.value.trim()) { input.focus(); return; }
      try {
        const { playlist } = await post('/api/playlists', { name: input.value });
        dlg.close();
        await refreshLocal();
        go(`#/p/${playlist.id}`);
      } catch (e) { toast(e.message, 'error'); }
    },
  }, 'Créer la playlist')]);
  input.focus();
}

// ================= vue d'une playlist d'un service =================
async function viewCollection(ctx, source, id) {
  ctx.view.replaceChildren(h('div.page', {}, loading()));
  let col;
  try { col = (await get(`/api/collection/${source}/${encodeURIComponent(id)}`)).collection; } catch (e) {
    if (!alive(ctx)) return;
    ctx.view.replaceChildren(h('div.page', {}, errorBlock(e, () => viewCollection(ctx, source, id))));
    return;
  }
  if (!alive(ctx)) return;
  const actions = [
    playButtons(col.tracks),
    h('button.btn.ghost', {
      type: 'button',
      onClick: async (e) => {
        e.currentTarget.disabled = true;
        try {
          const { playlist } = await post('/api/import', { source, id: col.id });
          toast(`Copiée dans Spotihome : « ${playlist.name} »`);
          await refreshLocal();
          go(`#/p/${playlist.id}`);
        } catch (ex) { toast(ex.message, 'error'); e.currentTarget.disabled = false; }
      },
    }, icon('import'), 'Copier dans Spotihome'),
    source === 'ytm' && !col.id.startsWith('LM') && !(state.me.providers.ytm.savedPlaylists || []).some((p) => p.id === col.id)
      ? h('button.btn.ghost', {
        type: 'button',
        onClick: async (e) => {
          try {
            const r = await post('/api/ytm/saved', { url: col.id });
            state.me = r.user;
            toast('Ajoutée à ta bibliothèque');
            e.currentTarget.remove();
          } catch (ex) { toast(ex.message, 'error'); }
        },
      }, icon('plus'), 'Garder dans la bibliothèque')
      : null,
  ];
  ctx.view.replaceChildren(h('div.page', {},
    collectionHead(col.image, col.name, [SOURCE_NAMES[source], col.owner, fmtTotal(col.tracks)].filter(Boolean).join(', '), source, actions),
    col.tracks.length ? trackList(col.tracks, { label: col.name }) : h('p.muted', {}, 'Cette playlist est vide.')));
}

function collectionHead(image, name, meta, source, actions) {
  return h('header.collection-head', {},
    artwork(image, '', 'cover'),
    h('div.collection-info', {},
      h('h1.collection-title', {}, name),
      h('p.collection-meta', {}, sourceMark(source), meta),
      h('div.collection-actions', {}, actions)));
}

function playButtons(tracks) {
  if (!tracks.length) return null;
  return [
    h('button.btn.primary', { type: 'button', onClick: () => { if (player.shuffle) player.toggleShuffle(); player.playList(tracks, 0); } }, icon('play'), 'Lire'),
    h('button.btn.ghost', {
      type: 'button',
      onClick: () => { if (!player.shuffle) player.toggleShuffle(); player.playList(tracks, Math.floor(Math.random() * tracks.length)); },
    }, icon('shuffle'), 'Aléatoire'),
  ];
}

// ================= vue d'une playlist Spotihome =================
async function viewLocal(ctx, id) {
  ctx.view.replaceChildren(h('div.page', {}, loading()));
  let p;
  try { p = (await get(`/api/playlists/${id}`)).playlist; } catch (e) {
    if (!alive(ctx)) return;
    ctx.view.replaceChildren(h('div.page', {}, errorBlock(e)));
    return;
  }
  if (!alive(ctx)) return;
  const draw = () => {
    const counts = ALL_SOURCES.map((s) => [s, p.tracks.filter((t) => t.source === s).length]).filter(([, n]) => n);
    const mix = counts.map(([s, n]) => `${n} ${SOURCE_NAMES[s]}`).join(', ');
    ctx.view.replaceChildren(h('div.page', {},
      collectionHead(p.tracks.find((t) => t.artwork)?.artwork, p.name, [fmtTotal(p.tracks), mix].filter(Boolean).join(', '), 'local', [
        playButtons(p.tracks),
        h('button.btn.ghost', { type: 'button', onClick: rename }, icon('edit'), 'Renommer'),
        h('button.btn.ghost.danger', { type: 'button', onClick: remove }, icon('trash'), 'Supprimer'),
      ]),
      p.tracks.length
        ? trackList(p.tracks, { label: p.name, onRemove: removeTrack })
        : h('div.empty', {}, h('p.empty-title', {}, 'Playlist vide.'), h('p.muted', {}, 'Ajoute des titres depuis la recherche avec le menu de chaque titre.'), h('a.btn', { href: '#/' }, 'Rechercher des titres'))));
  };
  async function save(changes) {
    try { p = (await patch(`/api/playlists/${p.id}`, changes)).playlist; draw(); refreshLocal(); } catch (e) { toast(e.message, 'error'); }
  }
  function removeTrack(i) { const tracks = p.tracks.slice(); tracks.splice(i, 1); save({ tracks }); }
  function rename() {
    const input = h('input', { value: p.name, maxlength: 120, 'aria-label': 'Nom' });
    const dlg = modal('Renommer la playlist', input, [h('button.btn.primary', { type: 'button', onClick: async () => { await save({ name: input.value }); dlg.close(); } }, 'Renommer')]);
    input.select();
  }
  function remove() {
    const dlg = modal('Supprimer la playlist ?', h('p', {}, `« ${p.name} » sera supprimée de Spotihome. Les titres restent disponibles sur leurs services.`), [
      h('button.btn.danger', {
        type: 'button',
        onClick: async () => {
          try { await del(`/api/playlists/${p.id}`); dlg.close(); await refreshLocal(); go('#/library'); } catch (e) { toast(e.message, 'error'); }
        },
      }, 'Supprimer'),
    ]);
  }
  draw();
}

// ================= vue File d'attente =================
function viewQueue(ctx) {
  const draw = () => {
    if (!alive(ctx)) return;
    const q = player.queue;
    const cur = player.current;
    const upcoming = q.slice(player.index + 1);
    const list = h('ol.tracks.queue', { 'aria-label': 'À suivre' }, upcoming.map((t, j) => {
      const i = player.index + 1 + j;
      return h('li.track', { dataset: { key: t.key } },
        h('button.track-play', { type: 'button', 'aria-label': `Lire ${t.title}`, onClick: () => player.playAt(i) }, h('span.track-num', {}, String(j + 1)), icon('play')),
        artwork(t.artwork, '', 'sm'),
        h('div.track-main', {}, h('span.track-title', {}, t.title), h('span.track-artists', {}, t.artists.join(', '))),
        h('span.track-album', {}, t.album),
        sourceMark(t.source),
        h('span.track-time', {}, t.duration ? fmtTime(t.duration) : ''),
        h('div.row-actions', {},
          j > 0 ? iconButton('up', 'Monter', () => player.move(i, i - 1)) : null,
          iconButton('close', 'Retirer de la file', () => player.removeAt(i))));
    }));
    ctx.view.replaceChildren(h('div.page', {},
      h('header.page-head', {}, h('h1.page-title', {}, 'File d’attente'),
        upcoming.length ? h('button.btn.ghost', { type: 'button', onClick: () => player.clearUpcoming() }, 'Vider la suite') : null),
      cur ? h('section.lib-section', {}, h('h2.sub', {}, 'En cours'), trackListStatic(cur)) : null,
      h('section.lib-section', {}, h('h2.sub', {}, 'À suivre'),
        upcoming.length ? list : h('p.muted', {}, cur ? 'Rien après ce titre.' : 'La file est vide. Lance un titre depuis la recherche ou une playlist.'))));
    markCurrent();
  };
  const onQ = () => { if (!alive(ctx)) { player.removeEventListener('queue', onQ); player.removeEventListener('track', onQ); return; } draw(); };
  player.addEventListener('queue', onQ);
  player.addEventListener('track', onQ);
  draw();
}

function trackListStatic(t) {
  return h('div.now-card', {}, artwork(t.artwork, '', 'md'),
    h('div.track-main', {}, h('span.track-title', {}, t.title), h('span.track-artists', {}, t.artists.join(', '))), sourceMark(t.source));
}

// ================= vue Réglages =================
function viewSettings(ctx) {
  const err = ctx.query.get('error');
  const linked = ctx.query.get('linked');
  if (err) toast(err, 'error');
  if (linked) toast(`${SOURCE_NAMES[linked]} est relié.`);
  if (err || linked) history.replaceState(null, '', '#/settings');
  const me = state.me;
  const P = me.providers;
  const setMe = (u) => { state.me = u; viewSettings({ ...ctx, query: new URLSearchParams() }); };
  const act = (fn) => async (e) => {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(); } catch (ex) { toast(ex.message, 'error'); if (btn) btn.disabled = false; }
  };

  const status = (on, name) => h(`p.status${on ? '.on' : ''}`, {}, on ? `Relié : ${name}` : 'Non relié');

  // --- Spotify
  const spotifyBody = !state.spotifyConfigured
    ? h('div', {},
      h('p', {}, 'Spotify n’est pas encore configuré sur le serveur.'),
      h('ol.steps', {},
        h('li', {}, 'Crée une appli sur ', h('a.link', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'developer.spotify.com/dashboard'), ' (API « Web API » et « Web Playback SDK »).'),
        h('li', {}, 'Ajoute cette URI de redirection : ', h('code', {}, P.spotify.redirectUri)),
        h('li', {}, 'Renseigne SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET dans le fichier .env, puis redémarre Spotihome.')))
    : h('div', {},
      status(P.spotify.linked, P.spotify.displayName),
      P.spotify.linked
        ? h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/spotify/unlink')).user)) }, 'Délier Spotify')
        : h('a.btn.primary', { href: '/api/spotify/login' }, 'Relier mon compte Spotify'),
      h('fieldset.choice', {}, h('legend', {}, 'Lecture des titres Spotify'),
        radio('spotifyPlayback', 'sdk', me.settings.spotifyPlayback, 'Avec Spotify, dans ce navigateur ou sur un appareil Spotify Connect (Premium)'),
        radio('spotifyPlayback', 'ytm', me.settings.spotifyPlayback, 'Avec la version YouTube Music du même titre')),
      h('p.hint', {}, 'En mode développement, Spotify limite l’appli à 5 comptes, à ajouter dans le tableau de bord développeur.'));

  // --- Deezer
  const dzInput = h('input', { placeholder: 'https://www.deezer.com/fr/profile/123456789', 'aria-label': 'Lien ou identifiant du profil Deezer' });
  const deezerBody = h('div', {},
    status(P.deezer.linked, P.deezer.displayName),
    P.deezer.linked
      ? h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/deezer/unlink')).user)) }, 'Délier Deezer')
      : h('form.inline-form', { onSubmit: (e) => { e.preventDefault(); act(async () => setMe((await post('/api/deezer/link', { profile: dzInput.value })).user))(); } },
        dzInput, h('button.btn.primary', { type: 'submit' }, 'Relier')),
    P.deezer.linked ? null : h('p.hint', {}, 'Dans Deezer, ouvre ton profil et copie son lien. Tes playlists et coups de cœur doivent être publics.'),
    h('fieldset.choice', {}, h('legend', {}, 'Lecture des titres Deezer'),
      radio('deezerPlayback', 'ytm', me.settings.deezerPlayback, 'Titre complet, via la version YouTube Music'),
      radio('deezerPlayback', 'preview', me.settings.deezerPlayback, 'Extrait Deezer de 30 secondes')));

  // --- YouTube Music
  const cookieInput = h('textarea', { rows: 3, placeholder: 'SID=…; HSID=…; SAPISID=…; …', 'aria-label': 'En-tête Cookie de music.youtube.com', spellcheck: 'false' });
  const saved = P.ytm.savedPlaylists || [];
  const ytmBody = h('div', {},
    status(P.ytm.linked, P.ytm.displayName),
    P.ytm.linked
      ? h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/ytm/unlink')).user)) }, 'Délier YouTube Music')
      : h('div', {},
        h('p', {}, 'La recherche et la lecture marchent sans compte. Pour retrouver ta bibliothèque, colle l’en-tête Cookie de music.youtube.com :'),
        h('ol.steps', {},
          h('li', {}, 'Ouvre music.youtube.com connecté, puis les outils de développement (F12), onglet Réseau.'),
          h('li', {}, 'Clique une requête « browse », copie la valeur de l’en-tête de requête « cookie ».'),
          h('li', {}, 'Colle-la ici. Elle est chiffrée sur le serveur et ne sert qu’à lire ta bibliothèque.')),
        h('form.stack', { onSubmit: (e) => { e.preventDefault(); act(async () => setMe((await post('/api/ytm/link', { cookie: cookieInput.value })).user))(); } },
          cookieInput, h('button.btn.primary', { type: 'submit' }, 'Relier YouTube Music'))),
    saved.length ? h('div', {}, h('h3.sub', {}, 'Playlists gardées par lien'), h('ul.plain', {}, saved.map((p) => h('li', {},
      h('a.link', { href: `#/c/ytm/${encodeURIComponent(p.id)}` }, p.name),
      iconButton('close', `Retirer ${p.name}`, act(async () => setMe((await del(`/api/ytm/saved/${encodeURIComponent(p.id)}`)).user))))))) : null);

  // --- compte
  const pwForm = h('form.stack', {
    onSubmit: (e) => {
      e.preventDefault();
      const fd = new FormData(pwForm);
      act(async () => { await post('/api/me/password', { current: fd.get('current'), password: fd.get('password') }); pwForm.reset(); toast('Mot de passe changé'); })();
    },
  },
  h('label.field', {}, h('span', {}, 'Mot de passe actuel'), h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
  h('label.field', {}, h('span', {}, 'Nouveau mot de passe'), h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
  h('button.btn', { type: 'submit' }, 'Changer le mot de passe'));

  const admin = me.isAdmin ? h('section.panel', {}, h('h2', {}, 'Comptes du foyer'), usersAdmin()) : null;

  ctx.view.replaceChildren(h('div.page.settings', {},
    h('h1.page-title', {}, 'Réglages'),
    h('div.panels', {},
      panel('spotify', spotifyBody),
      panel('deezer', deezerBody),
      panel('ytm', ytmBody)),
    h('div.panels', {},
      h('section.panel', {}, h('h2', {}, `Mon compte : ${me.username}`), pwForm,
        h('button.btn.ghost', { type: 'button', onClick: act(async () => { await post('/api/auth/logout'); location.hash = ''; location.reload(); }) }, 'Se déconnecter')),
      admin)));

  function radio(name, value, current, label) {
    return h('label.radio', {}, h('input', {
      type: 'radio',
      name,
      value,
      checked: value === current,
      onChange: act(async () => { state.me = (await patch('/api/me/settings', { [name]: value })).user; toast('Réglage enregistré'); }),
    }), h('span', {}, label));
  }
}

function panel(source, body) {
  return h(`section.panel.group-${source}`, {}, h('h2', {}, sourceMark(source), SOURCE_NAMES[source]), body);
}

function usersAdmin() {
  const box = h('div', {}, loading());
  const load = async () => {
    try {
      const { users } = await get('/api/users');
      const name = h('input', { name: 'username', placeholder: 'Nom', required: true, minlength: 2, maxlength: 32, 'aria-label': 'Nom du nouveau compte' });
      const pass = h('input', { name: 'password', type: 'password', placeholder: 'Mot de passe (8+)', required: true, minlength: 8, autocomplete: 'new-password', 'aria-label': 'Mot de passe du nouveau compte' });
      box.replaceChildren(
        h('ul.plain', {}, users.map((u) => h('li', {}, h('span', {}, u.username, u.isAdmin ? h('span.muted', {}, ' (admin)') : null),
          u.id === state.me.id ? null : iconButton('trash', `Supprimer ${u.username}`, async () => {
            const dlg = modal(`Supprimer ${u.username} ?`, h('p', {}, 'Ses playlists Spotihome et ses connexions seront effacées.'), [h('button.btn.danger', {
              type: 'button',
              onClick: async () => { try { await del(`/api/users/${u.id}`); dlg.close(); load(); } catch (e) { toast(e.message, 'error'); } },
            }, 'Supprimer')]);
          })))),
        h('form.inline-form', {
          onSubmit: async (e) => {
            e.preventDefault();
            try { await post('/api/users', { username: name.value, password: pass.value }); toast(`Compte ${name.value} créé`); load(); } catch (ex) { toast(ex.message, 'error'); }
          },
        }, name, pass, h('button.btn', { type: 'submit' }, 'Ajouter')));
    } catch (e) { box.replaceChildren(errorBlock(e, load)); }
  };
  load();
  return box;
}

// ================= barre latérale =================
function renderSidebarPlaylists() {
  const box = $('#side-playlists');
  if (!box) return;
  box.replaceChildren(...state.local.map((p) => h('li', {}, h('a.side-pl', { href: `#/p/${p.id}` }, p.name))));
}

// ================= barre de lecture =================
function renderPlayer() {
  const bar = $('#player');
  const art = h('div.np-art');
  const title = h('span.np-title', {}, 'Rien en lecture');
  const artists = h('span.np-artists', {}, ' ');
  const via = h('span.np-via');
  const srcBox = h('span.np-src');
  const playBtn = iconButton('play', 'Lecture', () => player.toggle(), { class: 'play-main' });
  const shuffleBtn = iconButton('shuffle', 'Lecture aléatoire', () => player.toggleShuffle());
  const repeatBtn = iconButton('repeat', 'Répéter', () => player.cycleRepeat());
  const seek = h('input.scale', { type: 'range', min: 0, max: 1000, value: 0, step: 1, 'aria-label': 'Position dans le titre' });
  const tNow = h('span.time', {}, '0:00');
  const tEnd = h('span.time', {}, '0:00');
  const vol = h('input.vol', { type: 'range', min: 0, max: 100, value: Math.round(player.volume * 100), 'aria-label': 'Volume' });
  const deviceBtn = iconButton('speaker', 'Choisir l’appareil Spotify', (e) => deviceMenu(e.currentTarget));
  let seeking = false;

  seek.addEventListener('input', () => { seeking = true; tNow.textContent = fmtTime((seek.value / 1000) * player.duration); });
  seek.addEventListener('change', () => { seeking = false; player.seek((seek.value / 1000) * player.duration); });
  vol.addEventListener('input', () => player.setVolume(vol.value / 100));

  bar.replaceChildren(
    h('div.np', {}, art, h('div.np-text', {}, h('div.np-line', {}, title), h('div.np-line.np-sub', {}, srcBox, artists, via))),
    h('div.transport', {},
      h('div.buttons', {}, shuffleBtn, iconButton('prev', 'Précédent', () => player.prev()), playBtn, iconButton('next', 'Suivant', () => player.next()), repeatBtn),
      h('div.dial', {}, tNow, seek, tEnd)),
    h('div.extras', {}, deviceBtn, h('a.icon-btn', { href: '#/queue', title: 'File d’attente', 'aria-label': 'File d’attente' }, icon('queue')), icon('volume'), vol));

  const update = () => {
    const t = player.current;
    title.textContent = t ? t.title : 'Rien en lecture';
    artists.textContent = t ? t.artists.join(', ') : ' ';
    srcBox.replaceChildren(t ? sourceMark(t.source) : '');
    const plan = player.plan;
    via.textContent = !t ? ''
      : player.loading ? 'Chargement…'
        : player.error ? 'Lecture impossible'
          : plan?.preview ? 'Extrait de 30 s'
            : plan?.via ? 'Lu via YouTube Music' : '';
    via.classList.toggle('is-error', Boolean(t && player.error && !player.loading));
    art.replaceChildren(artwork(t?.artwork, ''));
    playBtn.replaceChildren(icon(player.playing ? 'pause' : 'play'));
    playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
    playBtn.title = player.playing ? 'Pause' : 'Lecture';
    bar.classList.toggle('is-playing', player.playing);
    bar.classList.toggle('is-loading', player.loading);
    shuffleBtn.setAttribute('aria-pressed', String(player.shuffle));
    repeatBtn.setAttribute('aria-pressed', String(player.repeat !== 'off'));
    repeatBtn.replaceChildren(icon(player.repeat === 'one' ? 'repeat-one' : 'repeat'));
    repeatBtn.title = { off: 'Répéter : non', all: 'Répéter : toute la file', one: 'Répéter : ce titre' }[player.repeat];
    deviceBtn.hidden = !state.me.providers.spotify.linked;
    deviceBtn.classList.toggle('on', player.target !== 'browser');
    document.title = t && player.playing ? `${t.title} · Spotihome` : 'Spotihome';
    time();
  };
  const time = () => {
    if (seeking) return;
    const d = player.duration || 0;
    seek.value = d ? Math.round((player.position / d) * 1000) : 0;
    seek.style.setProperty('--p', `${d ? (player.position / d) * 100 : 0}%`);
    tNow.textContent = fmtTime(player.position);
    tEnd.textContent = fmtTime(d);
  };
  player.addEventListener('change', update);
  player.addEventListener('track', update);
  player.addEventListener('time', time);
  player.addEventListener('volume', () => { vol.value = Math.round(player.volume * 100); });
  player.addEventListener('notice', (e) => toast(e.detail, 'error'));
  update();
}

async function deviceMenu(anchor) {
  let devices = [];
  try { devices = await player.devices(); } catch (e) { toast(e.message, 'error'); }
  popMenu(anchor, [
    { icon: player.target === 'browser' ? 'check' : 'laptop', label: 'Ce navigateur', action: () => player.setTarget('browser') },
    ...devices.map((d) => ({ icon: player.target === d.id ? 'check' : 'speaker', label: `${d.name} (${d.type})`, action: () => player.setTarget(d.id) })),
    devices.length ? null : { icon: 'refresh', label: 'Aucun autre appareil : ouvre Spotify sur l’enceinte ou le téléphone', action: () => {} },
  ]);
}

// raccourcis clavier : espace = lecture/pause, Maj+flèches = titre précédent/suivant
document.addEventListener('keydown', (e) => {
  if (!state.me || e.target.closest('input, textarea, select, button, [contenteditable]') || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space') { e.preventDefault(); player.toggle(); }
  if (e.shiftKey && e.key === 'ArrowRight') player.next();
  if (e.shiftKey && e.key === 'ArrowLeft') player.prev();
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError) { toast(e.reason.message, 'error'); e.preventDefault(); }
});

boot();
