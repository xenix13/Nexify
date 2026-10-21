// Lecteur unifié : une seule file d'attente, trois moteurs.
//  - audio  : <audio> pour YouTube Music (relayé par le serveur) et les extraits Deezer
//  - sdk    : Spotify Web Playback SDK (ce navigateur devient un appareil Spotify, Premium)
//  - remote : un appareil Spotify Connect (enceinte, téléphone, PC) piloté par l'API
import { api, post, put, get, store } from './api.js';

const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';

export class Player extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.queue = store.get('queue', []);
    this.index = Math.min(store.get('index', -1), this.queue.length - 1);
    this.shuffle = store.get('shuffle', false);
    this.repeat = store.get('repeat', 'off'); // off | all | one
    this.volume = store.get('volume', 0.8);
    this.target = 'browser'; // 'browser' ou id d'un appareil Spotify Connect
    this.engine = null; // 'audio' | 'sdk' | 'remote'
    this.plan = null;
    this.playing = false;
    this.loading = false;
    this.position = 0;
    this.duration = 0;
    this.error = '';
    this._token = 0; // invalide les chargements dépassés
    this.sdk = null;
    this.sdkDeviceId = null;
    this.sdkReady = null;
    this._remotePoll = null;
    this._sdkPoll = null;
    this._sdkStarted = false;
    this.audio.volume = this.volume;
    this._wireAudio();
    this._wireMediaSession();
  }

  get current() { return this.queue[this.index] || null; }

  emit(type = 'change') { this.dispatchEvent(new Event(type)); }

  _persist() {
    store.set('queue', this.queue.slice(0, 1000));
    store.set('index', this.index);
    store.set('shuffle', this.shuffle);
    store.set('repeat', this.repeat);
    store.set('volume', this.volume);
  }

  // ---------- file d'attente
  playList(tracks, start = 0) {
    if (!tracks.length) return;
    let list = tracks.slice();
    let at = start;
    if (this.shuffle) {
      const first = list.splice(start, 1)[0];
      list = [first, ...shuffled(list)];
      at = 0;
    }
    this.queue = list;
    this.playAt(at);
  }

  enqueue(tracks, next = false) {
    const list = Array.isArray(tracks) ? tracks : [tracks];
    if (next && this.index >= 0) this.queue.splice(this.index + 1, 0, ...list);
    else this.queue.push(...list);
    if (this.index < 0) this.index = 0;
    this._persist();
    this.emit('queue');
  }

  removeAt(i) {
    if (i === this.index) return;
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    this._persist();
    this.emit('queue');
  }

  move(from, to) {
    const [t] = this.queue.splice(from, 1);
    this.queue.splice(to, 0, t);
    if (from === this.index) this.index = to;
    else if (from < this.index && to >= this.index) this.index--;
    else if (from > this.index && to <= this.index) this.index++;
    this._persist();
    this.emit('queue');
  }

  clearUpcoming() {
    this.queue = this.queue.slice(0, this.index + 1);
    this._persist();
    this.emit('queue');
  }

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle && this.index >= 0) {
      const upcoming = this.queue.splice(this.index + 1);
      this.queue.push(...shuffled(upcoming));
    }
    this._persist();
    this.emit('queue');
    this.emit();
  }

  cycleRepeat() {
    this.repeat = { off: 'all', all: 'one', one: 'off' }[this.repeat];
    this._persist();
    this.emit();
  }

  // ---------- lecture
  async playAt(i, { positionMs = 0, prefer } = {}) {
    if (i < 0 || i >= this.queue.length) return;
    const token = ++this._token;
    this.index = i;
    this._persist();
    this._stopEngines();
    this.loading = true;
    this.error = '';
    this.position = positionMs / 1000;
    this.duration = this.current.duration || 0;
    this.emit('track');
    this.emit();
    const track = this.current;
    try {
      const { plan } = await post('/api/resolve', { track, prefer });
      if (token !== this._token) return;
      this.plan = plan;
      if (plan.mode === 'spotify') await this._playSpotify(plan.uri, positionMs, token);
      else await this._playAudio(plan.url, positionMs, token);
    } catch (e) {
      if (token !== this._token) return;
      // Spotify indisponible dans ce navigateur (pas Premium, DRM bloqué…) : on tente YouTube Music
      if (track.source === 'spotify' && prefer !== 'ytm' && (e.code === 'premium' || e.code === 'sdk')) {
        this.dispatchEvent(new CustomEvent('notice', { detail: 'Lecture Spotify impossible ici, bascule sur la version YouTube Music.' }));
        return this.playAt(i, { positionMs, prefer: 'ytm' });
      }
      this._fail(e.message, token);
    }
  }

  // Échec de lecture : message clair, puis titre suivant (on s'arrête après 3 échecs d'affilée)
  _fail(message, token) {
    const track = this.current;
    this.loading = false;
    this.playing = false;
    this.error = message;
    this._failures = (this._failures || 0) + 1;
    this.emit();
    const stop = this._failures >= 3;
    this.dispatchEvent(new CustomEvent('notice', {
      detail: `${track?.title || 'Titre'} : ${message.replace(/\.?$/, '.')}${stop ? ' Lecture arrêtée après 3 échecs.' : ''}`,
    }));
    if (stop) { this._failures = 0; return; }
    setTimeout(() => { if (token === this._token && this.index < this.queue.length - 1) this.next(true); }, 2500);
  }

  async _playAudio(url, positionMs, token) {
    this.engine = 'audio';
    this.audio.src = url;
    if (positionMs) this.audio.currentTime = positionMs / 1000;
    try {
      await this.audio.play();
    } catch (e) {
      if (token !== this._token) return;
      if (e.name === 'NotAllowedError') { this.loading = false; this.playing = false; this.emit(); return; }
      // flux en erreur : l'écouteur « error » de l'élément audio s'en occupe (message précis, repli)
      if (this.audio.error || e.name === 'NotSupportedError' || e.name === 'AbortError') return;
      throw e;
    }
  }

  async _playSpotify(uri, positionMs, token) {
    if (this.target !== 'browser') {
      this.engine = 'remote';
      await put('/api/spotify/play', { deviceId: this.target, uris: [uri], positionMs });
      if (token !== this._token) return;
      this.loading = false;
      this.playing = true;
      this._startRemotePoll(token, uri);
      this.emit();
      return;
    }
    this.engine = 'sdk';
    const deviceId = await this._ensureSdk();
    if (token !== this._token) return;
    this._sdkStarted = false;
    try {
      await put('/api/spotify/play', { deviceId, uris: [uri], positionMs });
    } catch (e) {
      // juste après sa création, l'appareil « Spotihome » n'est pas toujours encore connu de Spotify
      if (e.code !== 'no_device') throw e;
      await new Promise((r) => setTimeout(r, 1500));
      if (token !== this._token) return;
      await put('/api/spotify/play', { deviceId, uris: [uri], positionMs });
    }
    this._startSdkPoll(token);
  }

  _stopEngines() {
    clearInterval(this._remotePoll);
    clearInterval(this._sdkPoll);
    this._remotePoll = null;
    this._sdkPoll = null;
    if (!this.audio.paused) this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    if (this.engine === 'sdk' && this.sdk) this.sdk.pause().catch(() => {});
    if (this.engine === 'remote') put('/api/spotify/pause', { deviceId: this.target }).catch(() => {});
    this.engine = null;
    this.playing = false;
  }

  async toggle() {
    if (!this.current) return;
    if (!this.engine) return this.playAt(this.index, { positionMs: this.position * 1000 });
    if (this.engine === 'audio') {
      if (this.audio.paused) await this.audio.play().catch(() => {}); else this.audio.pause();
    } else if (this.engine === 'sdk') {
      await this.sdk.togglePlay();
    } else if (this.engine === 'remote') {
      if (this.playing) await put('/api/spotify/pause', { deviceId: this.target });
      else await put('/api/spotify/resume', { deviceId: this.target });
      this.playing = !this.playing;
      this.emit();
    }
  }

  next(auto = false) {
    if (!this.queue.length) return;
    if (auto && this.repeat === 'one') return this.playAt(this.index);
    if (this.index < this.queue.length - 1) return this.playAt(this.index + 1);
    if (this.repeat === 'all') return this.playAt(0);
    if (auto) { this._stopEngines(); this.position = 0; this.emit(); }
  }

  prev() {
    if (this.position > 3 || this.index === 0) return this.seek(0);
    return this.playAt(this.index - 1);
  }

  async seek(seconds) {
    const s = Math.max(0, Math.min(seconds, this.duration || seconds));
    this.position = s;
    if (this.engine === 'audio') this.audio.currentTime = s;
    else if (this.engine === 'sdk') await this.sdk.seek(Math.round(s * 1000));
    else if (this.engine === 'remote') await put('/api/spotify/seek', { deviceId: this.target, positionMs: s * 1000 });
    this.emit('time');
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this.audio.volume = this.volume;
    if (this.sdk) this.sdk.setVolume(this.volume).catch(() => {});
    if (this.engine === 'remote') {
      clearTimeout(this._volTimer);
      this._volTimer = setTimeout(() => put('/api/spotify/volume', { deviceId: this.target, percent: this.volume * 100 }).catch(() => {}), 250);
    }
    this._persist();
    this.emit('volume');
  }

  // Choix de l'appareil de sortie pour les titres Spotify
  async setTarget(target) {
    if (target === this.target) return;
    const wasPlaying = this.playing;
    const pos = this.position * 1000;
    const cur = this.current;
    this._stopEngines();
    this.target = target;
    this.emit();
    if (cur && wasPlaying) await this.playAt(this.index, { positionMs: pos });
  }

  async devices() {
    const { devices } = await get('/api/spotify/devices');
    return devices.filter((d) => d.id && d.id !== this.sdkDeviceId);
  }

  // ---------- moteur <audio>
  _wireAudio() {
    const a = this.audio;
    a.addEventListener('playing', () => { if (this.engine === 'audio') { this.loading = false; this.playing = true; this._failures = 0; this.emit(); } });
    a.addEventListener('pause', () => { if (this.engine === 'audio') { this.playing = false; this.emit(); } });
    a.addEventListener('waiting', () => { if (this.engine === 'audio') { this.loading = true; this.emit(); } });
    a.addEventListener('timeupdate', () => { if (this.engine === 'audio') { this.position = a.currentTime; this.emit('time'); } });
    a.addEventListener('durationchange', () => {
      if (this.engine === 'audio' && Number.isFinite(a.duration)) { this.duration = a.duration; this.emit('time'); }
    });
    a.addEventListener('ended', () => { if (this.engine === 'audio') this.next(true); });
    a.addEventListener('error', async () => {
      const src = a.getAttribute('src');
      if (this.engine !== 'audio' || !src) return;
      const token = this._token;
      const t = this.current;
      // titre Deezer/Spotify lu via YouTube Music qui échoue : on se replie sur l'extrait d'origine
      if (this.plan?.via && t?.previewUrl) {
        this.plan = { mode: 'audio', url: t.previewUrl, preview: true };
        this.dispatchEvent(new CustomEvent('notice', { detail: `${t.title} : version YouTube Music illisible, lecture de l’extrait.` }));
        this.emit();
        this._playAudio(t.previewUrl, 0, token).catch((e) => { if (token === this._token) this._fail(e.message, token); });
        return;
      }
      // le relais du serveur explique pourquoi (yt-dlp absent, titre bloqué…)
      let message = 'le flux audio n’a pas pu être lu.';
      if (src.startsWith('/api/')) {
        try {
          const r = await fetch(src, { headers: { range: 'bytes=0-0' } });
          if (!r.ok) message = (await r.json()).error || message;
          else await r.arrayBuffer(); // un seul octet demandé
        } catch { /* message générique */ }
      }
      if (token === this._token) this._fail(message, token);
    });
  }

  // ---------- moteur Spotify SDK
  _ensureSdk() {
    if (this.sdkReady) return this.sdkReady;
    this.sdkReady = new Promise((resolve, reject) => {
      const fail = (msg, code = 'sdk') => { this.sdkReady = null; reject(Object.assign(new Error(msg), { code })); };
      if (!window.isSecureContext) { fail('Le lecteur Spotify exige HTTPS.'); return; }
      const timer = setTimeout(() => fail('Le lecteur Spotify ne répond pas.'), 15000);
      window.onSpotifyWebPlaybackSDKReady = () => {
        const p = new window.Spotify.Player({
          name: 'Spotihome',
          volume: this.volume,
          getOAuthToken: (cb) => { get('/api/spotify/token').then((t) => cb(t.accessToken)).catch(() => cb('')); },
        });
        p.addListener('ready', ({ device_id }) => { clearTimeout(timer); this.sdk = p; this.sdkDeviceId = device_id; resolve(device_id); });
        p.addListener('not_ready', () => { this.sdkDeviceId = null; });
        p.addListener('initialization_error', ({ message }) => { clearTimeout(timer); fail(`Spotify : ${message}`); });
        p.addListener('authentication_error', ({ message }) => { clearTimeout(timer); fail(`Spotify : ${message}`, 'premium'); });
        p.addListener('account_error', () => { clearTimeout(timer); fail('La lecture Spotify dans le navigateur demande un compte Premium.', 'premium'); });
        p.addListener('playback_error', ({ message }) => {
          this.dispatchEvent(new CustomEvent('notice', { detail: `Spotify : ${message}` }));
        });
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
    if (this.engine !== 'sdk' || !s) return;
    this.position = s.position / 1000;
    if (s.duration) this.duration = s.duration / 1000;
    if (!s.paused) { this._sdkStarted = true; this.loading = false; }
    this.playing = !s.paused;
    // fin de titre : le SDK repasse en pause à 0 et range le titre dans previous_tracks
    const ended = s.paused && s.position === 0 && this._sdkStarted
      && (s.track_window?.previous_tracks || []).some((t) => t.uri === this.plan?.uri || t.linked_from?.uri === this.plan?.uri);
    this.emit();
    if (ended) { this._sdkStarted = false; this.next(true); }
  }

  _startSdkPoll(token) {
    clearInterval(this._sdkPoll);
    this._sdkPoll = setInterval(async () => {
      if (token !== this._token || this.engine !== 'sdk' || !this.sdk) return;
      const s = await this.sdk.getCurrentState().catch(() => null);
      if (s && !s.paused) { this.position = s.position / 1000; this.emit('time'); }
    }, 500);
  }

  // ---------- moteur Spotify Connect (appareil distant)
  _startRemotePoll(token, uri) {
    clearInterval(this._remotePoll);
    let started = false;
    let lastTick = Date.now();
    this._remotePoll = setInterval(async () => {
      if (token !== this._token || this.engine !== 'remote') return;
      // entre deux interrogations, on fait avancer la barre localement
      if (this.playing) { this.position += (Date.now() - lastTick) / 1000; this.emit('time'); }
      lastTick = Date.now();
    }, 500);
    const poll = async () => {
      if (token !== this._token || this.engine !== 'remote') return;
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
      } catch { /* on réessaie au prochain tour */ }
      setTimeout(poll, 2000);
    };
    setTimeout(poll, 1500);
  }

  // ---------- touches multimédia du système
  _wireMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    ms.setActionHandler('play', () => this.toggle());
    ms.setActionHandler('pause', () => this.toggle());
    ms.setActionHandler('nexttrack', () => this.next());
    ms.setActionHandler('previoustrack', () => this.prev());
    try { ms.setActionHandler('seekto', (d) => this.seek(d.seekTime)); } catch { /* non pris en charge */ }
    this.addEventListener('track', () => {
      const t = this.current;
      if (!t || !window.MediaMetadata) return;
      ms.metadata = new MediaMetadata({
        title: t.title,
        artist: t.artists.join(', '),
        album: t.album,
        artwork: t.artwork ? [{ src: t.artwork, sizes: '300x300' }] : [],
      });
    });
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

export { api };
