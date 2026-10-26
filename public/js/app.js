// Nexify : démarrage, connexion, navigation, coquille de l'appli.
// L'appli démarre toujours depuis les données de l'appareil ; le serveur n'est sollicité
// que pour la première connexion, la synchronisation et la lecture en ligne.
import { get, post, net, unauthorized, ApiError } from './api.js';
import { native } from './native.js';
import { h, icon, toast, popMenu, closeMenus } from './ui.js';
import { prefs } from './prefs.js';
import { data } from './data.js';
import { downloads } from './downloads.js';
import { player } from './player.js';
import { install } from './install.js';
import { go } from './components.js';
import { viewHome, viewHistory } from './views/home.js';
import { viewSearch } from './views/search.js';
import { viewLibrary, newPlaylist } from './views/library.js';
import { viewCollection, viewLocal, viewLiked } from './views/collection.js';
import { viewSettings, logout } from './views/settings.js';
import { renderPlayerBar, createNowPlaying } from './views/player-ui.js';

const $ = (sel) => document.querySelector(sel);
let np = null;
let shellReady = false;

// ================= apparence =================
const systemLight = window.matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const pref = prefs.get('theme');
  const theme = pref === 'system' ? (systemLight.matches ? 'light' : 'dark') : pref;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#f7f7f7' : '#000000');
  document.body.classList.toggle('hide-sources', !prefs.get('showSources'));
}
systemLight.addEventListener('change', applyTheme);
prefs.addEventListener('change', (e) => { if (['theme', 'showSources'].includes(e.detail.key)) applyTheme(); });

// ================= démarrage =================
async function boot() {
  applyTheme();
  if (!native.isNative) registerServiceWorker();
  await native.init();
  await Promise.all([data.load(), downloads.load()]);
  if (native.isNative && !native.server) {
    // appli Android / PC : adresse du serveur Nexify demandée une seule fois
    hideSplash();
    showServerSetup();
    return;
  }
  if (data.user) {
    // profil connu sur cet appareil : l'appli s'ouvre tout de suite, même sans serveur
    showShell();
    hideSplash();
    refreshFromServer();
    return;
  }
  // première connexion sur cet appareil : le serveur est indispensable
  let me;
  try {
    me = await get('/api/me', { timeout: 15_000 });
  } catch (e) {
    hideSplash();
    showUnreachable(e);
    return;
  }
  data.meta = { signupOpen: me.signupOpen, firstRun: me.firstRun, spotifyConfigured: me.spotifyConfigured, version: me.version };
  hideSplash();
  if (!me.user) { showAuth(); return; }
  await data.setUser(me.user, data.meta);
  await data.sync();
  showShell();
  data.refreshLibrary().catch(() => {});
}

function hideSplash() {
  const s = $('#splash');
  if (!s) return;
  s.classList.add('out');
  setTimeout(() => s.remove(), 400);
}

async function refreshFromServer() {
  try {
    const me = await get('/api/me', { timeout: 15_000 });
    data.meta = { ...data.meta, signupOpen: me.signupOpen, spotifyConfigured: me.spotifyConfigured, version: me.version };
    if (!me.user) { sessionExpired(); return; }
    await data.setUser(me.user, data.meta);
    await data.sync();
  } catch {
    /* hors connexion : l'appli continue avec les données de l'appareil */
  }
}

function showUnreachable(e) {
  const auth = $('#auth');
  auth.hidden = false;
  $('#shell').hidden = true;
  auth.replaceChildren(h('div.auth-card', {},
    h('img.auth-logo', { src: '/icons/logo.png', alt: '' }),
    h('h1.auth-title', {}, 'Nexify'),
    h('p.auth-lede', {}, e instanceof ApiError && e.status ? e.message : 'Impossible de joindre le serveur Nexify. Une connexion est nécessaire lors de la première ouverture.'),
    h('button.btn.primary.lg.wide', { type: 'button', onClick: () => { auth.replaceChildren(h('p.loading', {}, 'Connexion…')); boot(); } }, 'Réessayer'),
    native.isNative ? h('p.auth-switch', {}, `Serveur : ${native.server} `, h('button.link', { type: 'button', onClick: () => showServerSetup() }, 'Modifier')) : null));
}

// Appli Android / PC : adresse du serveur Nexify (connexion et synchronisation uniquement)
function showServerSetup() {
  const auth = $('#auth');
  auth.hidden = false;
  $('#shell').hidden = true;
  const err = h('p.error', { role: 'alert' });
  const input = h('input', { type: 'text', name: 'server', value: native.server, placeholder: 'https://musique.mondomaine.fr', required: true, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', inputmode: 'url' });
  const form = h('form.auth-form', {
    onSubmit: async (e) => {
      e.preventDefault();
      let url = input.value.trim().replace(/\/+$/, '');
      if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true;
      err.textContent = '';
      try {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 8000);
        const r = await fetch(`${url}/api/health`, { signal: ac.signal, cache: 'no-store' });
        const body = await r.json();
        if (!body.ok) throw new Error();
        native.setServer(url);
        net.check();
        auth.replaceChildren(h('p.loading', {}, 'Connexion…'));
        boot();
      } catch {
        err.textContent = 'Aucun serveur Nexify ne répond à cette adresse. Vérifiez l’adresse et que l’appareil est sur le bon réseau.';
        btn.disabled = false;
      }
    },
  },
  h('label.field', {}, h('span', {}, 'Adresse du serveur Nexify'), input),
  h('p.hint', {}, 'Le serveur ne sert qu’à la connexion et à la synchronisation de vos playlists et titres « J’aime ». La musique est récupérée directement par cet appareil.'),
  err,
  h('button.btn.primary.lg.wide', { type: 'submit' }, 'Continuer'));
  auth.replaceChildren(h('div.auth-card', {},
    h('img.auth-logo', { src: '/icons/logo.png', alt: '' }),
    h('h1.auth-title', {}, 'Bienvenue sur Nexify'),
    h('p.auth-lede', {}, 'Indiquez l’adresse de votre serveur pour vous connecter.'),
    form));
  input.focus();
}

function sessionExpired() {
  toast('Votre session a expiré. Reconnectez-vous pour synchroniser vos données.', 'info', { label: 'Se reconnecter', fn: () => showAuth(true), sticky: true });
}
unauthorized.addEventListener('expired', () => { if (data.user && shellReady) sessionExpired(); });

// ================= connexion =================
function showAuth(reconnect = false) {
  $('#shell').hidden = true;
  const auth = $('#auth');
  auth.hidden = false;
  let mode = data.meta.firstRun ? 'signup' : 'login';
  const draw = () => {
    const err = h('p.error', { role: 'alert' });
    const form = h('form.auth-form', {
      onSubmit: async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const btn = form.querySelector('button[type=submit]');
        btn.disabled = true;
        err.textContent = '';
        try {
          const r = await post(mode === 'signup' ? '/api/auth/signup' : '/api/auth/login', { username: fd.get('username'), password: fd.get('password') });
          data.meta.firstRun = false;
          if (r.token) native.setToken(r.token);
          await data.setUser(r.user, data.meta);
          btn.textContent = 'Synchronisation…';
          await data.sync();
          auth.hidden = true;
          if (shellReady) { $('#shell').hidden = false; route(); } else showShell();
          data.refreshLibrary().catch(() => {});
        } catch (ex) {
          err.textContent = ex.message;
          btn.disabled = false;
        }
      },
    },
    h('label.field', {}, h('span', {}, 'Nom d’utilisateur'), h('input', { name: 'username', autocomplete: 'username', required: true, minlength: 2, maxlength: 32, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false', value: reconnect ? data.user?.username || '' : '' })),
    h('label.field', {}, h('span', {}, 'Mot de passe'), h('input', { name: 'password', type: 'password', autocomplete: mode === 'signup' ? 'new-password' : 'current-password', required: true, minlength: mode === 'signup' ? 8 : 1 })),
    err,
    h('button.btn.primary.lg.wide', { type: 'submit' }, mode === 'signup' ? 'Créer le compte' : 'Se connecter'));
    auth.replaceChildren(h('div.auth-card', {},
      h('img.auth-logo', { src: '/icons/logo.png', alt: '' }),
      h('h1.auth-title', {}, mode === 'signup' && data.meta.firstRun ? 'Bienvenue sur Nexify' : 'Nexify'),
      h('p.auth-lede', {}, data.meta.firstRun
        ? 'Créez le compte administrateur. Vous pourrez ensuite ajouter d’autres utilisateurs depuis les paramètres.'
        : reconnect ? 'Reconnectez-vous pour reprendre la synchronisation.' : 'Connectez-vous pour retrouver votre musique.'),
      form,
      data.meta.signupOpen && !data.meta.firstRun
        ? h('p.auth-switch', {}, mode === 'signup' ? 'Vous avez déjà un compte ? ' : 'Pas encore de compte ? ',
          h('button.link', { type: 'button', onClick: () => { mode = mode === 'signup' ? 'login' : 'signup'; draw(); } }, mode === 'signup' ? 'Se connecter' : 'Créer un compte'))
        : null,
      reconnect ? h('p.auth-switch', {}, h('button.link', { type: 'button', onClick: () => { auth.hidden = true; $('#shell').hidden = false; } }, 'Continuer sans synchroniser')) : null));
    form.querySelector(reconnect ? 'input[name=password]' : 'input')?.focus();
  };
  draw();
}

// ================= coquille =================
function showShell() {
  $('#auth').hidden = true;
  $('#shell').hidden = false;
  if (!shellReady) {
    shellReady = true;
    np = createNowPlaying($('#np'), $('#shell'));
    renderPlayerBar($('#player'), np);
    wireShell();
  }
  if (!location.hash && prefs.get('startPage') === 'library') history.replaceState(null, '', '#/library');
  route();
}

function wireShell() {
  // recherche du haut (ordinateur)
  const q = $('#top-q');
  let typing;
  $('#top-search').addEventListener('submit', (e) => {
    e.preventDefault();
    clearTimeout(typing);
    const v = q.value.trim();
    go(v ? `#/search?q=${encodeURIComponent(v)}` : '#/search');
  });
  q.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => {
      const v = q.value.trim();
      if (v.length >= 2) history.replaceState(null, '', `#/search?q=${encodeURIComponent(v)}`), route();
    }, 550);
  });
  $('#side-new').addEventListener('click', newPlaylist);
  $('#avatar').addEventListener('click', (e) => accountMenu(e.currentTarget));

  const pill = $('#net-pill');
  const netUpdate = () => { pill.hidden = net.online; document.body.classList.toggle('is-offline', !net.online); };
  net.addEventListener('change', () => {
    netUpdate();
    toast(net.online ? 'Connexion au serveur rétablie' : 'Vous êtes hors connexion. Vos téléchargements restent disponibles.');
  });
  netUpdate();

  const side = () => {
    const box = $('#side-playlists');
    const cur = location.hash;
    box.replaceChildren(
      h('li', {}, h('a.side-pl', { href: '#/liked', 'aria-current': cur === '#/liked' ? 'page' : null }, h('b', {}, 'Titres « J’aime »'), h('small', {}, 'Playlist automatique'))),
      ...data.playlists().map((p) => h('li', {}, h('a.side-pl', { href: `#/p/${p.id}`, 'aria-current': cur === `#/p/${p.id}` ? 'page' : null }, h('b', {}, p.name), h('small', {}, `${p.tracks.length} titre${p.tracks.length > 1 ? 's' : ''}`)))));
    const avatar = $('#avatar .avatar');
    avatar.textContent = (data.user?.username || '?')[0];
  };
  data.addEventListener('change', side);
  data.addEventListener('user', side);
  window.addEventListener('hashchange', side);
  side();

  player.addEventListener('notice', (e) => toast(e.detail, 'error'));
}

function accountMenu(anchor) {
  const u = data.user;
  popMenu(anchor, [
    { icon: 'settings', label: 'Paramètres', action: () => go('#/settings') },
    { icon: 'eq', label: 'Égaliseur', action: () => go('#/settings/equalizer') },
    { icon: 'history', label: 'Historique', action: () => go('#/history') },
    { icon: 'download', label: 'Téléchargements', action: () => go('#/library/downloads') },
    net.online ? { icon: 'refresh', label: 'Synchroniser maintenant', action: async () => { const ok = await data.sync(); toast(ok ? 'Synchronisation terminée' : 'Synchronisation impossible pour le moment.', ok ? 'info' : 'error'); } } : null,
    install.state() === 'prompt' ? { icon: 'plus', label: 'Installer l’application', action: () => install.prompt() } : null,
    '-',
    { icon: 'logout', label: 'Se déconnecter', action: logout, danger: true },
  ], h('div.menu-head', {}, h('span.avatar', {}, (u?.username || '?')[0]), h('div', {}, h('b', {}, u?.username || ''), h('small', {}, net.online ? (data.lastSync ? 'Synchronisé' : 'Connecté') : 'Hors connexion'))));
}

// ================= navigation =================
let viewToken = 0;
let cleanups = [];

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { parts: path.split('/').filter(Boolean).map((p) => { try { return decodeURIComponent(p); } catch { return p; } }), query: new URLSearchParams(qs || '') };
}

window.addEventListener('hashchange', route);

function route() {
  if (!data.user || !shellReady) return;
  for (const off of cleanups) off();
  cleanups = [];
  closeMenus();
  if (np?.open) np.close(true);
  const { parts, query } = parseHash();
  const token = ++viewToken;
  const view = $('#view');
  view.scrollTop = 0;
  const [first, a, b] = parts;
  const nav = !first ? 'home' : first === 'library' && a === 'downloads' ? 'downloads' : first;
  for (const link of document.querySelectorAll('[data-nav]')) {
    const on = link.dataset.nav === nav || (link.dataset.nav === 'library' && ['library', 'downloads', 'p', 'c', 'liked'].includes(nav) && link.closest('.bottom-nav'));
    link.toggleAttribute('aria-current', Boolean(on));
  }
  const ctx = {
    token,
    view,
    query,
    alive: () => token === viewToken,
    on(target, type, fn) {
      target.addEventListener(type, fn);
      cleanups.push(() => target.removeEventListener(type, fn));
    },
  };
  if (first !== 'search') { const q = $('#top-q'); if (q && document.activeElement !== q) q.value = ''; }
  if (!first || first === 'home') return viewHome(ctx);
  if (first === 'search') return viewSearch(ctx);
  if (first === 'library') return viewLibrary(ctx, a);
  if (first === 'c' && a && b) return viewCollection(ctx, a, b);
  if (first === 'p' && a) return viewLocal(ctx, a);
  if (first === 'liked') return viewLiked(ctx);
  if (first === 'history') return viewHistory(ctx);
  if (first === 'settings') return viewSettings(ctx, a);
  view.replaceChildren(h('div.page', {}, h('div.empty', {}, h('p.empty-title', {}, 'Page introuvable'), h('a.btn', { href: '#/' }, 'Retour à l’accueil'))));
}

// ================= raccourcis clavier =================
document.addEventListener('keydown', (e) => {
  if (!data.user || e.target.closest('input, textarea, select, [contenteditable]') || document.querySelector('dialog[open]')) return;
  if (e.code === 'Space' && !e.target.closest('button, a')) { e.preventDefault(); player.toggle(); }
  else if (e.shiftKey && e.key === 'ArrowRight') player.next();
  else if (e.shiftKey && e.key === 'ArrowLeft') player.prev();
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key === '/') { e.preventDefault(); const q = $('#top-q'); if (q && q.offsetParent) q.focus(); else go('#/search'); }
  else if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'm') player.toggleMute();
});

window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError) { if (e.reason.status !== 0) toast(e.reason.message, 'error'); e.preventDefault(); }
});

// ================= service worker (mode hors connexion et mises à jour) =================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  let reloading = false;
  let updating = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updating || reloading) return;
    reloading = true;
    location.reload();
  });
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((reg) => {
    const offer = (worker) => {
      toast('Une nouvelle version de Nexify est disponible.', 'info', {
        label: 'Mettre à jour',
        sticky: true,
        fn: () => { updating = true; worker.postMessage('skipWaiting'); },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
    // vérifie les mises à jour au retour sur l'appli
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && net.online) reg.update().catch(() => {}); });
  }).catch(() => { /* certificat non reconnu ou navigateur sans service worker */ });
}

// accès de diagnostic (console du navigateur) : https://…/?debug
if (new URLSearchParams(location.search).has('debug')) window.nexify = { player, data, downloads, prefs, net };

boot();
