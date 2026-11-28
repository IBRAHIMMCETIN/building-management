// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let state: Record<string, unknown>;
vi.mock('@/hooks/usePlatform', () => ({ useDemoRequests: () => state }));

const { DemoRequestsPage } = await import('./DemoRequestsPage');

const ITEM = {
  requestId: 'r1',
  fullName: 'Ayşe Yılmaz',
  email: 'ayse@ornek.com',
  phone: '0532 123 45 67',
  organization: 'Gül Sitesi',
  unitRange: '201-500',
  message: 'Dört blok.\nHafta içi arayın.',
  kvkkVersion: '2026-11-28-taslak-1',
  status: 'new',
  createdAt: '2026-11-28T09:10:00.000Z',
  ipMasked: '203.0.113.0/24',
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = () => act(async () => root.render(<DemoRequestsPage />));

describe('platform: demo talepleri', () => {
  it('talepleri listeler: site, aralik, kisi, tarih, e-posta / telefon baglantisi, mesaj, KVKK surumu', async () => {
    state = { isPending: false, isError: false, data: { pages: [{ items: [ITEM] }] }, hasNextPage: false };
    await render();
    expect(container.querySelector('h1')!.textContent).toContain('Demo talepleri');
    const row = container.querySelector('ul[aria-label="Demo talepleri"] li')!;
    expect(row.textContent).toContain('Gül Sitesi');
    expect(row.textContent).toContain('201–500 bağımsız bölüm');
    expect(row.textContent).toContain('Ayşe Yılmaz');
    expect(row.querySelector('a[href="mailto:ayse@ornek.com"]')).toBeTruthy();
    expect(row.querySelector('a[href="tel:05321234567"]')).toBeTruthy();
    expect(row.textContent).toContain('Hafta içi arayın.');
    expect(row.textContent).toContain('2026-11-28-taslak-1');
  });

  it('bos, yukleniyor ve hata durumlari; hata "Tekrar dene" ile yeniden ister', async () => {
    state = { isPending: false, isError: false, data: { pages: [{ items: [] }] }, hasNextPage: false };
    await render();
    expect(container.textContent).toContain('Henüz demo talebi yok');

    state = { isPending: true, isError: false, data: undefined };
    await render();
    expect(container.querySelector('[role="status"][aria-label="Demo talepleri yükleniyor"]')).toBeTruthy();

    const refetch = vi.fn();
    state = { isPending: false, isError: true, error: new Error('x'), refetch };
    await render();
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Tekrar dene')!.click());
    expect(refetch).toHaveBeenCalled();
  });

  it('sonraki sayfa varsa "Daha fazla yükle"', async () => {
    const fetchNextPage = vi.fn();
    state = { isPending: false, isError: false, data: { pages: [{ items: [ITEM] }] }, hasNextPage: true, fetchNextPage, isFetchingNextPage: false };
    await render();
    await act(async () => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('Daha fazla yükle'))!.click());
    expect(fetchNextPage).toHaveBeenCalled();
  });
});
