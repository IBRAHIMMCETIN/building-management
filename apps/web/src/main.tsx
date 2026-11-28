import './index.css';
import { loadWithReload } from './lib/chunkReload';
import { bootMode, clearPrerender } from './lib/landingBoot';
import { registerServiceWorker } from './lib/pwa';

const root = document.getElementById('root');
if (!root) throw new Error('#root bulunamadı');
const container = root;

/**
 * Parca yuklenemezse (yeni surum yayinlandi, ag kesildi): bir kez yenilenir (lib/chunkReload.ts);
 * yine olmazsa on-render sayfa oldugu gibi kalir, uygulamada kisa bir mesaj gosterilir.
 */
function failed(err: unknown, showMessage: boolean) {
  console.error('Uygulama yüklenemedi', err);
  if (!showMessage) return;
  const p = document.createElement('p');
  p.setAttribute('role', 'alert');
  p.style.padding = '1rem';
  p.textContent = 'Sayfa yüklenemedi. Bağlantınızı kontrol edip sayfayı yenileyin.';
  container.replaceChildren(p);
}

// On-render sayfa (oturumsuz `/`, hukuki metinler): yalnizca o agac hidrate edilir; router, Amplify ve
// panel kodu indirilmez. Diger her durumda uygulama acilir (bkz. lib/landingBoot.ts).
const mode = bootMode(container);
if (mode.kind === 'landing') {
  loadWithReload(() => import('./pages/public/landing/island')).then((m) => m.hydrateLanding(container), (err) => failed(err, false));
} else if (mode.kind === 'legal') {
  loadWithReload(() => import('./pages/public/legal/island')).then((m) => m.hydrateLegal(container, mode.docKey), (err) => failed(err, false));
} else {
  clearPrerender(container);
  loadWithReload(() => import('./appRoot')).then((m) => m.renderApp(container), (err) => failed(err, true));
}

registerServiceWorker();
