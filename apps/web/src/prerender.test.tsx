// @vitest-environment happy-dom
import { LEGAL_DOCUMENTS, LEGAL_DOCUMENT_ORDER } from '@bm/shared/legal/documents';
import { describe, expect, it } from 'vitest';
import ogImage from '../public/brand/og-image.png?inline';
import template from '../index.html?raw';
import { buildPages } from './prerender';
import { PRERENDER_PAGES, SITE_URL, injectPage } from './prerenderHtml';

const pages = buildPages(template);
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('derleme sonu on-render ciktisi', () => {
  it('tanitim ve uc hukuki metin kendi dosyalarina yazilir', () => {
    expect(pages.map((p) => p.file)).toEqual(['index.html', 'kvkk.html', 'gizlilik.html', 'kullanim-kosullari.html']);
  });

  it.each(PRERENDER_PAGES.map((p, i) => [p.file, p, i] as const))('%s: on-render isareti, kendi adresi ve <head> bilgileri', (_file, page, i) => {
    const html = pages[i]!.html;
    const doc = parse(html);
    const root = doc.getElementById('root')!;
    expect(root.getAttribute('data-prerender')).toBe(page.key);
    expect(root.querySelector('main#ana-icerik')).toBeTruthy();
    expect(root.querySelectorAll('h1')).toHaveLength(1);
    expect(doc.querySelector('meta[name="bm-prerender"]')!.getAttribute('content')).toBe(page.path);
    expect(doc.title).toBe(page.title);
    expect(doc.querySelector('meta[name="description"]')!.getAttribute('content')).toBe(page.description);
    expect(doc.querySelector('link[rel="canonical"]')!.getAttribute('href')).toBe(`${SITE_URL}${page.path}`);
    expect(doc.querySelector('meta[property="og:url"]')!.getAttribute('content')).toBe(`${SITE_URL}${page.path}`);
    expect(doc.querySelector('meta[property="og:title"]')!.getAttribute('content')).toBe(page.title);
    // Karar betigi: kendi adres isaretinden sonra, modul betiginden once, <head> icinde.
    expect(html.indexOf('name="bm-prerender"')).toBeLessThan(html.indexOf('<script id="boot-mode">'));
    expect(html.indexOf('<script id="boot-mode">')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('<script id="boot-mode">')).toBeLessThan(html.indexOf('<script type="module"'));
    // Kanonik yalnizca bir tane.
    expect(doc.querySelectorAll('link[rel="canonical"]')).toHaveLength(1);
  });

  it('hukuki sayfalarin icerigi kendi metni; tanitim formu on-render HTML\'de tarayicinin kendi gonderimine kapali', () => {
    LEGAL_DOCUMENT_ORDER.forEach((key, i) => {
      const doc = parse(pages[i + 1]!.html);
      expect(doc.querySelector('#root h1')!.textContent).toBe(LEGAL_DOCUMENTS[key].title);
    });
    const landing = parse(pages[0]!.html);
    const form = landing.querySelector<HTMLFormElement>('#root form[aria-label="Demo talep formu"]')!;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(true);
  });

  it('sablonda beklenen etiket yoksa derleme hata verir (sessizce bozuk HTML yok)', () => {
    expect(() => injectPage(template.replace('<div id="root"></div>', '<div id="app"></div>'), PRERENDER_PAGES[0]!, '<main></main>')).toThrow(/root/);
    expect(() => injectPage(template.replace(/<link rel="canonical"[^>]*>/, ''), PRERENDER_PAGES[0]!, '<main></main>')).toThrow(/canonical/);
  });

  it('degerlerdeki ozel karakterler kacisli yazilir', () => {
    const html = injectPage(template, { ...PRERENDER_PAGES[0]!, title: 'A & B <x> "y" $1', description: 'd "q" $& <z>' }, '<main id="ana-icerik"></main>');
    expect(html).toContain('<title>A &amp; B &lt;x&gt; "y" $1</title>');
    expect(html).toContain('content="d &quot;q&quot; $&amp; &lt;z&gt;"');
  });

  it('paylasim gorseli: her sayfada 1200x630 PNG ve buyuk kart; aciklama arama sonucuna sigar', () => {
    for (const { html } of pages) {
      const doc = parse(html);
      expect(doc.querySelector('meta[property="og:image"]')!.getAttribute('content')).toBe(`${SITE_URL}/brand/og-image.png`);
      expect(doc.querySelector('meta[name="twitter:image"]')!.getAttribute('content')).toBe(`${SITE_URL}/brand/og-image.png`);
      expect(doc.querySelector('meta[name="twitter:card"]')!.getAttribute('content')).toBe('summary_large_image');
      expect(doc.querySelector('meta[property="og:image:alt"]')!.getAttribute('content')).toBeTruthy();
    }
    // PNG imzasi ve IHDR'deki genislik / yukseklik (bayt 16-23, big-endian).
    const png = Uint8Array.from(atob(ogImage.slice(ogImage.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const view = new DataView(png.buffer);
    expect(String.fromCharCode(...png.subarray(1, 4))).toBe('PNG');
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1200, 630]);
    expect(PRERENDER_PAGES[0]!.description.length).toBeLessThanOrEqual(160);
  });
});
