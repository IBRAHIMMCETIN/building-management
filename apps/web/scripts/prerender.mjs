/*
 * Derleme sonu on-render: tanitim sayfasini (`/`) statik HTML olarak dist/index.html'e yazar.
 *
 *   vite build                                              -> dist/ (istemci paketi)
 *   vite build --ssr src/prerender.tsx --outDir dist-prerender  -> gecici Node modulu
 *   node scripts/prerender.mjs                              -> bu betik
 *
 * Cloudflare Pages her adrese ayni dist/index.html'i dondurur (404.html yok = SPA modu). Uygulama
 * rotalarinda ve giris yapmis kullanicida on-render icerik index.html'deki satir ici betik + CSS ile
 * boyanmadan gizlenir ve uygulama acilinca silinir (src/lib/landingBoot.ts). Cikti bos veya
 * isaret bulunamazsa derleme hata verir (sessizce on-render'siz yayin yok).
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ssrDir = path.join(webRoot, 'dist-prerender');
const indexPath = path.join(webRoot, 'dist', 'index.html');
const MARKER = '<div id="root"></div>';

try {
  const { render } = await import(pathToFileURL(path.join(ssrDir, 'prerender.js')).href);
  const html = render();
  if (typeof html !== 'string' || !html.includes('id="ana-icerik"')) throw new Error('on-render ciktisi beklenen tanitim sayfasi degil');

  const template = await readFile(indexPath, 'utf8');
  if (!template.includes(MARKER)) throw new Error(`dist/index.html icinde ${MARKER} bulunamadi`);
  await writeFile(indexPath, template.replace(MARKER, `<div id="root" data-prerender="landing">${html}</div>`));
  console.log(`prerender: / -> dist/index.html (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB HTML)`);
} finally {
  await rm(ssrDir, { recursive: true, force: true });
}
