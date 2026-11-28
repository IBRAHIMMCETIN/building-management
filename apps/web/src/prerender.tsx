import { renderToString } from 'react-dom/server';
import { LandingPage } from './pages/public/landing/LandingPage';
import { LegalPage } from './pages/public/legal/LegalPage';
import { PRERENDER_PAGES, type PrerenderPage, injectPage } from './prerenderHtml';

/**
 * Derleme sonu on-render girisi (`vite build --ssr src/prerender.tsx`, ardindan scripts/prerender.mjs):
 * tanitim sayfasi `dist/index.html`'e, hukuki metinler `dist/kvkk.html`, `gizlilik.html`,
 * `kullanim-kosullari.html`'e kendi baslik / aciklama / kanonik adresleriyle yazilir. Tarayicida ayni
 * agac hidrate edilir (`pages/public/landing/island.tsx`, `pages/public/legal/island.tsx`).
 */
export function renderPage(page: PrerenderPage): string {
  if (page.key === 'landing') return renderToString(<LandingPage />);
  return renderToString(<LegalPage docKey={page.key.slice('legal:'.length) as Parameters<typeof LegalPage>[0]['docKey']} />);
}

export function buildPages(template: string): { file: string; html: string }[] {
  return PRERENDER_PAGES.map((page) => ({ file: page.file, html: injectPage(template, page, renderPage(page)) }));
}
