// @vitest-environment happy-dom
import { ApiError, NetworkError } from '@bm/shared/api/errors';
import { KVKK_NOTICE } from '@bm/shared/legal/documents';
import { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NAV_LINKS, SECTION_IDS } from './content';
import { DemoRequestForm, SEND_FAILED_MESSAGE, TOO_MANY_REQUESTS_MESSAGE } from './DemoRequestForm';
import { LandingPage } from './LandingPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot> | undefined;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  container.remove();
  vi.restoreAllMocks();
});

async function render(node: React.ReactNode) {
  root = createRoot(container);
  await act(async () => root!.render(node));
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Etiket metniyle alan (FormField etiketi id ile baglar). */
function field<T extends HTMLElement>(label: string): T {
  const l = [...container.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  if (!l) throw new Error(`etiket yok: ${label}`);
  const el = container.querySelector<T>(`#${CSS.escape(l.htmlFor)}`);
  if (!el) throw new Error(`alan yok: ${label}`);
  return el;
}

async function fillValid() {
  await act(async () => {
    setValue(field<HTMLInputElement>('Ad soyad'), 'Ayşe Yılmaz');
    setValue(field<HTMLInputElement>('E-posta'), 'Ayse@Ornek.com');
    setValue(field<HTMLInputElement>('Site veya firma adı'), 'Gül Sitesi');
    const select = field<HTMLSelectElement>('Bağımsız bölüm sayısı');
    select.value = '201-500';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
}

async function submit() {
  await act(async () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
  await flush();
}

const errorTexts = () => [...container.querySelectorAll('.text-danger')].map((e) => e.textContent?.trim());

describe('tanitim sayfasi', () => {
  it('yer imleri ve baslik duzeni: ust cubuk, tek h1, bolum basina h2, ana icerik, alt bilgi', async () => {
    await render(<LandingPage />);
    expect(container.querySelectorAll('header')).toHaveLength(1);
    expect(container.querySelectorAll('main#ana-icerik')).toHaveLength(1);
    expect(container.querySelectorAll('footer')).toHaveLength(1);
    const h1 = container.querySelectorAll('h1');
    expect(h1).toHaveLength(1);
    expect(h1[0]!.textContent).toContain('sitenizin bütün işleri tek yerde');
    // Her bolum basligina bagli ve bir h2 tasir; h2'den once h3 yok.
    for (const id of Object.values(SECTION_IDS)) {
      const section = container.querySelector(`section#${id}`)!;
      expect(section, id).toBeTruthy();
      const labelled = container.querySelector(`#${section.getAttribute('aria-labelledby')}`)!;
      expect(labelled.tagName).toBe('H2');
    }
    const headings = [...container.querySelectorAll('main h1, main h2, main h3')].map((h) => Number(h.tagName[1]));
    headings.forEach((level, i) => {
      if (i > 0) expect(level - headings[i - 1]!).toBeLessThanOrEqual(1);
    });
    // Icerige gec baglantisi ilk odaklanabilir oge.
    expect(container.querySelector('a')!.getAttribute('href')).toBe('#ana-icerik');
  });

  it('menu baglantilari var olan bolumlere gider; Giris yap /login, Demo talep et #iletisim', async () => {
    await render(<LandingPage />);
    const nav = container.querySelector('nav[aria-label="Sayfa bölümleri"]')!;
    const hrefs = [...nav.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(NAV_LINKS.map((l) => l.href));
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Özellikler', 'Kimler için', 'Mobil', 'SSS', 'İletişim']);
    for (const href of hrefs) expect(container.querySelector(href!), href!).toBeTruthy();
    const links = [...container.querySelectorAll('a')];
    expect(links.filter((a) => a.textContent?.includes('Giriş yap')).every((a) => a.getAttribute('href') === '/login')).toBe(true);
    expect(links.filter((a) => a.textContent?.trim() === 'Demo talep et').map((a) => a.getAttribute('href'))).toContain('#iletisim');
    // Hukuki sayfalar alt bilgide.
    const footerHrefs = [...container.querySelectorAll('footer a')].map((a) => a.getAttribute('href'));
    expect(footerHrefs).toEqual(expect.arrayContaining(['/kvkk', '/gizlilik', '/kullanim-kosullari']));
  });

  it('mobil menu: dugme aria-expanded ile acilir, baglantiya tiklayinca ve Escape ile kapanir', async () => {
    await render(<LandingPage />);
    const button = container.querySelector<HTMLButtonElement>('button[aria-controls="public-menu"]')!;
    const panel = container.querySelector<HTMLElement>('#public-menu')!;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(panel.hidden).toBe(true);
    await act(async () => button.click());
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(panel.hidden).toBe(false);
    await act(async () => panel.querySelector<HTMLAnchorElement>('a[href="#sss"]')!.click());
    expect(panel.hidden).toBe(true);
    await act(async () => button.click());
    panel.querySelector<HTMLAnchorElement>('a[href="#sss"]')!.focus();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel.hidden).toBe(true);
    expect(button.textContent).toContain('Menüyü aç');
    // Odak gizlenen panelde kalmaz.
    expect(document.activeElement).toBe(button);
    // Odak panelin disindaysa (ornegin formda) Escape onu yerinden oynatmaz.
    const name = container.querySelector<HTMLInputElement>('#iletisim input')!;
    await act(async () => button.click());
    name.focus();
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(name);
  });

  it('SSS: yerel details/summary; fiyat sorusu teklif istemeye yonlendirir, canli olmayan ozellikler "henuz" der', async () => {
    await render(<LandingPage />);
    const details = container.querySelectorAll(`#${SECTION_IDS.faq} details`);
    expect(details.length).toBeGreaterThanOrEqual(5);
    expect(details.length).toBeLessThanOrEqual(7);
    const text = container.textContent ?? '';
    expect(text).toContain('henüz kullanıma açılmadı');
    expect(text).toContain('Yakında App Store ve Google Play’de');
    expect(container.querySelector(`#${SECTION_IDS.pricing} a`)!.getAttribute('href')).toBe('#iletisim');
  });

  it('sunucuda on-render edilen HTML tarayicida hatasiz hidrate edilir (uyusmazlik yok)', async () => {
    const html = renderToString(<LandingPage />);
    container.innerHTML = html;
    const recoverable = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await act(async () => {
      root = hydrateRoot(container, <LandingPage />, { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    // Hidrasyondan sonra etkilesim calisir.
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-controls="public-menu"]')!.click());
    expect(container.querySelector<HTMLElement>('#public-menu')!.hidden).toBe(false);
  });
});

describe('demo talep formu', () => {
  it('bos gonderimde zorunlu alanlarin hatasi alan altinda; istek gitmez', async () => {
    const send = vi.fn().mockResolvedValue({ received: true });
    await render(<DemoRequestForm submit={send} />);
    await submit();
    expect(send).not.toHaveBeenCalled();
    expect(errorTexts()).toEqual(
      expect.arrayContaining([
        'Adınızı ve soyadınızı yazın',
        'E-posta adresinizi yazın',
        'Site veya firma adını yazın',
        'Bağımsız bölüm sayısını seçin',
        'Devam etmek için aydınlatma metnini okuduğunuzu onaylayın',
      ]),
    );
    const email = field<HTMLInputElement>('E-posta');
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(email.getAttribute('aria-describedby')).toBeTruthy();
  });

  it('gecersiz e-posta ve telefon', async () => {
    const send = vi.fn();
    await render(<DemoRequestForm submit={send} />);
    await fillValid();
    await act(async () => {
      setValue(field<HTMLInputElement>('E-posta'), 'ayse@');
      setValue(field<HTMLInputElement>('Telefon (isteğe bağlı)'), '12');
    });
    await submit();
    expect(send).not.toHaveBeenCalled();
    expect(errorTexts()).toEqual(expect.arrayContaining(['Geçerli bir e-posta adresi yazın', 'Telefon numarasını 05xx xxx xx xx biçiminde yazın']));
  });

  it('gecerli gonderim: govde (surumlu KVKK onayi, kucuk harf e-posta, bos alanlar yok), basari durumu odakta', async () => {
    const send = vi.fn().mockResolvedValue({ received: true });
    await render(<DemoRequestForm submit={send} />);
    await fillValid();
    await submit();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![0]).toEqual({
      fullName: 'Ayşe Yılmaz',
      email: 'ayse@ornek.com',
      organization: 'Gül Sitesi',
      unitRange: '201-500',
      kvkkConsent: true,
      kvkkVersion: KVKK_NOTICE.version,
    });
    await act(async () => new Promise((r) => requestAnimationFrame(() => r(undefined))));
    const status = container.querySelector('[role="status"]')!;
    expect(status.textContent).toContain('Talebiniz alındı');
    expect(document.activeElement).toBe(status);
    expect(container.querySelector('form')).toBeNull();
  });

  it('sunucu hatasi (429): API mesaji formun ustunde, girilenler korunur, tekrar gonderilebilir', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(429, { error: 'rate_limited', message: 'Bu bağlantıdan çok fazla talep gönderildi. 50 dakika sonra tekrar deneyin.' }))
      .mockResolvedValueOnce({ received: true });
    await render(<DemoRequestForm submit={send} />);
    await fillValid();
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain('50 dakika sonra');
    expect(field<HTMLInputElement>('Ad soyad').value).toBe('Ayşe Yılmaz');
    await submit();
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Talebiniz alındı');
  });

  it.each([
    ['ag / CORS hatasi (API Gateway 429 CORS basliksiz olabilir)', new NetworkError(new TypeError('Failed to fetch')), SEND_FAILED_MESSAGE],
    ['API Gateway 429 (bizim govde bicimimiz degil)', new ApiError(429), TOO_MANY_REQUESTS_MESSAGE],
    ['beklenmeyen hata', new Error('boom'), 'Beklenmeyen bir hata oluştu.'],
  ])('%s: anlasilir mesaj', async (_label, err, message) => {
    const send = vi.fn().mockRejectedValue(err);
    await render(<DemoRequestForm submit={send} />);
    await fillValid();
    await submit();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe(message);
  });

  it('bal kupu alani anlamsiz adli, ekran okuyucudan / klavyeden gizli, otomatik doldurmaya kapali; KVKK baglantisi yeni sekmede', async () => {
    await render(<DemoRequestForm submit={vi.fn()} />);
    expect(container.querySelector('input[name="website"]')).toBeNull();
    const trap = container.querySelector<HTMLInputElement>('input[name="bmCheck"]')!;
    expect(trap.tabIndex).toBe(-1);
    expect(trap.getAttribute('autocomplete')).toBe('off');
    expect(trap.closest('[aria-hidden="true"]')).toBeTruthy();
    const kvkk = container.querySelector<HTMLAnchorElement>('a[href="/kvkk"]')!;
    expect(kvkk.target).toBe('_blank');
    expect(kvkk.rel).toContain('noopener');
  });

  it('hidrasyondan once (on-render HTML): form POST, gonder dugmesi kapali; alanlar adrese dusmez', async () => {
    container.innerHTML = renderToString(<DemoRequestForm submit={vi.fn()} />);
    const form = container.querySelector<HTMLFormElement>('form')!;
    expect(form.getAttribute('method')).toBe('post');
    expect(form.getAttribute('action')).toBe('#iletisim');
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(button.disabled).toBe(true);
    // Bilesen baglaninca dugme acilir.
    container.innerHTML = '';
    await render(<DemoRequestForm submit={vi.fn()} />);
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
});
