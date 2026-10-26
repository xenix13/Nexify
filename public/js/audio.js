// Moteur audio : deux platines (A/B) pour précharger le titre suivant et enchaîner en fondu.
//
//   platine A ─┐
//              ├─► préampli ─► égaliseur 10 bandes ─► [compresseur] ─► volume ─► sortie
//   platine B ─┘
//
// Avec le traitement audio désactivé (ou sans Web Audio), les platines sortent directement :
// pas d'égaliseur, et le fondu passe par element.volume (ignoré par iOS : simple enchaînement).
import { EQ_BANDS } from './prefs.js';

const AC = window.AudioContext || window.webkitAudioContext;
const dbToGain = (db) => 10 ** (db / 20);
const curve = (v) => v * v; // volume perçu plus naturel qu'une échelle linéaire

let silentUrl = null;
function silentWavUrl() {
  if (silentUrl) return silentUrl;
  const rate = 8000;
  const samples = 400; // 50 ms
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE'); str(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, samples, true);
  for (let i = 0; i < samples; i++) v.setUint8(44 + i, 128);
  silentUrl = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  return silentUrl;
}

export class AudioEngine {
  constructor({ processing = true } = {}) {
    this.processing = Boolean(processing && AC);
    this.ctx = null;
    this.volume = 1;
    this.eq = { enabled: false, preamp: 0, gains: EQ_BANDS.map(() => 0) };
    this.normalize = false;
    this.decks = [this._deck(0), this._deck(1)];
    this.active = 0;
    this._onVisible = () => { if (document.visibilityState === 'visible') this.resume(); };
    document.addEventListener('visibilitychange', this._onVisible);
  }

  get a() { return this.decks[this.active]; } // platine en cours
  get b() { return this.decks[1 - this.active]; } // platine en attente (titre suivant)
  swap() { this.active = 1 - this.active; }

  _deck(id) {
    const el = new Audio();
    el.preload = 'auto';
    el.crossOrigin = 'anonymous'; // flux du moteur de l'appli ou du serveur (autre origine) : Web Audio
    el.setAttribute('playsinline', '');
    return { id, el, level: 1, gain: null, revoke: null, fade: null };
  }

  // À appeler lors d'un geste de l'utilisateur (politique de lecture automatique des navigateurs).
  // iOS n'autorise ensuite la lecture d'un élément audio sans geste que s'il a déjà joué une fois :
  // on « amorce » chaque platine avec un court silence.
  unlock() {
    if (!this._primed) {
      this._primed = true;
      const silent = silentWavUrl();
      for (const d of this.decks) {
        if (d.el.getAttribute('src')) continue;
        d.el.src = silent;
        d.el.play().then(() => { if (d.el.getAttribute('src') === silent) d.el.pause(); }).catch(() => {});
      }
    }
    if (!this.processing) return;
    if (!this.ctx) {
      try { this._build(); } catch { this.processing = false; this._applyVolume(); return; }
    }
    this.resume();
  }

  resume() {
    if (this.ctx && this.ctx.state !== 'running' && this.ctx.state !== 'closed') this.ctx.resume().catch(() => {});
  }

  _build() {
    const ctx = new AC({ latencyHint: 'playback' });
    this.ctx = ctx;
    // iOS / Safari : session audio de type lecture (continue écran verrouillé, ignore le mode silencieux)
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* non pris en charge */ }
    this.input = ctx.createGain();
    this.filters = EQ_BANDS.map((f, i) => {
      const b = ctx.createBiquadFilter();
      b.type = i === 0 ? 'lowshelf' : i === EQ_BANDS.length - 1 ? 'highshelf' : 'peaking';
      b.frequency.value = f;
      b.Q.value = 1.1;
      b.gain.value = 0;
      return b;
    });
    let node = this.input;
    for (const f of this.filters) { node.connect(f); node = f; }
    this.eqOut = node;
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -24;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 4;
    this.comp.attack.value = 0.005;
    this.comp.release.value = 0.3;
    this.makeup = ctx.createGain();
    this.makeup.gain.value = dbToGain(5);
    this.comp.connect(this.makeup);
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.makeup.connect(this.master);
    for (const d of this.decks) {
      d.node = ctx.createMediaElementSource(d.el);
      d.gain = ctx.createGain();
      d.gain.gain.value = d.level;
      d.node.connect(d.gain).connect(this.input);
      d.el.volume = 1;
    }
    this._applyEq();
    this._route();
    this._applyVolume();
  }

  // ---------- réglages
  setVolume(v) { this.volume = Math.max(0, Math.min(1, v)); this._applyVolume(); }
  _applyVolume() {
    if (this.master) {
      this.master.gain.setTargetAtTime(curve(this.volume), this.ctx.currentTime, 0.015);
    } else {
      for (const d of this.decks) d.el.volume = Math.max(0, Math.min(1, curve(this.volume) * d.level));
    }
  }

  setEq(eq) { this.eq = { ...this.eq, ...eq }; this._applyEq(); }
  _applyEq() {
    if (!this.filters) return;
    const on = this.eq.enabled;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(on ? Number(this.eq.gains[i]) || 0 : 0, t, 0.02));
    this.input.gain.setTargetAtTime(on ? dbToGain(Number(this.eq.preamp) || 0) : 1, t, 0.02);
  }

  setNormalize(on) { this.normalize = Boolean(on); this._route(); }
  _route() {
    if (!this.eqOut) return;
    this.eqOut.disconnect();
    this.eqOut.connect(this.normalize ? this.comp : this.master);
  }

  // ---------- platines
  load(d, url, revoke = null) {
    this.stop(d);
    d.revoke = revoke;
    d.el.src = url;
    d.el.load();
  }

  stop(d) {
    this._cancelFade(d);
    if (!d.el.paused) d.el.pause();
    if (d.el.getAttribute('src')) {
      d.el.removeAttribute('src');
      d.el.load();
    }
    if (d.revoke) { try { d.revoke(); } catch { /* déjà libérée */ } }
    d.revoke = null;
  }

  setLevel(d, v) {
    this._cancelFade(d);
    d.level = v;
    if (d.gain) {
      const p = d.gain.gain;
      p.cancelScheduledValues(this.ctx.currentTime);
      p.setValueAtTime(v, this.ctx.currentTime);
    } else {
      d.el.volume = Math.max(0, Math.min(1, curve(this.volume) * v));
    }
  }

  // Fondu à puissance constante (courbe sinusoïdale) : pas de creux de volume au milieu
  fade(d, to, seconds) {
    // d.level est la valeur de référence ; on ne lit la valeur réelle du gain qu'au milieu
    // d'un fondu interrompu (juste après un setValueAtTime, .value n'est pas encore à jour)
    const from = d.fade && d.gain ? d.gain.gain.value : d.level;
    this._cancelFade(d);
    if (seconds <= 0.01 || from === to) { this.setLevel(d, to); return Promise.resolve(); }
    const shape = (x) => (to > from ? Math.sin((x * Math.PI) / 2) : 1 - Math.cos((x * Math.PI) / 2));
    return new Promise((resolve) => {
      if (d.gain) {
        const n = 64;
        const values = new Float32Array(n);
        for (let i = 0; i < n; i++) values[i] = from + (to - from) * shape(i / (n - 1));
        const p = d.gain.gain;
        const t = this.ctx.currentTime;
        p.cancelScheduledValues(t);
        p.setValueAtTime(from, t);
        try { p.setValueCurveAtTime(values, t + 0.005, seconds); } catch { p.linearRampToValueAtTime(to, t + seconds); }
        const timer = setTimeout(() => { d.fade = null; d.level = to; resolve(); }, seconds * 1000 + 30);
        d.fade = { timer, resolve };
      } else {
        const start = performance.now();
        const timer = setInterval(() => {
          const x = Math.min(1, (performance.now() - start) / (seconds * 1000));
          d.level = from + (to - from) * shape(x);
          d.el.volume = Math.max(0, Math.min(1, curve(this.volume) * d.level));
          if (x >= 1) { clearInterval(timer); d.fade = null; resolve(); }
        }, 50);
        d.fade = { timer, resolve, interval: true };
      }
    });
  }

  _cancelFade(d) {
    if (!d.fade) return;
    if (d.fade.interval) clearInterval(d.fade.timer); else clearTimeout(d.fade.timer);
    const r = d.fade.resolve;
    d.fade = null;
    r();
  }

  destroy() {
    for (const d of this.decks) this.stop(d);
    document.removeEventListener('visibilitychange', this._onVisible);
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null;
  }
}
