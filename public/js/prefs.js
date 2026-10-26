// Préférences propres à cet appareil (lecture, égaliseur, apparence).
import { store } from './api.js';

export const EQ_BANDS = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

export const EQ_PRESETS = {
  flat: { label: 'Plat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { label: 'Basses renforcées', gains: [6, 5, 4, 2, 0, 0, 0, 0, 0, 0] },
  bassCut: { label: 'Basses réduites', gains: [-6, -5, -4, -2, 0, 0, 0, 0, 0, 0] },
  treble: { label: 'Aigus renforcés', gains: [0, 0, 0, 0, 0, 1, 2, 4, 5, 6] },
  vocal: { label: 'Voix', gains: [-2, -1, 0, 2, 4, 4, 3, 1, 0, -1] },
  pop: { label: 'Pop', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 0, 1] },
  rock: { label: 'Rock', gains: [5, 4, 2, -1, -2, -1, 2, 3, 4, 4] },
  electronic: { label: 'Électro', gains: [5, 4, 1, 0, -2, 1, 0, 1, 4, 5] },
  hiphop: { label: 'Hip-hop', gains: [5, 4, 2, 3, -1, -1, 1, -1, 2, 3] },
  jazz: { label: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { label: 'Classique', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  acoustic: { label: 'Acoustique', gains: [4, 3, 2, 1, 2, 2, 3, 3, 2, 1] },
  loudness: { label: 'Loudness', gains: [6, 4, 0, -1, -2, -1, 0, 2, 4, 5] },
  night: { label: 'Écoute nocturne', gains: [-3, -2, 0, 1, 2, 2, 1, 0, -2, -4] },
};

const DEFAULTS = {
  theme: 'dark', // dark | light | system
  dynamicColor: true, // couleurs du lecteur tirées de la pochette
  showSources: true, // pastille de la source (Spotify, Deezer, YouTube Music)
  startPage: 'home', // home | library
  crossfade: 4, // secondes, 0 = désactivé
  autoplay: true, // titres similaires à la fin de la file
  normalize: false, // égalisation du volume (compresseur)
  processing: true, // traitement audio (égaliseur, fondu)
  eq: { enabled: false, preset: 'flat', preamp: 0, gains: [...EQ_PRESETS.flat.gains] },
};

class Prefs extends EventTarget {
  constructor() {
    super();
    this.values = { ...DEFAULTS, ...store.get('prefs', {}) };
    this.values.eq = { ...DEFAULTS.eq, ...(this.values.eq || {}) };
  }
  get(key) { return this.values[key]; }
  set(key, value) {
    this.values[key] = value;
    store.set('prefs', this.values);
    this.dispatchEvent(new CustomEvent('change', { detail: { key, value } }));
  }
  reset() {
    this.values = structuredClone(DEFAULTS);
    store.set('prefs', this.values);
    for (const key of Object.keys(DEFAULTS)) this.dispatchEvent(new CustomEvent('change', { detail: { key, value: this.values[key] } }));
  }
}

export const prefs = new Prefs();
