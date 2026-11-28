import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER, type LegalDocumentKey } from '@bm/shared/legal/documents';
import { BRAND_NAME } from '@bm/shared/brand';

/**
 * Derleme sonu on-render: hangi adres hangi statik HTML dosyasina yazilir ve sayfaya ozel <head>
 * (baslik, aciklama, kanonik adres, Open Graph / Twitter) nasil uretilir. Saf metin islemleri; React
 * render'i `src/prerender.tsx`'te, dosya yazimi `scripts/prerender.mjs`'te.
 *
 * Cloudflare Pages `/kvkk` istegine `kvkk.html`'i, bilinmeyen adreslere (uygulama rotalari) `index.html`'i
 * dondurur. Her dosya kendi adresini `<meta name="bm-prerender">` ile tasir; index.html'deki satir ici
 * betik adres bu degilse (uygulama rotasi) on-render icerigi boyanmadan gizler ve kanonik / og:url
 * etiketlerini kaldirir (kanonik yalnizca kendi adresinde).
 */

/** Yayindaki adres (alan adi alininca degisir; index.html, robots.txt ve sitemap.xml ile ayni). */
export const SITE_URL = 'https://building-management-apx.pages.dev';

export type PrerenderKey = 'landing' | `legal:${LegalDocumentKey}`;

export type PrerenderPage = {
  key: PrerenderKey;
  /** Sayfanin adresi (`/`, `/kvkk`, ...). */
  path: string;
  /** dist/ altindaki dosya. */
  file: string;
  title: string;
  description: string;
};

export const LANDING_TITLE = `${BRAND_NAME} | Site, apartman ve toplu konut yönetim sistemi`;

export const PRERENDER_PAGES: readonly PrerenderPage[] = [
  {
    key: 'landing',
    path: '/',
    file: 'index.html',
    title: LANDING_TITLE,
    description:
      'Çok bloklu siteler için aidat ve tahsilat, banka ekstresi eşleştirme, arıza ve bakım, güvenlik kapısı ve genel kurul. Pilot dönemde ücretsiz deneme.',
  },
  ...LEGAL_DOCUMENT_ORDER.map((key): PrerenderPage => {
    const doc = LEGAL_DOCUMENTS[key];
    return { key: `legal:${key}`, path: doc.path, file: `${doc.path.slice(1)}.html`, title: `${doc.title} (taslak) | ${BRAND_NAME}`, description: doc.summary };
  }),
];

export const ROOT_MARKER = '<div id="root"></div>';
const BOOT_SCRIPT = '<script id="boot-mode">';

const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Ilk eslesmeyi degistirir (degerdeki `$` desen olarak yorumlanmaz); yoksa derleme hata verir. */
function replaceOnce(html: string, pattern: RegExp, replace: (...groups: string[]) => string, label: string): string {
  if (!pattern.test(html)) throw new Error(`on-render: index.html icinde ${label} bulunamadi`);
  return html.replace(pattern, (_m, ...groups: string[]) => replace(...groups));
}

/** `<tag ... attr="DEGER"`: yalnizca deger degisir. */
function setAttr(html: string, prefix: string, value: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return replaceOnce(html, new RegExp(`(${escaped})[^"]*(")`), (a, b) => `${a}${escapeAttr(value)}${b}`, prefix);
}

/** Sablona (dist/index.html) sayfanin <head> bilgilerini ve on-render govdesini yazar. */
export function injectPage(template: string, page: PrerenderPage, bodyHtml: string, siteUrl = SITE_URL): string {
  const url = `${siteUrl}${page.path}`;
  let html = replaceOnce(template, /<title>[^<]*<\/title>/, () => `<title>${escapeText(page.title)}</title>`, '<title>');
  html = setAttr(html, '<meta name="description" content="', page.description);
  html = setAttr(html, '<link rel="canonical" href="', url);
  html = setAttr(html, '<meta property="og:url" content="', url);
  html = setAttr(html, '<meta property="og:title" content="', page.title);
  html = setAttr(html, '<meta property="og:description" content="', page.description);
  html = setAttr(html, '<meta name="twitter:title" content="', page.title);
  html = setAttr(html, '<meta name="twitter:description" content="', page.description);
  if (!html.includes(BOOT_SCRIPT)) throw new Error('on-render: index.html icinde acilis betigi bulunamadi');
  html = html.replace(BOOT_SCRIPT, () => `<meta name="bm-prerender" content="${escapeAttr(page.path)}" />\n    ${BOOT_SCRIPT}`);
  if (!html.includes(ROOT_MARKER)) throw new Error(`on-render: index.html icinde ${ROOT_MARKER} bulunamadi`);
  return html.replace(ROOT_MARKER, () => `<div id="root" data-prerender="${page.key}">${bodyHtml}</div>`);
}
