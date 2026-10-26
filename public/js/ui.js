// Outils d'interface : éléments, icônes, pochettes, menus, fenêtres, notifications.
import { artUrl } from './api.js';

export function h(tag, props = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon ico-${name}${cls ? ` ${cls}` : ''}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function iconButton(name, label, onClick, extra = {}) {
  return h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onClick, ...extra }, icon(name));
}

export function setIcon(btn, name) {
  btn.querySelector('use')?.setAttribute('href', `#i-${name}`);
}

export const SOURCE_NAMES = { spotify: 'Spotify', deezer: 'Deezer', ytm: 'YouTube Music', local: 'Nexify' };
const SOURCE_LETTER = { spotify: 'S', deezer: 'D', ytm: 'Y', local: 'N' };

export function sourceMark(source) {
  return h(`span.src.src-${source}`, { title: SOURCE_NAMES[source], 'aria-label': SOURCE_NAMES[source], role: 'img' }, SOURCE_LETTER[source]);
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const hh = Math.floor(sec / 3600);
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`;

export function fmtTotal(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const label = plural(tracks.length, 'titre');
  if (!total) return label;
  const hh = Math.floor(total / 3600);
  const mm = Math.round((total % 3600) / 60);
  return `${label} • ${hh ? `${hh} h ${mm} min` : `${mm} min`}`;
}

export function fmtAgo(ts) {
  if (!ts) return 'jamais';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.round(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.round(s / 3600)} h`;
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

// Pochette : relayée par le serveur, gardée hors ligne ; vignette neutre si indisponible
export function artwork(url, cls = '', alt = '') {
  const empty = () => h(`div.art.art-empty${cls ? `.${cls.split(' ').join('.')}` : ''}`, { 'aria-hidden': 'true' }, icon('note'));
  if (!url) return empty();
  const img = h(`img.art${cls ? `.${cls.split(' ').join('.')}` : ''}`, { src: artUrl(url), alt, loading: 'lazy', decoding: 'async' });
  img.addEventListener('error', () => img.replaceWith(empty()), { once: true });
  return img;
}

export function specialArt(kind, cls = '') {
  const c = cls ? `.${cls.split(' ').join('.')}` : '';
  if (kind === 'liked') return h(`div.art.art-liked${c}`, { 'aria-hidden': 'true' }, icon('liked'));
  if (kind === 'downloads') return h(`div.art.art-downloads${c}`, { 'aria-hidden': 'true' }, icon('download'));
  return h(`div.art.art-empty${c}`, { 'aria-hidden': 'true' }, icon('note'));
}

let toastTimer;
export function toast(message, kind = 'info', action = null) {
  const box = document.getElementById('toast');
  box.replaceChildren(h('span', {}, message), action ? h('button', { type: 'button', onClick: () => { box.hidden = true; action.fn(); } }, action.label) : '');
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  if (action?.sticky) return;
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 6000 : action ? 8000 : 3500);
}

// Fenêtre modale basée sur <dialog>
export function modal(title, body, actions = [], { closeLabel = 'Annuler' } = {}) {
  const dlg = h('dialog.modal', { 'aria-label': title },
    h('form.modal-inner', { method: 'dialog', onSubmit: (e) => { if (e.submitter?.value !== 'cancel') e.preventDefault(); } },
      h('h2.modal-title', {}, title),
      body,
      h('div.modal-actions', {}, h('button.btn.ghost', { value: 'cancel', type: 'submit', formnovalidate: true }, closeLabel), ...actions),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

export function confirmDialog(title, text, confirmLabel, { danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = modal(title, h('p', {}, text), [
      h(`button.btn${danger ? '.danger' : '.primary'}`, { type: 'button', onClick: () => { ok = true; dlg.close(); } }, confirmLabel),
    ]);
    dlg.addEventListener('close', () => resolve(ok));
  });
}

export function promptDialog(title, { value = '', placeholder = '', label = 'Nom', confirm = 'Enregistrer' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const input = h('input', { value, placeholder, maxlength: 120, 'aria-label': label, required: true });
    const submit = () => { if (!input.value.trim()) { input.focus(); return; } result = input.value.trim(); dlg.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const dlg = modal(title, input, [h('button.btn.primary', { type: 'button', onClick: submit }, confirm)]);
    dlg.addEventListener('close', () => resolve(result));
    input.focus();
    input.select();
  });
}

const narrow = window.matchMedia('(max-width: 760px)');

// Menu contextuel : près du bouton sur ordinateur, en panneau du bas sur mobile
export function popMenu(anchor, items, head = null) {
  closeMenus();
  const sheet = narrow.matches;
  const scrim = sheet ? h('div.scrim', { onClick: () => close() }) : null;
  const menu = h(`div.menu${sheet ? '.sheet' : ''}`, { role: 'menu' },
    head,
    items.filter(Boolean).map((it) => (it === '-' ? h('hr.menu-sep') : h(`button.menu-item${it.danger ? '.danger' : ''}`, {
      type: 'button',
      role: 'menuitem',
      onClick: () => { close(); it.action(); },
    }, icon(it.icon), it.label))),
  );
  if (scrim) document.body.append(scrim);
  document.body.append(menu);
  if (!sheet) {
    const r = anchor.getBoundingClientRect();
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
    menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  }
  menu.querySelector('button')?.focus({ preventScroll: true });
  function onKey(e) {
    if (e.key === 'Escape') close();
  }
  function onDown(e) {
    if (!menu.contains(e.target) && !scrim) close();
  }
  function close() {
    menu.remove();
    scrim?.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('hashchange', close);
    if (document.activeElement === document.body) anchor?.focus?.({ preventScroll: true });
  }
  menu._close = close;
  setTimeout(() => {
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('hashchange', close);
  });
  return menu;
}

export function closeMenus() {
  for (const m of document.querySelectorAll('.menu')) m._close?.();
}

// Couleur dominante d'une image de même origine (fond du lecteur)
export async function dominantColor(url) {
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 16;
        const g = c.getContext('2d', { willReadFrequently: true });
        g.drawImage(img, 0, 0, 16, 16);
        const d = g.getImageData(0, 0, 16, 16).data;
        let r = 0, gg = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          const max = Math.max(d[i], d[i + 1], d[i + 2]);
          const min = Math.min(d[i], d[i + 1], d[i + 2]);
          const w = 1 + (max - min) / 32; // privilégie les couleurs saturées
          r += d[i] * w; gg += d[i + 1] * w; b += d[i + 2] * w; n += w;
        }
        resolve([r / n, gg / n, b / n].map((v) => Math.round(v)));
      } catch { resolve(null); }
    };
    img.onerror = () => resolve(null);
    img.src = artUrl(url);
  });
}
