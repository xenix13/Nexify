// Appels à l'API Spotihome
export class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.code = data?.code;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'x-spotihome': '1' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let r;
  try {
    r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiError('Serveur injoignable. Vérifie que Spotihome tourne toujours.', 0);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(data.error || `Erreur ${r.status}`, r.status, data);
  return data;
}

export const get = (p) => api(p);
export const post = (p, body = {}) => api(p, { method: 'POST', body });
export const put = (p, body = {}) => api(p, { method: 'PUT', body });
export const patch = (p, body = {}) => api(p, { method: 'PATCH', body });
export const del = (p) => api(p, { method: 'DELETE' });

export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`spotihome:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`spotihome:${key}`, JSON.stringify(value)); } catch { /* stockage indisponible */ }
  },
};
