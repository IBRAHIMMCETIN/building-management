// @vitest-environment happy-dom
import { ApiError, NetworkError } from '@bm/shared/api/errors';
import { KVKK_NOTICE } from '@bm/shared/legal/documents';
import { act } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FAQS, HERO, NAV_LINKS, PILOT, SECTION_IDS, STEPS, TRUST } from './content';
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
    expect(h1[0]!.textContent).toBe(HERO.title);
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
    expect([...nav.querySelectorAll('a')].map((a) => a.textContent)).toEqual(['Nasıl çalışır', 'Kimler için', 'Özellikler', 'Mobil', 'Güven ve uyum', 'SSS']);
    for (const href of hrefs) expect(container.querySelector(href!), href!).toBeTruthy();
    const links = [...container.querySelectorAll('a')];
    expect(links.filter((a) => a.textContent?.includes('Giriş yap')).every((a) => a.getAttribute('href') === '/login')).toBe(true);
    // Butun "Demo talep et" eylemleri (ust cubuk, kahraman, pilot bandi, alt bilgi) forma gider.
    const demo = links.filter((a) => a.textContent?.trim() === 'Demo talep et');
    expect(demo.length).toBeGreaterThanOrEqual(4);
    expect(demo.every((a) => a.getAttribute('href') === '#iletisim')).toBe(true);
    // Butun sayfa ici baglantilarin hedefi var.
    for (const a of links.filter((x) => x.getAttribute('href')?.startsWith('#'))) {
      expect(container.querySelector(a.getAttribute('href')!), a.getAttribute('href')!).toBeTruthy();
    }
    // Alt bilgi: sayfa bolumleri, giris ve hukuki sayfalar.
    const footerHrefs = [...container.querySelectorAll('footer a')].map((a) => a.getAttribute('href'));
    expect(footerHrefs).toEqual(expect.arrayContaining(['/kvkk', '/gizlilik', '/kullanim-kosullari', '/login', ...NAV_LINKS.map((l) => l.href)]));
  });

  it('kahraman: birincil eylem Demo talep et, ikincil Nasil calisir; pilot teklifi bagli', async () => {
    await render(<LandingPage />);
    const hero = container.querySelector('section[aria-labelledby="hero-baslik"]')!;
    const ctas = [...hero.querySelectorAll('a')].map((a) => [a.textContent?.trim(), a.getAttribute('href')]);
    expect(ctas).toEqual([
      [HERO.offer, `#${SECTION_IDS.pilot}`],
      ['Demo talep et', '#iletisim'],
      ['Nasıl çalışır?', `#${SECTION_IDS.how}`],
    ]);
    // Urun gorseli: ekran okuyucudan gizli, anlami figcaption tasir; ornek veri etiketli; ayni referans
    // kodu hem sakin telefonunda hem yonetim panelindeki ekstre satirinda.
    const figure = hero.querySelector('figure')!;
    expect(figure.querySelector('[aria-hidden="true"]')).toBeTruthy();
    expect(figure.querySelector('figcaption')!.textContent).toContain('Örnek veri');
    expect(figure.textContent).toContain('Örnek veri');
    expect(figure.querySelectorAll('mark')).toHaveLength(2);
    expect(new Set([...figure.querySelectorAll('mark')].map((m) => m.textContent))).toEqual(new Set(['R4T7KD']));
    expect(figure.textContent).toContain('216 bağımsız bölüm');
  });

  it('Nasil calisir: dort numarali adim; Kimler icin hedef kitleye konusur', async () => {
    await render(<LandingPage />);
    const steps = container.querySelectorAll(`#${SECTION_IDS.how} ol > li`);
    expect(steps).toHaveLength(4);
    expect([...steps].map((li) => li.querySelector('h3')!.textContent)).toEqual(STEPS.map((s) => s.title));
    expect(STEPS.map((s) => s.title)).toEqual(['Site kurulumu ve veri aktarımı', 'Aidat ve tahsilat', 'Sakin ekranı ve mobil', 'Raporlar']);
    const audiences = container.querySelector(`#${SECTION_IDS.audiences}`)!;
    expect([...audiences.querySelectorAll('h3')].map((h) => h.textContent)).toEqual([
      '200+ daireli, çok bloklu siteler',
      'Yarı profesyonel yöneticiler',
      'Teknolojiyle arası iyi olmayan sakinler',
    ]);
    expect(audiences.textContent).toContain('Büyük yazı, sade ekran');
  });

  it('mobil: yakinda magazalarda; sakin, guvenlik ve gorevli ekranlari ornek veri etiketli', async () => {
    await render(<LandingPage />);
    const mobile = container.querySelector(`#${SECTION_IDS.mobile}`)!;
    expect(mobile.textContent).toContain('Yakında App Store ve Google Play’de');
    // Magaza adlari baglanti degil (uygulama henuz yayinda degil).
    expect(mobile.querySelectorAll('a')).toHaveLength(0);
    const figures = mobile.querySelectorAll('figure');
    expect([...figures].map((f) => f.querySelector('figcaption h3')!.textContent)).toEqual(['Sakin', 'Güvenlik', 'Bina görevlisi']);
    for (const f of figures) {
      expect(f.querySelector('[aria-hidden="true"]')!.textContent).toContain('Örnek veri');
    }
  });

  it('guven ve pilot: borclu isimleri sozu, Avrupa bolgesi; pilot ucretsiz ve fiyat yazmaz', async () => {
    await render(<LandingPage />);
    const trust = container.querySelector(`#${SECTION_IDS.trust}`)!;
    expect(trust.textContent).toContain(TRUST.promise);
    expect(trust.textContent).toContain('eu-north-1');
    expect(trust.querySelectorAll('li')).toHaveLength(TRUST.items.length);
    const pilot = container.querySelector(`#${SECTION_IDS.pilot}`)!;
    expect(pilot.querySelector('h2')!.textContent).toBe(PILOT.title);
    expect(pilot.querySelector('a')!.getAttribute('href')).toBe('#iletisim');
    // Fiyat yok: TL tutari yalnizca "Örnek veri" etiketli, ekran okuyucudan gizli gorsellerde gecer.
    expect(pilot.textContent).not.toMatch(/₺|TL\b/);
    for (const el of container.querySelectorAll('main *')) {
      const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('');
      if (own.includes('₺')) expect(el.closest('[aria-hidden="true"]'), own).toBeTruthy();
    }
  });

  it('dogruluk: canli olmayan kanal ve odeme yontemi vaat edilmez', async () => {
    await render(<LandingPage />);
    const text = container.textContent ?? '';
    // WhatsApp bildirimi henuz canli degil; sayfada hic gecmez.
    expect(text).not.toMatch(/whatsapp/i);
    expect(text).toContain('henüz kullanıma açılmadı');
    expect(text).not.toMatch(/müşterimiz|referanslarımız|memnun/i);
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

  it('SSS: yerel details/summary, 5-8 soru; pilot ucreti ve yasli sakin sorusu var', async () => {
    await render(<LandingPage />);
    const details = container.querySelectorAll<HTMLDetailsElement>(`#${SECTION_IDS.faq} details`);
    expect(details.length).toBeGreaterThanOrEqual(5);
    expect(details.length).toBeLessThanOrEqual(8);
    expect(details).toHaveLength(FAQS.length);
    const questions = [...details].map((d) => d.querySelector('summary')!.textContent);
    expect(questions).toEqual(expect.arrayContaining(['Pilot dönemde ücret ödeyecek miyiz?', 'Yaşlı ya da teknolojiyle arası iyi olmayan sakinler kullanabilir mi?']));
    // Kapali baslar; ok isareti hareketi azaltilmis harekette kapali (motion-safe).
    expect([...details].every((d) => !d.open)).toBe(true);
    expect(details[0]!.querySelector('summary svg')!.getAttribute('class')).toContain('motion-safe:transition-transform');
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
