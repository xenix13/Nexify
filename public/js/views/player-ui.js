// Barre de lecture (bas de l'écran) et vue « Lecture en cours » (plein écran).
import { h, icon, iconButton, setIcon, sourceMark, fmtTime, artwork, toast, popMenu, dominantColor } from '../ui.js';
import { net, post } from '../api.js';
import { player } from '../player.js';
import { data } from '../data.js';
import { prefs } from '../prefs.js';
import { trackList, trackMenu, refreshRows } from '../components.js';

const narrow = window.matchMedia('(max-width: 760px)');

function statusTag() {
  const t = player.current;
  if (!t) return '';
  if (player.loading) return ['Chargement…', ''];
  if (player.error) return ['Lecture impossible', 'err'];
  if (player.plan?.offline) return ['Téléchargé', ''];
  if (player.plan?.preview) return ['Extrait de 30 s', ''];
  return '';
}

function rangeSync(input, value, max) {
  input.max = String(Math.max(1, Math.round(max * 10)));
  input.value = String(Math.round(value * 10));
  input.style.setProperty('--p', `${max ? Math.min(100, (value / max) * 100) : 0}%`);
}

function seekRange(label) {
  const input = h('input', { type: 'range', min: 0, max: 1, step: 1, value: 0, 'aria-label': label });
  input._seeking = false;
  input.addEventListener('input', () => {
    input._seeking = true;
    input.style.setProperty('--p', `${(input.value / input.max) * 100}%`);
    input.dispatchEvent(new CustomEvent('preview', { detail: input.value / 10 }));
  });
  input.addEventListener('change', () => { input._seeking = false; player.seek(input.value / 10); });
  return input;
}

// ---------------------------------------------------------------- barre de lecture
export function renderPlayerBar(bar, np) {
  const art = h('button.pb-art-btn', { type: 'button', 'aria-label': 'Ouvrir la lecture en cours', onClick: () => np.toggle() });
  const title = h('span.pb-title');
  const sub = h('span.pb-sub');
  const playBtn = iconButton('play', 'Lecture', () => player.toggle(), { class: 'play-main' });
  const prevBtn = iconButton('prev', 'Précédent', () => player.prev(), { class: 'pb-prev' });
  const nextBtn = iconButton('next', 'Suivant', () => player.next());
  const time = h('span.pb-time');
  const likeBtn = iconButton('like', 'J’aime', () => { const t = player.current; if (t) data.toggleLike(t); }, { class: 'pb-like' });
  const moreBtn = iconButton('more', 'Plus d’actions', (e) => { const t = player.current; if (t) trackMenu(e.currentTarget, t, player.index); }, { class: 'pb-more' });
  const muteBtn = iconButton('volume', 'Couper le son', () => player.toggleMute());
  const vol = h('input', { type: 'range', min: 0, max: 100, value: Math.round(player.volume * 100), 'aria-label': 'Volume' });
  const repeatBtn = iconButton('repeat', 'Répéter', () => player.cycleRepeat());
  const shuffleBtn = iconButton('shuffle', 'Lecture aléatoire', () => player.toggleShuffle());
  const deviceBtn = iconButton('speaker', 'Appareil Spotify', (e) => deviceMenu(e.currentTarget));
  const expandBtn = iconButton('up', 'Lecture en cours', () => np.toggle(), { class: 'pb-expand' });
  const seek = seekRange('Position dans le titre');
  seek.addEventListener('preview', (e) => { time.textContent = `${fmtTime(e.detail)} / ${fmtTime(player.duration)}`; });
  vol.addEventListener('input', () => { player.setVolume(vol.value / 100); paintVol(); });
  const paintVol = () => vol.style.setProperty('--p', `${vol.value}%`);
  paintVol();

  bar.replaceChildren(
    h('div.pb-progress', {}, seek),
    h('div.pb-left', {}, prevBtn, playBtn, nextBtn, time),
    h('div.pb-info', {}, art, h('div.pb-text', { onClick: () => np.toggle() }, title, sub), likeBtn, moreBtn),
    h('div.pb-right', {}, h('div.pb-vol.only-desktop', {}, muteBtn, vol), repeatBtn, shuffleBtn, deviceBtn, expandBtn));

  let lastArt = null;
  const update = () => {
    const t = player.current;
    bar.classList.toggle('empty', !t);
    document.body.classList.toggle('has-player', Boolean(t));
    if (!t) return;
    title.textContent = t.title;
    const tag = statusTag();
    sub.replaceChildren(
      sourceMark(t.source),
      h('span', {}, [t.artists.join(', '), t.album].filter(Boolean).join(' • ')),
      tag ? h(`span.tag${tag[1] ? `.${tag[1]}` : ''}`, {}, `• ${tag[0]}`) : '');
    if (lastArt !== t.artwork) { lastArt = t.artwork; art.replaceChildren(artwork(t.artwork)); }
    setIcon(playBtn, player.playing ? 'pause' : 'play');
    playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
    playBtn.title = player.playing ? 'Pause' : 'Lecture';
    bar.classList.toggle('is-loading', player.loading);
    shuffleBtn.setAttribute('aria-pressed', String(player.shuffle));
    repeatBtn.setAttribute('aria-pressed', String(player.repeat !== 'off'));
    setIcon(repeatBtn, player.repeat === 'one' ? 'repeat-one' : 'repeat');
    repeatBtn.title = { off: 'Répéter : désactivé', all: 'Répéter : toute la file', one: 'Répéter : ce titre' }[player.repeat];
    const liked = data.isLiked(t.key);
    setIcon(likeBtn, liked ? 'liked' : 'like');
    likeBtn.classList.toggle('on', liked);
    deviceBtn.hidden = !(data.user?.providers?.spotify?.linked && data.user?.settings?.spotifyPlayback === 'sdk');
    deviceBtn.classList.toggle('on', player.target !== 'browser');
    document.title = player.playing ? `${t.title} • ${t.artists[0] || 'Nexify'}` : 'Nexify';
    tick();
  };
  const tick = () => {
    if (seek._seeking) return;
    rangeSync(seek, player.position, player.duration || player.current?.duration || 0);
    time.textContent = `${fmtTime(player.position)} / ${fmtTime(player.duration || player.current?.duration || 0)}`;
  };
  const volUpdate = () => {
    vol.value = Math.round((player.muted ? 0 : player.volume) * 100);
    paintVol();
    setIcon(muteBtn, player.muted || player.volume === 0 ? 'volume-off' : 'volume');
  };
  player.addEventListener('change', update);
  player.addEventListener('track', update);
  player.addEventListener('time', tick);
  player.addEventListener('volume', volUpdate);
  data.addEventListener('change', update);
  data.addEventListener('user', update);
  update();
  volUpdate();
}

async function deviceMenu(anchor) {
  let devices = [];
  try { devices = await player.devices(); } catch (e) { toast(e.message, 'error'); }
  popMenu(anchor, [
    { icon: player.target === 'browser' ? 'check' : 'laptop', label: 'Cet appareil', action: () => player.setTarget('browser') },
    ...devices.map((d) => ({ icon: player.target === d.id ? 'check' : 'speaker', label: `${d.name} (${d.type})`, action: () => player.setTarget(d.id) })),
    devices.length ? null : { icon: 'refresh', label: 'Aucun autre appareil. Ouvrez Spotify sur l’enceinte ou le téléphone.', action: () => {} },
  ]);
}

// ---------------------------------------------------------------- lecture en cours
export function createNowPlaying(el, shell) {
  let open = false;
  let tab = 'queue';
  const related = new Map(); // key -> { tracks } | { error }

  const cover = h('div.np-stage');
  const ctxLabel = h('div.ctx');
  const tTitle = h('h2');
  const tArtist = h('p');
  const like = iconButton('like', 'J’aime', () => { const t = player.current; if (t) data.toggleLike(t); });
  const seek = seekRange('Position dans le titre');
  const tNow = h('span');
  const tEnd = h('span');
  seek.addEventListener('preview', (e) => { tNow.textContent = fmtTime(e.detail); });
  const play = iconButton('play', 'Lecture', () => player.toggle(), { class: 'np-play' });
  const shuffle = iconButton('shuffle', 'Lecture aléatoire', () => player.toggleShuffle());
  const repeat = iconButton('repeat', 'Répéter', () => player.cycleRepeat());
  const tabs = h('div.np-tabs', { role: 'tablist' });
  const panel = h('div.np-panel', { role: 'tabpanel' });

  el.replaceChildren(
    h('div.np-head', {},
      iconButton('down', 'Fermer', () => api.close()),
      ctxLabel,
      iconButton('more', 'Plus d’actions', (e) => { const t = player.current; if (t) trackMenu(e.currentTarget, t, player.index); })),
    cover,
    h('div.np-controls', {},
      h('div.np-titles', {}, h('div', {}, tTitle, tArtist), like),
      seek,
      h('div.np-times', {}, tNow, tEnd),
      h('div.np-buttons', {}, shuffle, iconButton('prev', 'Précédent', () => player.prev()), play, iconButton('next', 'Suivant', () => player.next()), repeat)),
    h('div.np-side', {}, tabs, panel));

  const drawTabs = () => {
    tabs.replaceChildren(...[['queue', 'À suivre'], ['related', 'Similaires']].map(([id, label]) => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(tab === id), onClick: () => { tab = id; drawTabs(); drawPanel(); },
    }, label)));
  };

  const drawPanel = () => {
    if (!open) return;
    const t = player.current;
    if (!t) { panel.replaceChildren(h('p.muted', { style: { padding: '16px 12px' } }, 'Aucun titre en cours.')); return; }
    if (tab === 'queue') {
      const base = player.index + 1;
      const upcoming = player.queue.slice(base, base + 200);
      const ctxName = player.context?.name;
      panel.replaceChildren(
        ctxName ? h('div.np-context', {}, 'Lecture depuis ', player.context.href ? h('a', { href: player.context.href }, h('b', {}, ctxName)) : h('b', {}, ctxName)) : '',
        trackList([t], { label: 'En cours', onPlay: () => player.toggle() }),
        upcoming.length
          ? h('div', {},
            h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 12px 4px' } },
              h('b', { style: { fontSize: '14px' } }, 'À suivre'),
              h('button.link', { type: 'button', onClick: () => player.clearUpcoming() }, 'Vider')),
            trackList(upcoming, {
              label: 'À suivre',
              count: player.queue.length - base,
              onPlay: (i) => player.playAt(base + i),
              onRemove: (i) => player.removeAt(base + i),
              removeLabel: 'Retirer de la file d’attente',
              onMove: (i, dir) => player.move(base + i, base + i + dir),
            }))
          : h('p.muted', { style: { padding: '12px' } }, prefs.get('autoplay') && net.online ? 'Des titres similaires seront ajoutés automatiquement à la fin de la file.' : 'Aucun autre titre dans la file d’attente.'));
      return;
    }
    // titres similaires (radio YouTube Music)
    if (!net.online) { panel.replaceChildren(h('p.muted', { style: { padding: '16px 12px' } }, 'Les suggestions nécessitent une connexion au serveur.')); return; }
    const r = related.get(t.key);
    if (!r) {
      panel.replaceChildren(h('p.loading', {}, 'Recherche de titres similaires…'));
      related.set(t.key, { pending: true });
      post('/api/radio', { track: t }).then(({ tracks }) => related.set(t.key, { tracks }))
        .catch((e) => related.set(t.key, { error: e.message }))
        .finally(() => { if (player.current?.key === t.key && tab === 'related') drawPanel(); });
      return;
    }
    if (r.pending) return;
    if (r.error) { panel.replaceChildren(h('p.muted', { style: { padding: '16px 12px' } }, r.error)); return; }
    panel.replaceChildren(trackList(r.tracks, { label: 'Titres similaires', context: { kind: 'radio', name: `Radio : ${t.title}` } }));
  };

  let lastKey = null;
  const update = () => {
    const t = player.current;
    if (!t) { if (open) api.close(); return; }
    if (lastKey !== t.key) {
      lastKey = t.key;
      const img = artwork(t.artwork, 'np-cover', `Pochette de ${t.title}`);
      cover.replaceChildren(img);
      tint(t);
      if (open) drawPanel();
    }
    tTitle.textContent = t.title;
    tArtist.textContent = t.artists.join(', ');
    ctxLabel.replaceChildren('Lecture en cours', player.context?.name ? h('b', {}, player.context.name) : '');
    setIcon(play, player.playing ? 'pause' : 'play');
    play.setAttribute('aria-label', player.playing ? 'Pause' : 'Lecture');
    shuffle.setAttribute('aria-pressed', String(player.shuffle));
    repeat.setAttribute('aria-pressed', String(player.repeat !== 'off'));
    setIcon(repeat, player.repeat === 'one' ? 'repeat-one' : 'repeat');
    const liked = data.isLiked(t.key);
    setIcon(like, liked ? 'liked' : 'like');
    like.classList.toggle('on', liked);
    tick();
  };
  const tick = () => {
    if (!open || seek._seeking) return;
    const d = player.duration || player.current?.duration || 0;
    rangeSync(seek, player.position, d);
    tNow.textContent = fmtTime(player.position);
    tEnd.textContent = fmtTime(d);
  };

  async function tint(t) {
    if (!prefs.get('dynamicColor')) { el.style.removeProperty('--np-tint'); return; }
    const c = await dominantColor(t.artwork);
    if (player.current?.key !== t.key) return;
    if (!c) { el.style.removeProperty('--np-tint'); return; }
    const light = document.documentElement.dataset.theme === 'light';
    const [r, g, b] = light ? c.map((v) => Math.round(v * 0.45 + 255 * 0.55)) : c.map((v) => Math.round(v * 0.5));
    el.style.setProperty('--np-tint', `rgb(${r}, ${g}, ${b})`);
  }

  let queueTimer;
  const onQueue = () => { if (open && tab === 'queue') { clearTimeout(queueTimer); queueTimer = setTimeout(drawPanel, 120); } };
  player.addEventListener('change', update);
  player.addEventListener('track', () => { update(); onQueue(); });
  player.addEventListener('queue', onQueue);
  player.addEventListener('time', tick);
  data.addEventListener('change', update);
  prefs.addEventListener('change', (e) => { if (e.detail.key === 'dynamicColor' || e.detail.key === 'theme') { const t = player.current; if (t) tint(t); } });

  let pushed = false;
  const api = {
    get open() { return open; },
    show() {
      if (!player.current || open) return;
      open = true;
      el.classList.add('open');
      el.setAttribute('aria-hidden', 'false');
      shell.classList.add('np-open');
      drawTabs();
      update();
      drawPanel();
      refreshRows(el);
      if (narrow.matches) { history.pushState({ np: true }, ''); pushed = true; }
    },
    close(fromPop = false) {
      if (!open) return;
      open = false;
      el.classList.remove('open');
      el.setAttribute('aria-hidden', 'true');
      shell.classList.remove('np-open');
      if (pushed && !fromPop) { pushed = false; history.back(); }
      pushed = false;
    },
    toggle() { if (open) api.close(); else api.show(); },
  };
  window.addEventListener('popstate', () => { if (open) api.close(true); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('dialog[open], .menu')) api.close(); });
  update();
  return api;
}
