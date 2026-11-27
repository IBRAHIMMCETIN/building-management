/**
 * Service worker kaydi (public/sw.js). Yalnizca production derlemesinde ve destekleyen
 * tarayicida; gelistirmede (Vite HMR) onbellek karisikligi olmasin diye kaydedilmez.
 */
export function registerServiceWorker(env: { PROD: boolean } = import.meta.env, nav: Navigator = navigator): boolean {
  if (!env.PROD || !('serviceWorker' in nav)) return false;
  window.addEventListener('load', () => {
    nav.serviceWorker.register('/sw.js').catch((err: unknown) => {
      console.warn('Service worker kaydedilemedi', err);
    });
  });
  return true;
}
