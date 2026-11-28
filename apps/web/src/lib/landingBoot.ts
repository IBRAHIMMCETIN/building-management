import type { LegalDocumentKey } from '@bm/shared/legal/documents';

/**
 * On-render edilen hukuki metin anahtarlari. Metin modulu burada IMPORT EDILMEZ (acilis paketi kucuk
 * kalsin); `LEGAL_DOCUMENT_ORDER` ile esitligi landingBoot.test.ts korur.
 */
export const PRERENDERED_LEGAL_KEYS: readonly LegalDocumentKey[] = ['kvkk', 'privacy', 'terms'];

/**
 * Acilista hangi agacin calisacagi. Derlemede `/` (tanitim) ve hukuki metinler statik HTML'e on-render
 * edilir (scripts/prerender.mjs): #root `data-prerender="landing" | "legal:<anahtar>"` tasir ve dosya
 * kendi adresini `<meta name="bm-prerender">` ile bildirir. Cloudflare Pages bilinmeyen adreslere
 * (uygulama rotalari) index.html'i (tanitim) dondurur.
 *
 * `index.html`'deki satir ici betik, sayfa boyanmadan ONCE karar verir ve uygulama gerekiyorsa <html>'e
 * `data-app-shell` koyar (CSS on-render icerigi gizler, bir an bile gorunmez), ayrica kanonik / og:url
 * etiketlerini kaldirir (kanonik yalnizca kendi adresinde) ve uygulama parcalarini onceden ister:
 *   - adres dosyanin kendi adresi degilse (uygulama rotalari), veya
 *   - adres `/` ve tarayicida saklanan bir oturum izi varsa (Amplify
 *     `CognitoIdentityServiceProvider.*.LastAuthUser`, yerel mock `bm.mock-session`): giris yapmis
 *     kullanici bugunku gibi paneline yonlenir.
 * `main.tsx` bu isarete uyar: on-render sayfa yalnizca hidrate edilir (uygulama kodu inmez), aksi halde
 * on-render icerik temizlenir ve uygulama acilir.
 */
export const PRERENDER_ATTR = 'data-prerender';
export const APP_SHELL_ATTR = 'data-app-shell';

export type BootMode = { kind: 'app' } | { kind: 'landing' } | { kind: 'legal'; docKey: LegalDocumentKey };

export function bootMode(root: HTMLElement, doc: Document = document): BootMode {
  const key = root.getAttribute(PRERENDER_ATTR);
  if (!key || doc.documentElement.hasAttribute(APP_SHELL_ATTR)) return { kind: 'app' };
  if (key === 'landing') return { kind: 'landing' };
  const docKey = key.startsWith('legal:') ? key.slice('legal:'.length) : '';
  return (PRERENDERED_LEGAL_KEYS as readonly string[]).includes(docKey) ? { kind: 'legal', docKey: docKey as LegalDocumentKey } : { kind: 'app' };
}

/** Uygulama acilmadan once on-render edilmis icerigi ve isaretini kaldirir. */
export function clearPrerender(root: HTMLElement): void {
  if (!root.hasAttribute(PRERENDER_ATTR)) return;
  root.replaceChildren();
  root.removeAttribute(PRERENDER_ATTR);
}
