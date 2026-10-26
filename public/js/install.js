// Installation de l'application (PWA) : invite native sur Android / Windows / macOS, instructions sur iOS.
let deferred = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferred = e;
  install.dispatchEvent(new Event('change'));
});
window.addEventListener('appinstalled', () => {
  deferred = null;
  install.dispatchEvent(new Event('change'));
});

const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

class Install extends EventTarget {
  state() {
    if (standalone()) return 'installed';
    if (deferred) return 'prompt';
    if (ios()) return 'ios';
    return 'manual';
  }
  async prompt() {
    if (!deferred) return false;
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
    deferred = null;
    this.dispatchEvent(new Event('change'));
    return outcome === 'accepted';
  }
}

export const install = new Install();
