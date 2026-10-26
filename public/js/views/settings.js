// Paramètres : lecture, égaliseur, apparence, téléchargements, services, compte.
import { h, icon, iconButton, sourceMark, SOURCE_NAMES, toast, fmtAgo, confirmDialog, plural } from '../ui.js';
import { net, get, post, patch, del } from '../api.js';
import { prefs, EQ_BANDS, EQ_PRESETS } from '../prefs.js';
import { data } from '../data.js';
import { downloads, fmtSize } from '../downloads.js';
import { errorBlock, loading } from '../components.js';
import { install } from '../install.js';
import { native } from '../native.js';

const SECTIONS = [
  ['playback', 'Lecture'], ['equalizer', 'Égaliseur'], ['appearance', 'Apparence'], ['downloads', 'Téléchargements'],
  ['services', 'Services'], ['account', 'Compte'], ['about', 'À propos'],
];

// ---------- petites briques
function row(title, help, control, cls = '') {
  return h(`div.set-row${cls}`, {}, h('div.set-text', {}, h('b', {}, title), help ? h('small', {}, help) : null), control ? h('div.set-control', {}, control) : null);
}

function toggle(key, onChange) {
  const input = h('input', { type: 'checkbox', checked: Boolean(prefs.get(key)), 'aria-label': key, onChange: (e) => { prefs.set(key, e.target.checked); onChange?.(e.target.checked); } });
  return h('label.switch', {}, input, h('span'));
}

function seg(options, value, onPick, label) {
  const box = h('div.seg', { role: 'group', 'aria-label': label });
  const draw = (v) => box.replaceChildren(...options.map(([id, text]) => h('button', {
    type: 'button', 'aria-pressed': String(v === id), onClick: () => { draw(id); onPick(id); },
  }, text)));
  draw(value);
  return box;
}

function slider({ min, max, step = 1, value, format, onInput, label }) {
  const out = h('span.set-value', {}, format(value));
  const input = h('input', { type: 'range', min, max, step, value, 'aria-label': label });
  const paint = () => input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`);
  input.addEventListener('input', () => { out.textContent = format(Number(input.value)); paint(); onInput(Number(input.value)); });
  paint();
  return [input, out];
}

function group(id, title, ...children) {
  return h('section.set-group', { id: `set-${id}` }, h('h2', {}, title), h('div.set-card', {}, children));
}

// ---------- vue
export function viewSettings(ctx, section) {
  const err = ctx.query.get('error');
  const linked = ctx.query.get('linked');
  if (err) toast(err, 'error');
  if (linked) toast(`${SOURCE_NAMES[linked]} est connecté.`);
  if (err || linked) history.replaceState(null, '', '#/settings/services');

  const nav = h('nav.chips.set-nav', { 'aria-label': 'Sections des paramètres' }, SECTIONS.map(([id, label]) => h('button.chip', {
    type: 'button', onClick: () => document.getElementById(`set-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
  }, label)));

  const draw = () => {
    ctx.view.replaceChildren(h('div.page.settings', {},
      h('h1.page-title', {}, 'Paramètres'),
      nav,
      playbackGroup(),
      eqGroup(),
      appearanceGroup(),
      downloadsGroup(ctx),
      servicesGroup(redraw),
      accountGroup(redraw),
      data.user?.isAdmin ? group('users', 'Comptes utilisateurs', usersAdmin()) : null,
      aboutGroup()));
  };
  const redraw = () => { const y = ctx.view.scrollTop; draw(); ctx.view.scrollTop = y; };
  draw();
  if (section || linked || err) requestAnimationFrame(() => document.getElementById(`set-${section || 'services'}`)?.scrollIntoView({ block: 'start' }));
  ctx.on(net, 'change', redraw);
}

function playbackGroup() {
  const [cf, cfOut] = slider({
    min: 0, max: 12, value: prefs.get('crossfade'), label: 'Durée du fondu enchaîné',
    format: (v) => (v ? `${v} s` : 'Désactivé'), onInput: (v) => prefs.set('crossfade', v),
  });
  const me = data.user;
  const serverSetting = (key, value) => async () => {
    try { const r = await patch('/api/me/settings', { [key]: value }); await data.setUser(r.user); toast('Paramètre enregistré'); } catch (e) { toast(e.message, 'error'); }
  };
  return group('playback', 'Lecture',
    row('Fondu enchaîné', 'Les titres se fondent l’un dans l’autre. Le titre suivant est toujours préchargé pour un enchaînement sans blanc.', [cf, cfOut]),
    row('Lecture automatique', 'À la fin de la file d’attente, Nexify continue avec des titres similaires.', toggle('autoplay')),
    row('Égaliser le volume', 'Atténue les écarts de volume d’un titre à l’autre.', toggle('normalize')),
    row('Traitement audio avancé', 'Nécessaire pour l’égaliseur, l’égalisation du volume et le fondu enchaîné. Désactivez-le si la lecture s’interrompt quand l’écran est verrouillé.', toggle('processing')),
    me ? row('Titres Spotify', me.settings.spotifyPlayback === 'sdk'
      ? 'Lus avec Spotify (Premium requis). L’égaliseur, le fondu et le téléchargement ne s’appliquent pas à ces titres.'
      : 'Lus avec le moteur Nexify à partir de la version YouTube Music du titre : égaliseur, fondu et téléchargement disponibles.',
    net.online ? seg([['ytm', 'Nexify'], ['sdk', 'Spotify']], me.settings.spotifyPlayback, (v) => serverSetting('spotifyPlayback', v)(), 'Lecture des titres Spotify') : h('span.muted', {}, 'Hors connexion')) : null,
    me ? row('Titres Deezer', 'Titre complet (version YouTube Music) ou extrait officiel de 30 secondes.',
      net.online ? seg([['ytm', 'Complet'], ['preview', 'Extrait']], me.settings.deezerPlayback, (v) => serverSetting('deezerPlayback', v)(), 'Lecture des titres Deezer') : h('span.muted', {}, 'Hors connexion')) : null);
}

function eqGroup() {
  const eq = { ...prefs.get('eq'), gains: [...prefs.get('eq').gains] };
  const save = () => prefs.set('eq', { ...eq, gains: [...eq.gains] });
  const box = h('div.eq');
  const outputs = [];
  const inputs = [];
  const fmtDb = (v) => `${v > 0 ? '+' : ''}${v}`;
  const paint = (input) => input.style.setProperty('--p', `${((Number(input.value) + 12) / 24) * 100}%`);
  const select = h('select', { 'aria-label': 'Préréglage', onChange: (e) => {
    const p = EQ_PRESETS[e.target.value];
    if (!p) return;
    eq.preset = e.target.value;
    eq.gains = [...p.gains];
    eq.preamp = -Math.round(Math.max(0, ...p.gains) / 2);
    sync();
    save();
  } },
  ...Object.entries(EQ_PRESETS).map(([id, p]) => h('option', { value: id, selected: eq.preset === id }, p.label)),
  h('option', { value: 'custom', selected: eq.preset === 'custom', disabled: true }, 'Personnalisé'));

  const enable = h('input', { type: 'checkbox', checked: eq.enabled, 'aria-label': 'Activer l’égaliseur', onChange: (e) => { eq.enabled = e.target.checked; box.classList.toggle('off', !eq.enabled); save(); } });
  const band = (label, value, onInput, cls = '') => {
    const out = h('output', {}, fmtDb(value));
    const input = h('input', { type: 'range', min: -12, max: 12, step: 1, value, 'aria-label': `${label}, gain` });
    input.addEventListener('input', () => { out.textContent = fmtDb(Number(input.value)); paint(input); onInput(Number(input.value)); });
    paint(input);
    outputs.push(out);
    inputs.push(input);
    return h(`div.eq-band${cls}`, {}, out, h('div.eq-slot', {}, input), h('label', {}, label));
  };
  const freq = (f) => (f >= 1000 ? `${f / 1000} k` : String(f));
  const pre = band('Préampli', eq.preamp, (v) => { eq.preamp = v; save(); }, '.pre');
  const bands = EQ_BANDS.map((f, i) => band(freq(f), eq.gains[i], (v) => { eq.gains[i] = v; eq.preset = 'custom'; select.value = 'custom'; save(); }));
  function sync() {
    const vals = [eq.preamp, ...eq.gains];
    inputs.forEach((inp, i) => { inp.value = vals[i]; paint(inp); outputs[i].textContent = fmtDb(vals[i]); });
    select.value = eq.preset;
  }
  box.classList.toggle('off', !eq.enabled);
  box.append(
    h('div.eq-top', {},
      h('label.switch', {}, enable, h('span')),
      h('b', { style: { flex: '1', fontWeight: '500' } }, 'Égaliseur'),
      select,
      h('button.btn.ghost', { type: 'button', onClick: () => { eq.preset = 'flat'; eq.gains = [...EQ_PRESETS.flat.gains]; eq.preamp = 0; sync(); save(); } }, 'Réinitialiser')),
    h('div.eq-bands', {}, pre, ...bands),
    h('div.eq-scale', {}, h('span', {}, 'Gain en dB, de −12 à +12'), h('span', {}, 'Fréquences en Hz')),
    prefs.get('processing') ? h('p.hint', {}, 'Les réglages s’appliquent immédiatement, y compris aux titres téléchargés.') : h('p.hint', {}, 'Activez le traitement audio avancé (section Lecture) pour utiliser l’égaliseur.'));
  return group('equalizer', 'Égaliseur', box);
}

function appearanceGroup() {
  return group('appearance', 'Apparence',
    row('Thème', null, seg([['dark', 'Sombre'], ['light', 'Clair'], ['system', 'Système']], prefs.get('theme'), (v) => prefs.set('theme', v), 'Thème')),
    row('Couleurs dynamiques', 'Le lecteur plein écran prend les couleurs de la pochette en cours.', toggle('dynamicColor')),
    row('Afficher l’origine des titres', 'Pastille indiquant si un titre vient de YouTube Music, Spotify ou Deezer.', toggle('showSources')),
    row('Page de démarrage', null, seg([['home', 'Accueil'], ['library', 'Bibliothèque']], prefs.get('startPage'), (v) => prefs.set('startPage', v), 'Page de démarrage')));
}

function downloadsGroup(ctx) {
  const info = h('small', {}, `${plural(downloads.list().length, 'titre')} • ${fmtSize(downloads.totalSize())}`);
  const persist = h('div.set-control');
  navigator.storage?.persisted?.().then((ok) => {
    if (!ctx.alive()) return;
    persist.replaceChildren(ok ? h('span.status.on', {}, 'Protégé')
      : h('button.btn.ghost', { type: 'button', onClick: async () => {
        const granted = await navigator.storage.persist().catch(() => false);
        toast(granted ? 'Vos téléchargements sont protégés.' : 'Le navigateur n’a pas accordé cette protection. Installez l’application pour l’obtenir.');
        if (granted) persist.replaceChildren(h('span.status.on', {}, 'Protégé'));
      } }, 'Protéger'));
  }).catch(() => {});
  return group('downloads', 'Téléchargements',
    h('div.set-row', {}, h('div.set-text', {}, h('b', {}, 'Titres téléchargés'), info), h('div.set-control', {}, h('a.btn', { href: '#/library/downloads' }, 'Gérer'))),
    h('div.set-row', {}, h('div.set-text', {}, h('b', {}, 'Stockage protégé'), h('small', {}, 'Empêche le navigateur d’effacer vos téléchargements lorsque l’espace vient à manquer.')), persist),
    row('Supprimer tous les téléchargements', null, h('button.btn.ghost.danger', { type: 'button', onClick: async () => {
      if (!downloads.list().length) { toast('Aucun téléchargement à supprimer.'); return; }
      if (await confirmDialog('Supprimer tous les téléchargements ?', 'Ces titres ne seront plus disponibles hors connexion.', 'Tout supprimer', { danger: true })) {
        await downloads.removeAll();
        info.textContent = `${plural(0, 'titre')} • ${fmtSize(0)}`;
        toast('Téléchargements supprimés');
      }
    } }, 'Tout supprimer')));
}

function servicesGroup(redraw) {
  const me = data.user;
  if (!me) return null;
  if (!net.online) {
    return group('services', 'Services connectés', h('div.set-row', {}, h('div.set-text', {}, h('b', {}, 'Indisponible hors connexion'), h('small', {}, 'La connexion de vos comptes nécessite l’accès au serveur Nexify.'))));
  }
  const P = me.providers;
  const act = (fn) => async (e) => {
    const btn = e?.currentTarget;
    if (btn) btn.disabled = true;
    try { await fn(); } catch (ex) { toast(ex.message, 'error'); if (btn) btn.disabled = false; }
  };
  const setMe = async (u) => { await data.setUser(u); data.refreshLibrary().catch(() => {}); redraw(); };
  const status = (on, name) => h(`span.status${on ? '.on' : ''}`, {}, on ? `Connecté : ${name}` : 'Non connecté');
  const head = (s) => h('div.svc-head', {}, sourceMark(s), h('b', {}, SOURCE_NAMES[s]));

  const ytmCookie = h('textarea', { rows: 3, placeholder: 'SID=…; HSID=…; SAPISID=…', 'aria-label': 'En-tête Cookie de music.youtube.com', spellcheck: 'false' });
  const saved = P.ytm.savedPlaylists || [];
  const ytm = h('div.set-row.col', {},
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, head('ytm'), status(P.ytm.linked, P.ytm.displayName)),
    P.ytm.linked
      ? h('div', {}, h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/ytm/unlink')).user)) }, 'Déconnecter'))
      : h('div', {},
        h('p.hint', {}, 'La recherche et la lecture fonctionnent sans compte. Pour retrouver votre bibliothèque, collez l’en-tête Cookie de music.youtube.com :'),
        h('ol.steps', {},
          h('li', {}, 'Ouvrez music.youtube.com en étant connecté, puis les outils de développement (F12), onglet Réseau.'),
          h('li', {}, 'Sélectionnez une requête « browse » et copiez la valeur de l’en-tête de requête « cookie ».'),
          h('li', {}, 'Collez-la ci-dessous. Elle est chiffrée sur le serveur et sert uniquement à lire votre bibliothèque.')),
        h('form.stack', { onSubmit: (e) => { e.preventDefault(); act(async () => setMe((await post('/api/ytm/link', { cookie: ytmCookie.value })).user))(); } },
          ytmCookie, h('div', {}, h('button.btn.primary', { type: 'submit' }, 'Connecter YouTube Music')))),
    saved.length ? h('div', {}, h('h3.sub', { style: { marginTop: '8px' } }, 'Playlists ajoutées par lien'), h('ul.plain', {}, saved.map((p) => h('li', {},
      h('a.link', { href: `#/c/ytm/${encodeURIComponent(p.id)}` }, p.name),
      iconButton('close', `Retirer ${p.name}`, act(async () => setMe((await del(`/api/ytm/saved/${encodeURIComponent(p.id)}`)).user)))))) ) : null);

  const spotify = h('div.set-row.col', {},
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, head('spotify'), data.meta.spotifyConfigured ? status(P.spotify.linked, P.spotify.displayName) : h('span.status', {}, 'Non configuré')),
    !data.meta.spotifyConfigured
      ? h('div', {},
        h('p.hint', {}, 'Spotify n’est pas encore configuré sur ce serveur. L’administrateur doit :'),
        h('ol.steps', {},
          h('li', {}, 'Créer une application sur ', h('a.link', { href: 'https://developer.spotify.com/dashboard', target: '_blank', rel: 'noopener' }, 'developer.spotify.com/dashboard'), ' (API « Web API » et « Web Playback SDK »).'),
          h('li', {}, 'Ajouter l’URI de redirection : ', h('code', {}, P.spotify.redirectUri)),
          h('li', {}, 'Renseigner SPOTIFY_CLIENT_ID et SPOTIFY_CLIENT_SECRET dans le fichier .env, puis redémarrer Nexify.')))
      : h('div', {},
        P.spotify.linked
          ? h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/spotify/unlink')).user)) }, 'Déconnecter')
          : h('a.btn.primary', { href: '/api/spotify/login' }, 'Connecter Spotify'),
        h('p.hint', {}, 'En mode développement, Spotify limite l’application à 5 comptes, à déclarer dans son tableau de bord.')));

  const dz = h('input', { placeholder: 'https://www.deezer.com/fr/profile/123456789', 'aria-label': 'Lien du profil Deezer' });
  const deezer = h('div.set-row.col', {},
    h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, head('deezer'), status(P.deezer.linked, P.deezer.displayName)),
    P.deezer.linked
      ? h('div', {}, h('button.btn.ghost', { type: 'button', onClick: act(async () => setMe((await post('/api/deezer/unlink')).user)) }, 'Déconnecter'))
      : h('div.stack', {},
        h('form.inline-form', { onSubmit: (e) => { e.preventDefault(); act(async () => setMe((await post('/api/deezer/link', { profile: dz.value })).user))(); } },
          dz, h('button.btn.primary', { type: 'submit' }, 'Connecter')),
        h('p.hint', {}, 'Dans Deezer, ouvrez votre profil et copiez son lien. Vos playlists et coups de cœur doivent être publics.')));

  return group('services', 'Services connectés', ytm, spotify, deezer);
}

function accountGroup(redraw) {
  const me = data.user;
  if (!me) return null;
  const syncInfo = h('small', {}, data.syncing ? 'Synchronisation…' : data.lastSync ? `Dernière synchronisation ${fmtAgo(data.lastSync)}` : 'Pas encore synchronisé');
  const pwForm = h('form.stack', {
    onSubmit: async (e) => {
      e.preventDefault();
      const fd = new FormData(pwForm);
      try { await post('/api/me/password', { current: fd.get('current'), password: fd.get('password') }); pwForm.reset(); toast('Mot de passe modifié'); } catch (ex) { toast(ex.message, 'error'); }
    },
  },
  h('label.field', {}, h('span', {}, 'Mot de passe actuel'), h('input', { name: 'current', type: 'password', autocomplete: 'current-password', required: true })),
  h('label.field', {}, h('span', {}, 'Nouveau mot de passe'), h('input', { name: 'password', type: 'password', autocomplete: 'new-password', minlength: 8, required: true })),
  h('div', {}, h('button.btn', { type: 'submit', disabled: !net.online }, 'Modifier le mot de passe')));
  return group('account', 'Compte',
    row(me.username, me.isAdmin ? 'Administrateur' : 'Membre', h('span.avatar', {}, me.username[0])),
    h('div.set-row', {}, h('div.set-text', {}, h('b', {}, 'Synchronisation'), syncInfo, h('small', {}, 'Vos playlists et titres « J’aime » sont enregistrés sur cet appareil et synchronisés avec vos autres appareils.')),
      h('div.set-control', {}, h('button.btn.ghost', { type: 'button', disabled: !net.online, onClick: async () => { const ok = await data.sync(); toast(ok ? 'Synchronisation terminée' : 'Synchronisation impossible pour le moment.', ok ? 'info' : 'error'); redraw(); } }, icon('refresh'), 'Synchroniser'))),
    h('div.set-row.col', {}, h('div.set-text', {}, h('b', {}, 'Mot de passe')), pwForm),
    row('Se déconnecter', 'Vos téléchargements et données enregistrées sur cet appareil seront effacés.', h('button.btn.ghost.danger', { type: 'button', onClick: logout }, icon('logout'), 'Se déconnecter')));
}

export async function logout() {
  if (!(await confirmDialog('Se déconnecter ?', 'Les téléchargements et les données enregistrées sur cet appareil seront effacés. Vos playlists restent disponibles sur le serveur.', 'Se déconnecter', { danger: true }))) return;
  if (net.online) {
    await data.sync();
    try { await post('/api/auth/logout'); } catch { /* déconnexion locale malgré tout */ }
  }
  await downloads.removeAll();
  await data.wipe();
  const server = native.server;
  localStorage.clear();
  if (native.isNative && server) native.setServer(server); // l'appli garde l'adresse du serveur
  location.hash = '';
  location.reload();
}

// Appli : changer de serveur Nexify (déconnexion complète de cet appareil)
async function changeServer() {
  if (!(await confirmDialog('Changer de serveur ?', 'Vous serez déconnecté et les données enregistrées sur cet appareil seront effacées.', 'Changer de serveur', { danger: true }))) return;
  if (net.online) { try { await post('/api/auth/logout'); } catch { /* sans effet */ } }
  await downloads.removeAll();
  await data.wipe();
  localStorage.clear();
  location.hash = '';
  location.reload();
}

function usersAdmin() {
  const box = h('div.set-row.col', {}, loading());
  if (!net.online) { box.replaceChildren(h('p.muted', {}, 'Indisponible hors connexion.')); return box; }
  const load = async () => {
    try {
      const { users } = await get('/api/users');
      const name = h('input', { name: 'username', placeholder: 'Nom d’utilisateur', required: true, minlength: 2, maxlength: 32, 'aria-label': 'Nom du nouveau compte' });
      const pass = h('input', { name: 'password', type: 'password', placeholder: 'Mot de passe (8 caractères min.)', required: true, minlength: 8, autocomplete: 'new-password', 'aria-label': 'Mot de passe du nouveau compte' });
      box.replaceChildren(
        h('ul.plain', {}, users.map((u) => h('li', {}, h('span', {}, u.username, u.isAdmin ? h('span.muted', {}, ' • Administrateur') : null),
          u.id === data.user.id ? null : iconButton('trash', `Supprimer ${u.username}`, async () => {
            if (!(await confirmDialog(`Supprimer le compte ${u.username} ?`, 'Ses playlists et ses connexions seront définitivement effacées.', 'Supprimer', { danger: true }))) return;
            try { await del(`/api/users/${u.id}`); toast('Compte supprimé'); load(); } catch (e) { toast(e.message, 'error'); }
          })))),
        h('form.inline-form', {
          onSubmit: async (e) => {
            e.preventDefault();
            try { await post('/api/users', { username: name.value, password: pass.value }); toast(`Compte ${name.value} créé`); load(); } catch (ex) { toast(ex.message, 'error'); }
          },
        }, name, pass, h('button.btn.primary', { type: 'submit' }, 'Ajouter')));
    } catch (e) { box.replaceChildren(errorBlock(e, load)); }
  };
  load();
  return box;
}

function aboutGroup() {
  const build = h('small', {}, '…');
  navigator.serviceWorker?.controller?.postMessage('build');
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.build) build.textContent = `Version ${e.data.build}`; }, { once: true });
  if (native.isNative) build.textContent = `Application ${native.kind === 'desktop' ? 'PC' : 'Android'}${native.engineVersion ? ` ${native.engineVersion}` : ''} • nouvelles versions sur github.com/xenix13/Nexify/releases`;
  else if (!navigator.serviceWorker?.controller) build.textContent = 'Mode hors connexion indisponible sur ce navigateur ou cette connexion (HTTPS requis).';
  const inst = install.state();
  return group('about', 'À propos',
    row('Nexify', data.meta.version ? `Serveur ${data.meta.version}` : null, h('img', { src: '/icons/logo-128.png', alt: '', width: 40, height: 40 })),
    native.isNative ? row('Serveur Nexify', native.server, h('button.btn.ghost', { type: 'button', onClick: changeServer }, 'Changer')) : null,
    native.isNative ? row('Récupération de la musique', native.engineBase
      ? `Sur cet appareil (${native.kind === 'desktop' ? 'moteur Nexify et yt-dlp' : 'NewPipeExtractor'}), sans passer par le serveur.`
      : 'Moteur local indisponible : la musique passe par le serveur.', h(`span.status${native.engineBase ? '.on' : ''}`, {}, native.engineBase ? 'Actif' : 'Inactif')) : null,
    h('div.set-row', {}, h('div.set-text', {}, h('b', {}, 'Application'), build),
      h('div.set-control', {}, h('button.btn.ghost', { type: 'button', hidden: native.isNative, disabled: !net.online, onClick: async () => {
        const reg = await navigator.serviceWorker?.getRegistration();
        if (!reg) { toast('Mise à jour indisponible.'); return; }
        await reg.update().catch(() => {});
        toast(reg.installing || reg.waiting ? 'Une mise à jour est en cours d’installation.' : 'Nexify est à jour.');
      } }, 'Rechercher une mise à jour'))),
    native.isNative ? null : inst === 'installed' ? row('Installer l’application', 'Nexify est installée sur cet appareil.', h('span.status.on', {}, 'Installée'))
      : inst === 'prompt' ? row('Installer l’application', 'Ajoutez Nexify à votre écran d’accueil ou à votre bureau pour l’ouvrir comme une application.', h('button.btn.primary', { type: 'button', onClick: () => install.prompt() }, 'Installer'))
        : inst === 'ios' ? row('Installer l’application', 'Dans Safari, touchez le bouton Partager, puis « Sur l’écran d’accueil ».', null)
          : row('Installer l’application', 'Ouvrez le menu de votre navigateur et choisissez « Installer Nexify » ou « Ajouter à l’écran d’accueil ».', null));
}
