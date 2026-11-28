/**
 * Acilista hangi agacin calisacagi. Cloudflare Pages her adrese ayni `index.html`'i dondurur; bu
 * dosyanin #root'unda derlemede on-render edilmis tanitim sayfasi vardir (`data-prerender="landing"`).
 *
 * `index.html`'deki satir ici betik, sayfa boyanmadan ONCE karar verir ve uygulama gerekiyorsa
 * <html>'e `data-app-shell` koyar (CSS on-render icerigi gizler, tanitim sayfasi bir an bile gorunmez):
 *   - adres `/` degilse (uygulama rotalari), veya
 *   - tarayicida saklanan bir oturum izi varsa (Amplify `CognitoIdentityServiceProvider.*.LastAuthUser`,
 *     yerel mock `bm.mock-session`): giris yapmis kullanici bugunku gibi paneline yonlenir.
 * `main.tsx` bu isarete uyar: tanitim sayfasi yalnizca hidrate edilir (uygulama kodu inmez), aksi
 * halde on-render icerik temizlenir ve uygulama acilir.
 */
export const PRERENDER_ATTR = 'data-prerender';
export const APP_SHELL_ATTR = 'data-app-shell';

export type BootMode = 'landing' | 'app';

export function bootMode(root: HTMLElement, doc: Document = document): BootMode {
  return root.getAttribute(PRERENDER_ATTR) === 'landing' && !doc.documentElement.hasAttribute(APP_SHELL_ATTR) ? 'landing' : 'app';
}

/** Uygulama acilmadan once on-render edilmis tanitim icerigini ve isaretini kaldirir. */
export function clearPrerender(root: HTMLElement): void {
  if (!root.hasAttribute(PRERENDER_ATTR)) return;
  root.replaceChildren();
  root.removeAttribute(PRERENDER_ATTR);
}
