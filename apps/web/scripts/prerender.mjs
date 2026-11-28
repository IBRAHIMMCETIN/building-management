/*
 * Derleme sonu on-render: tanitim sayfasini (`/`) ve hukuki metinleri statik HTML olarak yazar.
 *
 *   vite build                                                  -> dist/ (istemci paketi)
 *   vite build --ssr src/prerender.tsx --outDir dist-prerender  -> gecici Node modulu
 *   node scripts/prerender.mjs                                  -> bu betik
 *
 * Cikti: dist/index.html (`/`), dist/kvkk.html, dist/gizlilik.html, dist/kullanim-kosullari.html;
 * sayfa ve <head> uretimi src/prerender.tsx + src/prerenderHtml.ts. Cloudflare Pages `/kvkk` istegine
 * kvkk.html'i, bilinmeyen adreslere (uygulama rotalari, 404.html yok = SPA modu) index.html'i dondurur;
 * orada on-render icerik index.html'deki satir ici betik + CSS ile boyanmadan gizlenir ve uygulama
 * acilinca silinir (src/lib/landingBoot.ts). Cikti beklenen bicimde degilse derleme hata verir.
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ssrDir = path.join(webRoot, 'dist-prerender');
const distDir = path.join(webRoot, 'dist');

try {
  const { buildPages } = await import(pathToFileURL(path.join(ssrDir, 'prerender.js')).href);
  const template = await readFile(path.join(distDir, 'index.html'), 'utf8');
  for (const { file, html } of buildPages(template)) {
    if (!html.includes('data-prerender=') || !html.includes('id="ana-icerik"')) throw new Error(`on-render ciktisi beklenen bicimde degil: ${file}`);
    await writeFile(path.join(distDir, file), html);
    console.log(`prerender: ${file} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
  }
} finally {
  await rm(ssrDir, { recursive: true, force: true });
}
