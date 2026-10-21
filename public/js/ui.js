// Petits outils d'interface : création d'éléments, icônes, notifications, fenêtres.

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

export function icon(name, label) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `icon icon-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export function iconButton(name, label, onClick, extra = {}) {
  return h('button.icon-btn', { type: 'button', title: label, 'aria-label': label, onClick, ...extra }, icon(name));
}

export const SOURCE_NAMES = { spotify: 'Spotify', deezer: 'Deezer', ytm: 'YouTube Music', local: 'Spotihome' };
const SOURCE_LETTER = { spotify: 'S', deezer: 'D', ytm: 'Y', local: 'H' };

export function sourceMark(source) {
  return h(`span.src.src-${source}`, { title: SOURCE_NAMES[source], 'aria-label': SOURCE_NAMES[source] }, SOURCE_LETTER[source]);
}

export function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60) % 60;
  const hh = Math.floor(sec / 3600);
  return hh ? `${hh}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtTotal(tracks) {
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  const n = tracks.length;
  const label = `${n} titre${n > 1 ? 's' : ''}`;
  if (!total) return label;
  const hh = Math.floor(total / 3600);
  const mm = Math.round((total % 3600) / 60);
  return `${label}, ${hh ? `${hh} h ${mm} min` : `${mm} min`}`;
}

export function artwork(url, alt = '', cls = '') {
  if (!url) return h(`div.art.art-empty${cls ? `.${cls}` : ''}`, { 'aria-hidden': 'true' }, icon('note'));
  return h(`img.art${cls ? `.${cls}` : ''}`, { src: url, alt, loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer' });
}

let toastTimer;
export function toast(message, kind = 'info') {
  const box = document.getElementById('toast');
  box.textContent = message;
  box.dataset.kind = kind;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, kind === 'error' ? 6000 : 3500);
}

// Fenêtre modale basée sur <dialog>
export function modal(title, body, actions = []) {
  const dlg = h('dialog.modal', { 'aria-label': title },
    h('form.modal-inner', { method: 'dialog' },
      h('h2.modal-title', {}, title),
      body,
      h('div.modal-actions', {}, ...actions, h('button.btn.ghost', { value: 'cancel', type: 'submit' }, 'Fermer')),
    ),
  );
  document.body.append(dlg);
  dlg.addEventListener('close', () => dlg.remove());
  dlg.showModal();
  return dlg;
}

// Menu contextuel simple, positionné près du bouton
export function popMenu(anchor, items) {
  document.querySelector('.menu')?.remove();
  const menu = h('div.menu', { role: 'menu' },
    items.filter(Boolean).map((it) => h('button.menu-item', {
      type: 'button',
      role: 'menuitem',
      onClick: () => { menu.remove(); it.action(); },
    }, icon(it.icon), it.label)),
  );
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 8 > window.innerHeight ? Math.max(8, r.top - mh - 4) : r.bottom + 4}px`;
  menu.querySelector('button')?.focus();
  const close = (e) => {
    if (e.type === 'keydown' && e.key !== 'Escape') return;
    if (e.type === 'pointerdown' && menu.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', close, true);
    document.removeEventListener('keydown', close, true);
  };
  setTimeout(() => {
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
  });
}
