// Accès minimal à IndexedDB (stockage local de l'appli).
// Magasins :
//   kv          réglages, profil, données synchronisées, historique (clé explicite)
//   collections playlists des services gardées pour le mode hors ligne (clé « source:id »)
//   downloads   fiche des titres téléchargés (clé = track.key)
//   audio       fichier audio des titres téléchargés (Blob, clé = track.key)
const NAME = 'nexify';
const VERSION = 1;
const STORES = ['kv', 'collections', 'downloads', 'audio'];

let dbp = null;
const memory = new Map(STORES.map((s) => [s, new Map()])); // repli si IndexedDB est indisponible
let useMemory = false;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(NAME, VERSION); } catch { useMemory = true; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => { useMemory = true; resolve(null); };
    req.onblocked = () => { useMemory = true; resolve(null); };
  });
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  if (!db || useMemory) return fn(null, memory.get(store));
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const req = fn(os);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transaction annulée'));
  });
}

export const db = {
  get: (store, key) => run(store, 'readonly', (os, mem) => (os ? os.get(key) : mem.get(key))),
  put: (store, value, key) => run(store, 'readwrite', (os, mem) => (os ? os.put(value, key) : (mem.set(key, value), undefined))),
  del: (store, key) => run(store, 'readwrite', (os, mem) => (os ? os.delete(key) : (mem.delete(key), undefined))),
  all: (store) => run(store, 'readonly', (os, mem) => (os ? os.getAll() : [...mem.values()])),
  keys: (store) => run(store, 'readonly', (os, mem) => (os ? os.getAllKeys() : [...mem.keys()])),
  clear: (store) => run(store, 'readwrite', (os, mem) => (os ? os.clear() : (mem.clear(), undefined))),
  get persistent() { return !useMemory; },
};
