// @vitest-environment happy-dom
import { LEGAL_DOCUMENT_ORDER } from '@bm/shared/legal/documents';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import { APP_SHELL_ATTR, PRERENDERED_LEGAL_KEYS, PRERENDER_ATTR, bootMode, clearPrerender } from './landingBoot';

/** index.html'deki satir ici karar betigi: gercek dosyadan okunur ve calistirilir. */
const inlineScript = /<script id="boot-mode">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

/** Derlenmis bir HTML dosyasinin <head>'i: kendi adresi (bm-prerender), kanonik ve og:url. */
function runInline(pathname: string, own: string | null, preload?: string[]) {
  window.history.replaceState(null, '', pathname);
  document.documentElement.removeAttribute(APP_SHELL_ATTR);
  document.head.innerHTML = [
    '<link rel="canonical" href="https://ornek.test/" />',
    '<meta property="og:url" content="https://ornek.test/" />',
    own === null ? '' : `<meta name="bm-prerender" content="${own}" />`,
  ].join('');
  const script = preload ? inlineScript.replace("'__APP_PRELOAD__'", JSON.stringify(preload)) : inlineScript;
  new Function(script)();
  return {
    app: document.documentElement.hasAttribute(APP_SHELL_ATTR),
    canonical: document.head.querySelector('link[rel="canonical"]') !== null,
    ogUrl: document.head.querySelector('meta[property="og:url"]') !== null,
    preloads: [...document.head.querySelectorAll('link[rel="modulepreload"]')].map((l) => l.getAttribute('href')),
  };
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(APP_SHELL_ATTR);
  document.head.innerHTML = '';
  window.history.replaceState(null, '', '/');
});

describe('acilis karari (index.html satir ici betik)', () => {
  it('betik <head>de, modul betiginden once; on-render icerigi gizleyen CSS ayni isaretleri kullanir', () => {
    expect(inlineScript).toContain(APP_SHELL_ATTR);
    expect(html).toContain(`html[${APP_SHELL_ATTR}] #root[${PRERENDER_ATTR}]`);
    expect(html.indexOf('<script id="boot-mode">')).toBeLessThan(html.indexOf('</head>'));
    expect(html.indexOf('<script id="boot-mode">')).toBeLessThan(html.indexOf('<script type="module"'));
    expect(html).toContain('<div id="root"></div>');
  });

  it('dosyanin kendi adresinde oturumsuz ziyaretci on-render sayfayi gorur; kanonik kalir', () => {
    expect(runInline('/', '/')).toMatchObject({ app: false, canonical: true, ogUrl: true });
    expect(runInline('/kvkk', '/kvkk')).toMatchObject({ app: false, canonical: true, ogUrl: true });
  });

  it('baska adres (SPA yedegi olarak donen index.html): uygulama acilir, kanonik ve og:url kaldirilir', () => {
    for (const p of ['/login', '/admin', '/app/dues', '/gecis/abc', '/gizlilik']) {
      expect(runInline(p, '/'), p).toEqual({ app: true, canonical: false, ogUrl: false, preloads: [] });
    }
    // Gelistirmede (on-render yok) her adres uygulamadir.
    expect(runInline('/', null).app).toBe(true);
  });

  it('`/`de saklanan oturum izi (Amplify Cognito veya mock) varsa uygulama acilir (panele yonlendirme)', () => {
    localStorage.setItem('CognitoIdentityServiceProvider.client123.LastAuthUser', 'u1');
    expect(runInline('/', '/').app).toBe(true);
    localStorage.clear();
    localStorage.setItem('bm.mock-session', '{}');
    expect(runInline('/', '/').app).toBe(true);
    // Hukuki metinler oturumdan bagimsiz okunur.
    expect(runInline('/kvkk', '/kvkk').app).toBe(false);
    localStorage.clear();
    localStorage.setItem('CognitoIdentityServiceProvider.client123.u1.idToken', 'x');
    expect(runInline('/', '/').app).toBe(false);
  });

  it('derlemede doldurulan uygulama parcalari yalnizca uygulama acilacaksa modulepreload edilir', () => {
    const files = ['/assets/appRoot-x.js', '/assets/vendor-auth-y.js'];
    expect(runInline('/admin', '/', files).preloads).toEqual(files);
    expect(runInline('/', '/', files).preloads).toEqual([]);
  });
});

describe('bootMode / clearPrerender', () => {
  it('on-render anahtarina gore tanitim veya hukuki metin hidrate edilir; kabuk istenmisse uygulama', () => {
    const root = document.createElement('div');
    expect(bootMode(root)).toEqual({ kind: 'app' });
    root.setAttribute(PRERENDER_ATTR, 'landing');
    expect(bootMode(root)).toEqual({ kind: 'landing' });
    root.setAttribute(PRERENDER_ATTR, 'legal:privacy');
    expect(bootMode(root)).toEqual({ kind: 'legal', docKey: 'privacy' });
    root.setAttribute(PRERENDER_ATTR, 'legal:yok');
    expect(bootMode(root)).toEqual({ kind: 'app' });
    root.setAttribute(PRERENDER_ATTR, 'landing');
    document.documentElement.setAttribute(APP_SHELL_ATTR, '');
    expect(bootMode(root)).toEqual({ kind: 'app' });
  });

  it('acilis paketindeki hukuki anahtar listesi metin moduluyle ayni', () => {
    expect([...PRERENDERED_LEGAL_KEYS]).toEqual([...LEGAL_DOCUMENT_ORDER]);
  });

  it('uygulama acilmadan once on-render icerik ve isaret temizlenir', () => {
    const root = document.createElement('div');
    root.setAttribute(PRERENDER_ATTR, 'landing');
    root.innerHTML = '<main id="ana-icerik">tanıtım</main>';
    clearPrerender(root);
    expect(root.childNodes).toHaveLength(0);
    expect(root.hasAttribute(PRERENDER_ATTR)).toBe(false);
  });
});
