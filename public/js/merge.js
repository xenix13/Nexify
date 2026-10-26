// Fusion des données utilisateur entre appareils et serveur (partagé client / serveur).
// Chaque élément porte un horodatage updatedAt : la version la plus récente gagne.
// Une suppression est conservée sous forme de « pierre tombale » (deleted / removed)
// pour se propager aux autres appareils, puis oubliée après TOMBSTONE_TTL.
//
// Format :
// {
//   playlists: { [id]: { id, name, tracks: [track], createdAt, updatedAt, deleted? } },
//   likes:     { [trackKey]: { key, track, at, updatedAt, removed? } },
// }

export const TOMBSTONE_TTL = 120 * 86_400_000;

export const emptyUserData = () => ({ playlists: {}, likes: {} });

function mergeMap(a = {}, b = {}, isDead, now) {
  const out = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id];
    const y = b[id];
    let pick;
    if (!x) pick = y;
    else if (!y) pick = x;
    else pick = (Number(y.updatedAt) || 0) >= (Number(x.updatedAt) || 0) ? y : x;
    if (!pick) continue;
    if (isDead(pick) && now - (Number(pick.updatedAt) || 0) > TOMBSTONE_TTL) continue;
    out[id] = pick;
  }
  return out;
}

export function mergeUserData(a, b, now = Date.now()) {
  a = a || emptyUserData();
  b = b || emptyUserData();
  return {
    playlists: mergeMap(a.playlists, b.playlists, (p) => p.deleted, now),
    likes: mergeMap(a.likes, b.likes, (l) => l.removed, now),
  };
}
