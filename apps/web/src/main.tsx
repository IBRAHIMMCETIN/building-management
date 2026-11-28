import './index.css';
import { bootMode, clearPrerender } from './lib/landingBoot';
import { registerServiceWorker } from './lib/pwa';

const root = document.getElementById('root');
if (!root) throw new Error('#root bulunamadı');

// Tanitim sayfasi (on-render, oturumsuz `/`): yalnizca o agac hidrate edilir; router, Amplify ve
// panel kodu indirilmez. Diger her durumda uygulama acilir (bkz. lib/landingBoot.ts).
if (bootMode(root) === 'landing') {
  void import('./pages/public/landing/island').then((m) => m.hydrateLanding(root));
} else {
  clearPrerender(root);
  void import('./appRoot').then((m) => m.renderApp(root));
}

registerServiceWorker();
