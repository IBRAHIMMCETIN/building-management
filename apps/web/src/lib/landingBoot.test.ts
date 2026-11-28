// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import html from '../../index.html?raw';
import { APP_SHELL_ATTR, PRERENDER_ATTR, bootMode, clearPrerender } from './landingBoot';

/** index.html'deki satir ici karar betigi: gercek dosyadan okunur ve calistirilir. */
const inlineScript = /<script id="boot-mode">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';

function runInline(pathname: string) {
  window.history.replaceState(null, '', pathname);
  document.documentElement.removeAttribute(APP_SHELL_ATTR);
  new Function(inlineScript)();
  return document.documentElement.hasAttribute(APP_SHELL_ATTR);
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(APP_SHELL_ATTR);
  window.history.replaceState(null, '', '/');
});

describe('acilis karari (index.html satir ici betik)', () => {
  it('betik var; on-render icerigi uygulama kabugunda gizleyen CSS ayni isaretleri kullanir', () => {
    expect(inlineScript).toContain(APP_SHELL_ATTR);
    expect(html).toContain(`html[${APP_SHELL_ATTR}] #root[${PRERENDER_ATTR}]`);
    expect(html).toContain('<div id="root"></div>');
  });

  it('oturumsuz / -> tanitim; uygulama rotalari -> uygulama kabugu', () => {
    expect(runInline('/')).toBe(false);
    for (const p of ['/login', '/admin', '/app/dues', '/gecis/abc', '/kvkk']) expect(runInline(p), p).toBe(true);
  });

  it('saklanan oturum izi (Amplify Cognito veya mock) varsa / da uygulama acilir (panele yonlendirme)', () => {
    localStorage.setItem('CognitoIdentityServiceProvider.client123.LastAuthUser', 'u1');
    expect(runInline('/')).toBe(true);
    localStorage.clear();
    localStorage.setItem('bm.mock-session', '{}');
    expect(runInline('/')).toBe(true);
    localStorage.clear();
    localStorage.setItem('CognitoIdentityServiceProvider.client123.u1.idToken', 'x');
    expect(runInline('/')).toBe(false);
  });
});

describe('bootMode / clearPrerender', () => {
  it('yalnizca on-render isareti varken ve kabuk istenmemisken tanitim hidrate edilir', () => {
    const root = document.createElement('div');
    expect(bootMode(root)).toBe('app');
    root.setAttribute(PRERENDER_ATTR, 'landing');
    expect(bootMode(root)).toBe('landing');
    document.documentElement.setAttribute(APP_SHELL_ATTR, '');
    expect(bootMode(root)).toBe('app');
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
