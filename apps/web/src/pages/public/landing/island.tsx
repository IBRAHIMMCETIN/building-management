import { hydrateRoot } from 'react-dom/client';
import { LandingPage } from './LandingPage';

/**
 * On-render edilmis tanitim sayfasini (dist/index.html, scripts/prerender.mjs) tarayicida etkilesimli
 * yapar. Agac sunucudakiyle birebir aynidir (`src/prerender.tsx`): router, oturum ve uygulama kodu
 * yoktur; "Giriş yap" duz baglantiyla /login'e gider ve orada uygulama acilir.
 */
export function hydrateLanding(root: HTMLElement) {
  hydrateRoot(root, <LandingPage />, {
    onRecoverableError: (error) => console.warn('Tanıtım sayfası hidrasyonu istemcide yeniden çizildi', error),
  });
}
