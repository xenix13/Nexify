// Recherche : YouTube Music, Spotify et Deezer en même temps ; dans la bibliothèque locale hors connexion.
import { h, icon, sourceMark, SOURCE_NAMES, plural, toast } from '../ui.js';
import { net, get, music, store } from '../api.js';
import { native } from '../native.js';
import { data } from '../data.js';
import { downloads } from '../downloads.js';
import { trackList, errorBlock, loading } from '../components.js';

const ALL = ['ytm', 'spotify', 'deezer'];

export function viewSearch(ctx) {
  const q = ctx.query.get('q') || '';
  let filter = store.get('searchFilter', 'all'); // all | ytm | spotify | deezer | local
  const topInput = document.getElementById('top-q');
  if (topInput) topInput.value = q;

  const input = h('input', { type: 'search', name: 'q', value: q, placeholder: 'Titres, artistes, albums', 'aria-label': 'Rechercher', autocomplete: 'off', enterkeyhint: 'search' });
  const form = h('form.view-search', {
    role: 'search',
    onSubmit: (e) => { e.preventDefault(); submit(input.value); },
  }, icon('search'), input);
  let typing;
  input.addEventListener('input', () => {
    clearTimeout(typing);
    typing = setTimeout(() => { if (input.value.trim().length >= 2) submit(input.value); }, 550);
  });
  const results = h('div.results');
  const chips = h('div.chips', { role: 'group', 'aria-label': 'Filtrer les résultats' });

  const drawChips = () => {
    const opts = [['all', 'Tout'], ...ALL.map((s) => [s, SOURCE_NAMES[s]]), ['local', 'Ma bibliothèque']];
    chips.replaceChildren(...opts.map(([id, label]) => h('button.chip', {
      type: 'button',
      'aria-pressed': String(filter === id),
      onClick: () => { filter = id; store.set('searchFilter', id); drawChips(); if (current) run(current); },
    }, ALL.includes(id) ? sourceMark(id) : null, label)));
  };
  drawChips();

  const narrow = window.matchMedia('(max-width: 760px)').matches;
  ctx.view.replaceChildren(h('div.page', {},
    narrow ? form : null,
    h('h1.page-title', { class: q ? 'visually-hidden' : '' }, 'Rechercher'),
    chips, results));

  let current = '';
  function submit(v) {
    const value = v.trim();
    history.replaceState(null, '', value ? `#/search?q=${encodeURIComponent(value)}` : '#/search');
    if (value) run(value); else empty();
  }

  function empty() {
    current = '';
    results.replaceChildren(h('div.empty', {}, icon('search'),
      h('p.empty-title', {}, 'Que voulez-vous écouter ?'),
      h('p.muted', {}, net.online
        ? 'Les résultats de YouTube Music, Spotify et Deezer s’affichent ensemble. Chaque titre est lu en version complète dès qu’elle est disponible.'
        : 'Hors connexion, la recherche porte sur vos playlists, vos titres « J’aime » et vos téléchargements.')));
    if (narrow) input.focus();
  }

  async function run(query) {
    current = query;
    if (filter === 'local' || (!net.online && !native.has('search'))) { showLocal(query, !net.online && filter !== 'local'); return; }
    const sources = filter === 'all' ? ALL : [filter];
    results.replaceChildren(loading('Recherche en cours…'));
    let res;
    try {
      res = await music(`/api/search?q=${encodeURIComponent(query)}&sources=${sources.join(',')}`, { timeout: 30_000 });
    } catch (e) {
      if (!ctx.alive() || current !== query) return;
      if (e.status === 0) { showLocal(query, true); return; }
      results.replaceChildren(errorBlock(e, () => run(query)));
      return;
    }
    if (!ctx.alive() || current !== query) return;
    const local = data.searchLocal(query, downloads.tracks()).slice(0, 5);
    results.replaceChildren(
      filter === 'all' && local.length ? section('local', 'Dans votre bibliothèque', local) : '',
      ...sources.filter((s) => res.results[s]).map((s) => sourceSection(s, query, res.results[s])),
    );
  }

  function showLocal(query, offline) {
    const tracks = data.searchLocal(query, downloads.tracks());
    results.replaceChildren(
      offline ? h('div.notice', {}, icon('offline'), h('p', {}, 'Vous êtes hors connexion : résultats issus de votre bibliothèque uniquement.')) : '',
      tracks.length ? section('local', `Dans votre bibliothèque (${plural(tracks.length, 'titre')})`, tracks)
        : h('div.empty', {}, h('p.empty-title', {}, 'Aucun résultat'), h('p.muted', {}, 'Vérifiez l’orthographe ou essayez d’autres mots-clés.')));
  }

  function section(source, title, tracks) {
    return h('section.lib-section', {},
      h('header.section-head', {}, h('h2', {}, sourceMark(source), title)),
      trackList(tracks, { label: title, context: { kind: 'search', name: `Recherche : ${current}` } }));
  }

  function sourceSection(source, query, res) {
    const sec = h('section.lib-section', {}, h('header.section-head', {}, h('h2', {}, sourceMark(source), SOURCE_NAMES[source])));
    if (!res) return sec;
    if (res.error) {
      const fixable = ['not_linked', 'not_configured'].includes(res.code);
      sec.append(h('div.notice', {}, h('p', {}, fixable && source === 'spotify' ? 'La recherche Spotify n’est pas configurée sur ce serveur.' : res.error),
        fixable ? h('a.btn', { href: '#/settings/services' }, 'Paramètres') : null));
      return sec;
    }
    if (!res.tracks.length) { sec.append(h('p.muted', {}, 'Aucun résultat.')); return sec; }
    const tracks = res.tracks.slice();
    let list = trackList(tracks, { label: `Résultats ${SOURCE_NAMES[source]}`, context: { kind: 'search', name: `Recherche : ${query}` } });
    sec.append(list);
    if (res.hasMore && source !== 'ytm') {
      let offset = tracks.length;
      const more = h('button.btn.ghost', {
        type: 'button',
        style: { marginTop: '8px' },
        onClick: async () => {
          more.disabled = true;
          try {
            const d = await get(`/api/search?q=${encodeURIComponent(query)}&sources=${source}&offset=${offset}`);
            const r = d.results[source];
            tracks.push(...r.tracks);
            offset += r.tracks.length;
            const fresh = trackList(tracks, { label: `Résultats ${SOURCE_NAMES[source]}`, context: { kind: 'search', name: `Recherche : ${query}` } });
            list.replaceWith(fresh);
            list = fresh;
            if (!r.hasMore) more.remove(); else more.disabled = false;
          } catch (e) { toast(e.message, 'error'); more.disabled = false; }
        },
      }, 'Afficher plus de résultats');
      sec.append(more);
    }
    return sec;
  }

  if (q) run(q); else empty();
}
