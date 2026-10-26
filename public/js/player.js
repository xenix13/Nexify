// Lecteur : une seule file d'attente, plusieurs moteurs.
//  - audio  : moteur Nexify (deux platines, égaliseur, fondu enchaîné, préchargement du titre suivant).
//             Sert pour YouTube Music, les correspondances Spotify/Deezer, les extraits et les téléchargements.
//  - sdk    : Spotify Web Playback SDK (ce navigateur devient un appareil Spotify, Premium)
//  - remote : un appareil Spotify Connect piloté par l'API
import { post, put, get, store, net, artUrl } from './api.js';
import { AudioEngine } from './audio.js';
import { prefs } from './prefs.js';
import { data } from './data.js';
import { downloads } from './downloads.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const notice = (target, detail) => target.dispatchEvent(new CustomEvent('notice', { detail }));

export class Player extends EventTarget {
  constructor() {
    super();
    this.queue = store.get('queue', []);
    this.index = Math.min(store.get('index', -1), this.queue.length - 1);
    this.shuffle = store.get('shuffle', false);
    this.repeat = store.get('repeat', 'off'); // off | all | one
    this.volume = store.get('volume', 0.8);
    this.muted = false;
    this.context = store.get('context', null); // d'où vient la file (playlist, album…)
    this.target = 'browser'; // 'browser' ou id d'un appareil Spotify Connect
    this.mode = null; // 'audio' | 'sdk' | 'remote'
    this.plan = null;
    this.playing = false;
    this.loading = false;
    this.position = this.current ? store.get('position', 0) : 0;
    this.duration = this.current?.duration || 0;
    this.error = '';
    this.prepared = null; // titre suivant préchargé sur la platine en attente
    this.fading = false;
    this._token = 0;
    this._prepToken = 0;
    this._failures = 0;
    this._radioSeed = null;
    this._historyFor = null;
    this.sdk = null;
    this.sdkDeviceId = null;
    this.sdkReady = null;
    this._remotePoll = null;
    this._sdkPoll = null;
    this._sdkStarted = false;
    this._newEngine();
    this._wirePrefs();
    this._wireMediaSession();
    setInterval(() => { if (this.playing) store.set('position', this.position); }, 5000);
    window.addEventListener('pagehide', () => store.set('position', this.position));
    downloads.addEventListener('change', () => { if (!net.online) this._schedulePrepare(); });
    net.addEventListener('change', () => this._schedulePrepare());
  }

  get current() { return this.queue[this.index] || null; }
  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  _persist() {
    store.set('queue', this.queue.slice(0, 1500));
    store.set('index', this.index);
    store.set('shuffle', this.shuffle);
    store.set('repeat', this.repeat);
    store.set('volume', this.volume);
    store.set('context', this.context);
  }

  // ---------- moteur audio
  _newEngine() {
    this.engine = new AudioEngine({ processing: prefs.get('processing') });
    this.engine.setEq(prefs.get('eq'));
    this.engine.setNormalize(prefs.get('normalize'));
    this.engine.setVolume(this.muted ? 0 : this.volume);
    for (const d of this.engine.decks) this._wireDeck(d);
  }

  _wirePrefs() {
    prefs.addEventListener('change', (e) => {
      const { key, value } = e.detail;
      if (key === 'eq') this.engine.setEq(value);
      if (key === 'normalize') this.engine.setNormalize(value);
      if (key === 'processing') this._rebuildEngine();
      if (key === 'autoplay' || key === 'crossfade') this._schedulePrepare();
    });
  }

  _rebuildEngine() {
    const wasPlaying = this.playing && this.mode === 'audio';
    const pos = this.position;
    const hadAudio = this.mode === 'audio';
    this._token++;
    this.prepared = null;
    this.engine.destroy();
    this._newEngine();
    if (hadAudio && this.current) {
      this.mode = null;
      this.playing = false;
      if (wasPlaying) this.engine.unlock();
      this.playAt(this.index, { positionMs: pos * 1000, autoplay: wasPlaying });
    }
  }

  _isActive(d) { return d === this.engine.a && this.mode === 'audio'; }

  _wireDeck(d) {
    const a = d.el;
    a.addEventListener('playing', () => {
      if (!this._isActive(d)) return;
      this.loading = false;
      this.playing = true;
      this._failures = 0;
      this.engine.resume();
      const mark = `${this._token}:${this.current?.key}`;
      if (this.current && this._historyFor !== mark) { this._historyFor = mark; data.pushHistory(this.current); }
      this.emit();
      this._schedulePrepare(800);
    });
    a.addEventListener('pause', () => { if (this._isActive(d) && !a.ended) { this.playing = false; this.emit(); } });
    a.addEventListener('waiting', () => { if (this._isActive(d)) { this.loading = true; this.emit(); } });
    a.addEventListener('timeupdate', () => {
      if (!this._isActive(d)) return;
      this.position = a.currentTime;
      this.emit('time');
      this._checkCrossfade();
    });
    a.addEventListener('durationchange', () => {
      if (this._isActive(d) && Number.isFinite(a.duration)) { this.duration = a.duration; this.emit('time'); }
    });
    a.addEventListener('ended', () => { if (this._isActive(d)) this._onEnded(); });
    a.addEventListener('error', () => {
      if (d === this.engine.b && this.prepared?.deck === d) { this.prepared = null; return; }
      if (this._isActive(d) && a.getAttribute('src')) this._onAudioError(d);
    });
  }

  // ---------- file d'attente
  playList(tracks, start = 0, context = null) {
    if (!tracks.length) return;
    this.engine.unlock();
    let list = tracks.slice();
    let at = start;
    if (this.shuffle) {
      const first = list.splice(start, 1)[0];
      list = [first, ...shuffled(list)];
      at = 0;
    }
    this.queue = list;
    this.context = context;
    this._radioSeed = null;
    this.playAt(at);
    this.emit('queue');
  }

  enqueue(tracks, next = false) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (next && this.index >= 0) this.queue.splice(this.index + 1, 0, ...list);
    else this.queue.push(...list);
    if (this.index < 0) this.index = 0;
    this._queueChanged();
  }

  removeAt(i) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this._queueChanged();
  }

  move(from, to) {
    if (to < 0 || to >= this.queue.length) return;
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (from === this.index) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this._queueChanged();
  }

  clearUpcoming() {
    this.queue = this.queue.slice(0, this.index + 1);
    this._queueChanged();
  }

  _queueChanged() {
    this._persist();
    this.emit('queue');
    this._schedulePrepare();
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle && this.index >= 0) {
      const upcoming = this.queue.splice(this.index + 1);
      this.queue.push(...shuffled(upcoming));
    }
    this._queueChanged();
    this.emit();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this._persist();
    this._schedulePrepare();
    this.emit();
  }

  // Lance une radio (titres similaires) à partir d'un titre
  async startRadio(track) {
    this.engine.unlock();
    this.playList([track], 0, { kind: 'radio', name: `Radio : ${track.title}` });
    this._radioSeed = track.key;
    try {
      const { tracks } = await post('/api/radio', { track });
      if (this.queue[0]?.key !== track.key) return;
      const have = new Set(this.queue.map((t) => t.key));
      this.queue.push(...tracks.filter((t) => !have.has(t.key)));
      this._queueChanged();
    } catch (e) {
      notice(this, e.message);
    }
  }

  async _extendWithRadio() {
    const seed = this.current;
    if (!seed || !prefs.get('autoplay') || !net.online || this._radioSeed === seed.key) return false;
    this._radioSeed = seed.key;
    try {
      const { tracks } = await post('/api/radio', { track: seed });
      const have = new Set(this.queue.map((t) => t.key));
      const fresh = tracks.filter((t) => !have.has(t.key)).slice(0, 25);
      if (!fresh.length) return false;
      this.queue.push(...fresh);
      this._persist();
      this.emit('queue');
      return true;
    } catch {
      return false;
    }
  }

  // index du titre suivant (hors connexion : prochain titre téléchargé)
  _nextIndex() {
    const n = this.queue.length;
    if (!n) return null;
    const ok = (i) => net.online || downloads.has(this.queue[i]?.key);
    for (let step = 1; step <= n; step++) {
      const raw = this.index + step;
      if (raw >= n && this.repeat !== 'all') return null;
      const i = raw % n;
      if (i === this.index && step < n) continue;
      if (ok(i)) return i;
    }
    return null;
  }

  // ---------- résolution d'une source lisible
  async _source(track, prefer) {
    if (downloads.has(track.key)) {
      const url = await downloads.objectUrl(track.key);
      if (url) return { plan: { mode: 'audio', url, offline: true }, url, revoke: () => URL.revokeObjectURL(url) };
    }
    if (!net.online) {
      throw Object.assign(new Error('Ce titre n’est pas téléchargé. Il sera disponible au retour de la connexion.'), { code: 'offline' });
    }
    const { plan } = await post('/api/resolve', { track, prefer });
    return { plan, url: plan.url, revoke: null };
  }

  // ---------- lecture
  async playAt(i, { positionMs = 0, prefer, autoplay = true } = {}) {
    if (i < 0 || i >= this.queue.length) return;
    const track = this.queue[i];
    const p = this.prepared;
    if (autoplay && this.mode === 'audio' && !prefer && p && p.index === i && p.key === track.key && p.deck === this.engine.b) {
      if (positionMs) p.deck.el.currentTime = positionMs / 1000;
      this._transition(p, this.playing ? 0.25 : 0);
      return;
    }
    const token = ++this._token;
    this._clearPrepared();
    this._stopSpotify();
    this.engine.stop(this.engine.a);
    this.engine.setLevel(this.engine.a, 1);
    this.fading = false;
    this.index = i;
    this._persist();
    this.mode = null;
    this.playing = false;
    this.loading = autoplay;
    this.error = '';
    this.plan = null;
    this.position = positionMs / 1000;
    this.duration = track.duration || 0;
    store.set('position', this.position);
    this.emit('track');
    this.emit();
    try {
      const src = await this._source(track, prefer);
      if (token !== this._token) { src.revoke?.(); return; }
      this.plan = src.plan;
      if (src.plan.mode === 'spotify') {
        await this._playSpotify(src.plan.uri, positionMs, token);
        return;
      }
      this.mode = 'audio';
      const deck = this.engine.a;
      this.engine.load(deck, src.url, src.revoke);
      if (positionMs) {
        const seekTo = positionMs / 1000;
        deck.el.addEventListener('loadedmetadata', () => { if (deck === this.engine.a) deck.el.currentTime = seekTo; }, { once: true });
      }
      this.emit();
      if (!autoplay) { this.loading = false; this.emit(); return; }
      this.engine.resume();
      await deck.el.play();
    } catch (e) {
      if (token !== this._token) return;
      if (e.name === 'NotAllowedError') { this.loading = false; this.playing = false; this.emit(); return; }
      if (e.name === 'AbortError') return;
      if (this.mode === 'audio' && (this.engine.a.el.error || e.name === 'NotSupportedError')) return; // géré par l'écouteur « error »
      // Spotify indisponible dans ce navigateur (pas Premium, DRM bloqué…) : on tente YouTube Music
      if (track.source === 'spotify' && prefer !== 'ytm' && (e.code === 'premium' || e.code === 'sdk')) {
        notice(this, 'Lecture avec Spotify impossible sur cet appareil. Lecture de la version YouTube Music.');
        this.playAt(i, { positionMs, prefer: 'ytm' });
        return;
      }
      this._fail(e.message, token, e.code);
    }
  }

  // Bascule vers le titre préchargé, avec ou sans fondu
  _transition(p, fadeSec) {
    const token = ++this._token;
    const old = this.engine.a;
    const nxt = p.deck;
    this.prepared = null;
    this.engine.setLevel(nxt, fadeSec > 0 ? 0 : 1);
    this.engine.swap();
    this.index = p.index;
    this.plan = p.plan;
    this.mode = 'audio';
    this.error = '';
    this.position = nxt.el.currentTime || 0;
    this.duration = this.queue[p.index]?.duration || 0;
    this._persist();
    this.emit('track');
    this.emit();
    this.engine.resume();
    nxt.el.play().catch((e) => {
      if (token !== this._token || e.name === 'AbortError') return;
      if (e.name === 'NotAllowedError') { this.playing = false; this.emit(); return; }
      if (!nxt.el.error) this._fail(e.message, token);
    });
    if (fadeSec > 0) {
      this.fading = true;
      this.engine.fade(nxt, 1, fadeSec);
      this.engine.fade(old, 0, fadeSec).then(() => {
        if (old !== this.engine.a) { this.engine.stop(old); this.engine.setLevel(old, 1); }
        this.fading = false;
      });
    } else {
      this.engine.stop(old);
      this.engine.setLevel(old, 1);
    }
  }

  _checkCrossfade() {
    const cf = Number(prefs.get('crossfade')) || 0;
    const p = this.prepared;
    if (!cf || this.fading || !p || this.repeat === 'one' || p.deck !== this.engine.b) return;
    const el = this.engine.a.el;
    const d = el.duration;
    if (!Number.isFinite(d) || d < cf * 2 + 2) return;
    const remaining = d - el.currentTime;
    if (remaining <= cf && remaining > 0.25) this._transition(p, Math.min(cf, remaining));
  }

  _onEnded() {
    if (this.repeat === 'one') {
      const el = this.engine.a.el;
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    const p = this.prepared;
    if (p && p.index === this._nextIndex() && p.deck === this.engine.b) { this._transition(p, 0); return; }
    this.next(true);
  }

  _clearPrepared() {
    this._prepToken++;
    if (this.prepared) {
      this.engine.stop(this.prepared.deck);
      this.engine.setLevel(this.prepared.deck, 1);
    }
    this.prepared = null;
  }

  _schedulePrepare(delay = 400) {
    clearTimeout(this._prepTimer);
    this._prepTimer = setTimeout(() => this._prepareNext(), delay);
  }

  // Précharge le titre suivant sur la platine en attente (enchaînement instantané ou en fondu)
  async _prepareNext() {
    if (this.mode !== 'audio' || this.fading || this.repeat === 'one') return;
    let ni = this._nextIndex();
    if (ni == null && this.index === this.queue.length - 1 && (await this._extendWithRadio())) ni = this._nextIndex();
    if (ni == null || this.mode !== 'audio') { this._clearPrepared(); return; }
    const t = this.queue[ni];
    const cur = this.prepared;
    if (cur && cur.index === ni && cur.key === t.key && cur.deck === this.engine.b) return;
    this._clearPrepared();
    const prepToken = this._prepToken;
    const token = this._token;
    try {
      const src = await this._source(t);
      const stale = prepToken !== this._prepToken || token !== this._token || this.queue[ni]?.key !== t.key || this.mode !== 'audio';
      if (stale || src.plan.mode !== 'audio') { src.revoke?.(); return; }
      const deck = this.engine.b;
      this.engine.load(deck, src.url, src.revoke);
      this.prepared = { index: ni, key: t.key, plan: src.plan, deck };
    } catch { /* résolu au moment de la lecture */ }
  }

  // Échec de lecture : message clair, puis titre suivant (arrêt après 3 échecs d'affilée)
  _fail(message, token, code) {
    const track = this.current;
    this.loading = false;
    this.playing = false;
    this.error = message;
    this._failures += 1;
    this.emit();
    const stop = this._failures >= 3;
    notice(this, `${track?.title || 'Titre'} : ${message.replace(/\.?$/, '.')}${stop ? ' Lecture interrompue.' : ''}`);
    if (stop) { this._failures = 0; return; }
    const wait = code === 'offline' ? 300 : 2500;
    setTimeout(() => {
      if (token !== this._token) return;
      const ni = this._nextIndex();
      if (ni != null && ni !== this.index) this.playAt(ni);
    }, wait);
  }

  async _onAudioError(d) {
    const token = this._token;
    const t = this.current;
    const src = d.el.getAttribute('src') || '';
    // titre lu via sa version YouTube Music qui échoue : repli sur l'extrait d'origine
    if (this.plan?.via && t?.previewUrl) {
      this.plan = { mode: 'audio', url: `/api/preview?u=${encodeURIComponent(t.previewUrl)}`, preview: true };
      notice(this, `${t.title} : version complète indisponible, lecture de l’extrait.`);
      this.emit();
      this.engine.load(d, this.plan.url);
      d.el.play().catch(() => {});
      return;
    }
    let message = 'Le flux audio n’a pas pu être lu.';
    if (src.startsWith('/api/')) {
      try {
        const r = await fetch(src, { headers: { range: 'bytes=0-0' } });
        if (!r.ok) message = (await r.json()).error || message;
        else await r.arrayBuffer();
      } catch { /* message générique */ }
    }
    if (token === this._token) this._fail(message, token);
  }

  _stopSpotify() {
    clearInterval(this._remotePoll);
    clearInterval(this._sdkPoll);
    this._remotePoll = null;
    this._sdkPoll = null;
    if (this.mode === 'sdk' && this.sdk) this.sdk.pause().catch(() => {});
    if (this.mode === 'remote') put('/api/spotify/pause', { deviceId: this.target }).catch(() => {});
  }

  async toggle() {
    if (!this.current) return;
    this.engine.unlock();
    if (!this.mode) return this.playAt(this.index, { positionMs: this.position * 1000 });
    if (this.mode === 'audio') {
      const el = this.engine.a.el;
      if (el.paused) {
        this.engine.resume();
        if (!el.getAttribute('src')) return this.playAt(this.index, { positionMs: this.position * 1000 });
        await el.play().catch(() => {});
      } else {
        el.pause();
      }
    } else if (this.mode === 'sdk') {
      await this.sdk.togglePlay();
    } else if (this.mode === 'remote') {
      if (this.playing) await put('/api/spotify/pause', { deviceId: this.target });
      else await put('/api/spotify/resume', { deviceId: this.target });
      this.playing = !this.playing;
      this.emit();
    }
  }

  async next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') return this.playAt(this.index);
    let ni = this._nextIndex();
    if (ni == null && (await this._extendWithRadio())) ni = this._nextIndex();
    if (ni != null) return this.playAt(ni);
    if (auto) {
      this._token++;
      this._clearPrepared();
      this.engine.stop(this.engine.a);
      this._stopSpotify();
      this.mode = null;
      this.playing = false;
      this.position = 0;
      this.emit();
    } else if (!net.online) {
      notice(this, 'Aucun autre titre téléchargé dans la file d’attente.');
    }
  }

  prev() {
    if (this.position > 3 || this.index === 0) return this.seek(0);
    return this.playAt(this.index - 1);
  }

  async seek(seconds) {
    const s = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.position = s;
    if (this.mode === 'audio') {
      this.engine.a.el.currentTime = s;
    } else if (this.mode === 'sdk') await this.sdk.seek(Math.round(s * 1000));
    else if (this.mode === 'remote') await put('/api/spotify/seek', { deviceId: this.target, positionMs: s * 1000 });
    else store.set('position', s);
    this.emit('time');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.muted = false;
    this.engine.setVolume(this.volume);
    if (this.sdk) this.sdk.setVolume(this.volume).catch(() => {});
    if (this.mode === 'remote') {
      clearTimeout(this._volTimer);
      this._volTimer = setTimeout(() => put('/api/spotify/volume', { deviceId: this.target, percent: this.volume * 100 }).catch(() => {}), 250);
    }
    this._persist();
    this.emit('volume');
  }

  toggleMute() {
    this.muted = !this.muted;
    this.engine.setVolume(this.muted ? 0 : this.volume);
    if (this.sdk) this.sdk.setVolume(this.muted ? 0 : this.volume).catch(() => {});
    this.emit('volume');
  }

  // Choix de l'appareil de sortie pour les titres Spotify
  async setTarget(target) {
    if (target === this.target) return;
    const wasPlaying = this.playing;
    const pos = this.position * 1000;
    this._stopSpotify();
    this.target = target;
    this.emit();
    if (this.current && wasPlaying && this.mode !== 'audio') await this.playAt(this.index, { positionMs: pos });
  }

  async devices() {
    const { devices } = await get('/api/spotify/devices');
    return devices.filter((d) => d.id && d.id !== this.sdkDeviceId);
  }

  // ---------- moteur Spotify (SDK ou Spotify Connect)
  async _playSpotify(uri, positionMs, token) {
    if (this.target !== 'browser') {
      this.mode = 'remote';
      await put('/api/spotify/play', { deviceId: this.target, uris: [uri], positionMs });
      if (token !== this._token) return;
      this.loading = false;
      this.playing = true;
      data.pushHistory(this.current);
      this._startRemotePoll(token, uri);
      this.emit();
      return;
    }
    this.mode = 'sdk';
    const deviceId = await this._ensureSdk();
    if (token !== this._token) return;
    this._sdkStarted = false;
    try {
      await put('/api/spotify/play', { deviceId, uris: [uri], positionMs });
    } catch (e) {
      // juste après sa création, l'appareil « Nexify » n'est pas toujours encore connu de Spotify
      if (e.code !== 'no_device') throw e;
      await new Promise((r) => setTimeout(r, 1500));
      if (token !== this._token) return;
      await put('/api/spotify/play', { deviceId, uris: [uri], positionMs });
    }
    data.pushHistory(this.current);
    this._startSdkPoll(token);
  }

  _ensureSdk() {
    if (this.sdkReady) return this.sdkReady;
    this.sdkReady = new Promise((resolve, reject) => {
      const fail = (msg, code = 'sdk') => { this.sdkReady = null; reject(Object.assign(new Error(msg), { code })); };
      if (!window.isSecureContext) { fail('Le lecteur Spotify nécessite une connexion HTTPS.'); return; }
      const timer = setTimeout(() => fail('Le lecteur Spotify ne répond pas.'), 15000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        const p = new window.Spotify.Player({
          name: 'Nexify',
          volume: this.volume,
          getOAuthToken: (cb) => { get('/api/spotify/token').then((t) => cb(t.accessToken)).catch(() => cb('')); },
        });
        p.addListener('ready', ({ device_id: id }) => { clearTimeout(timer); this.sdk = p; this.sdkDeviceId = id; resolve(id); });
        p.addListener('not_ready', () => { this.sdkDeviceId = null; });
        p.addListener('initialization_error', ({ message }) => { clearTimeout(timer); fail(`Spotify : ${message}`); });
        p.addListener('authentication_error', ({ message }) => { clearTimeout(timer); fail(`Spotify : ${message}`, 'premium'); });
        p.addListener('account_error', () => { clearTimeout(timer); fail('La lecture avec Spotify nécessite un abonnement Premium.', 'premium'); });
        p.addListener('playback_error', ({ message }) => notice(this, `Spotify : ${message}`));
        p.addListener('player_state_changed', (s) => this._onSdkState(s));
        p.connect().then((ok) => { if (!ok) { clearTimeout(timer); fail('Connexion au lecteur Spotify refusée.'); } });
      };
      if (window.Spotify) { window.onSpotifyWebPlaybackSDKReady(); return; }
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.onerror = () => { clearTimeout(timer); fail('Impossible de charger le lecteur Spotify.'); };
      document.head.appendChild(s);
    });
    return this.sdkReady;
  }

  _onSdkState(s) {
    if (this.mode !== 'sdk' || !s) return;
    this.position = s.position / 1000;
    if (s.duration) this.duration = s.duration / 1000;
    if (!s.paused) { this._sdkStarted = true; this.loading = false; }
    this.playing = !s.paused;
    const ended = s.paused && s.position === 0 && this._sdkStarted
      && (s.track_window?.previous_tracks || []).some((t) => t.uri === this.plan?.uri || t.linked_from?.uri === this.plan?.uri);
    this.emit();
    if (ended) { this._sdkStarted = false; this.next(true); }
  }

  _startSdkPoll(token) {
    clearInterval(this._sdkPoll);
    this._sdkPoll = setInterval(async () => {
      if (token !== this._token || this.mode !== 'sdk' || !this.sdk) return;
      const s = await this.sdk.getCurrentState().catch(() => null);
      if (s && !s.paused) { this.position = s.position / 1000; this.emit('time'); }
    }, 500);
  }

  _startRemotePoll(token, uri) {
    clearInterval(this._remotePoll);
    let started = false;
    let lastTick = Date.now();
    this._remotePoll = setInterval(() => {
      if (token !== this._token || this.mode !== 'remote') return;
      if (this.playing) { this.position += (Date.now() - lastTick) / 1000; this.emit('time'); }
      lastTick = Date.now();
    }, 500);
    const poll = async () => {
      if (token !== this._token || this.mode !== 'remote') return;
      try {
        const { state } = await get('/api/spotify/state');
        if (token !== this._token) return;
        const same = state?.item?.uri === uri;
        if (same) {
          started = started || state.is_playing;
          this.position = state.progress_ms / 1000;
          this.duration = (state.item.duration_ms || 0) / 1000 || this.duration;
          this.playing = state.is_playing;
          this.emit();
          if (started && !state.is_playing && state.progress_ms === 0) { this.next(true); return; }
        } else if (started) { this.next(true); return; }
      } catch { /* nouvel essai au prochain tour */ }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1500);
  }

  // ---------- écran verrouillé et touches multimédia
  _wireMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* non pris en charge */ } };
    set('play', () => this.toggle());
    set('pause', () => this.toggle());
    set('nexttrack', () => this.next());
    set('previoustrack', () => this.prev());
    set('seekto', (d) => this.seek(d.seekTime));
    set('seekbackward', (d) => this.seek(this.position - (d.seekOffset || 10)));
    set('seekforward', (d) => this.seek(this.position + (d.seekOffset || 10)));
    this.addEventListener('track', () => {
      const t = this.current;
      if (!t || !window.MediaMetadata) return;
      const art = t.artwork ? new URL(artUrl(t.artwork), location.href).href : new URL('/icons/icon-512.png', location.href).href;
      ms.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artists.join(', '),
        album: t.album || 'Nexify',
        artwork: [{ src: art, sizes: '512x512' }],
      });
    });
    let last = 0;
    this.addEventListener('time', () => {
      if (Date.now() - last < 1000 || !ms.setPositionState || !this.duration) return;
      last = Date.now();
      try { ms.setPositionState({ duration: this.duration, position: Math.min(this.position, this.duration), playbackRate: 1 }); } catch { /* valeurs transitoires */ }
    });
    this.addEventListener('change', () => { ms.playbackState = this.playing ? 'playing' : this.current ? 'paused' : 'none'; });
  }
}

function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const player = new Player();
