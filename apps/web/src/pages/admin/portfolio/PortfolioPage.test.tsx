// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createMemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '@/context/AuthContext';
import { navItemsFor } from '@/layouts/adminNav';
import { type PortfolioCard, type PortfolioPage as Page, mergePages, portfolioApartmentCount, sortCards } from '@/lib/api/portfolio';
import { PortfolioPage } from './PortfolioPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ page: vi.fn(), contexts: vi.fn() }));
vi.mock('@/lib/api/portfolio', async (importOriginal) => ({ ...(await importOriginal<typeof import('@/lib/api/portfolio')>()), portfolioApi: { page: api.page } }));
vi.mock('@/lib/auth/contexts', () => ({ fetchContexts: api.contexts }));

const card = (id: string, name: string, over: Partial<PortfolioCard> = {}): PortfolioCard => ({
  apartmentId: id,
  apartmentName: name,
  role: 'management_company',
  readOnly: false,
  status: 'ok',
  failed: [],
  units: { count: 24 },
  finance: { cash: 100000, bank: 400000, totalFunds: 500000, receivables: 90000, overdue: 0, overdueUnitCount: 0, advances: 0, payables: 0 },
  collection: { period: '2026-11', charged: 200000, collected: 150000, collectionRatePct: 75 },
  tickets: { openCount: 2, openByPriority: { low: 0, normal: 1, high: 1, urgent: 0 }, overdueCount: 0 },
  maintenance: { overdueCount: 0, dueThisWeekCount: 1 },
  equipment: { expiringCount: 1, expiringByKind: { warranty: 1, contract: 0, inspection: 0 }, expiredCount: 0 },
  polls: { openCount: 0, scheduledCount: 0 },
  assemblies: { upcomingCount: 0 },
  tenders: { openCount: 1 },
  ...over,
});

/** API'nin sayfa toplami (apps/api portfolio `totalsOf`) ile ayni kural. */
function totalsOf(items: PortfolioCard[]): Page['totals'] {
  const sum = (f: (c: PortfolioCard) => number | undefined) => items.reduce((s, c) => s + (f(c) ?? 0), 0);
  const charged = sum((c) => c.collection?.charged);
  const collected = sum((c) => c.collection?.collected);
  return {
    apartmentCount: items.length,
    incompleteCount: items.filter((c) => c.status !== 'ok').length,
    unitCount: sum((c) => c.units?.count),
    charged,
    collected,
    ...(charged > 0 ? { collectionRatePct: Math.round((collected / charged) * 10_000) / 100 } : {}),
    receivables: sum((c) => c.finance?.receivables),
    overdue: sum((c) => c.finance?.overdue),
    overdueUnitCount: sum((c) => c.finance?.overdueUnitCount),
    cash: sum((c) => c.finance?.cash),
    bank: sum((c) => c.finance?.bank),
    totalFunds: sum((c) => c.finance?.totalFunds),
    openTickets: sum((c) => c.tickets?.openCount),
    urgentTickets: sum((c) => c.tickets?.openByPriority.urgent),
    ticketSlaBreaches: sum((c) => c.tickets?.overdueCount),
    maintenanceOverdue: sum((c) => c.maintenance?.overdueCount),
    maintenanceDueThisWeek: sum((c) => c.maintenance?.dueThisWeekCount),
    equipmentExpiring: sum((c) => c.equipment?.expiringCount),
    upcomingAssemblies: sum((c) => c.assemblies?.upcomingCount),
    openPolls: sum((c) => c.polls?.openCount),
    openTenders: sum((c) => c.tenders?.openCount),
  };
}

const LALE = card('apt-1', 'Lale Sitesi', {
  finance: { cash: 0, bank: 200000, totalFunds: 200000, receivables: 300000, overdue: 250000, overdueUnitCount: 3, advances: 0, payables: 0 },
  collection: { period: '2026-11', charged: 400000, collected: 100000, collectionRatePct: 25 },
  tickets: { openCount: 5, openByPriority: { low: 1, normal: 2, high: 1, urgent: 1 }, overdueCount: 2 },
});
const AKASYA = card('apt-2', 'Akasya Apartmanı', { role: 'observer', readOnly: true });
const ZAMBAK = card('apt-3', 'Zambak Konutları', { status: 'partial', failed: ['finance', 'tickets'], finance: undefined, tickets: undefined });

function page(items: PortfolioCard[], over: Partial<Page> = {}): Page {
  return { asOf: '2026-11-25', period: '2026-11', total: items.length, limit: 12, items, totals: totalsOf(items), ...over };
}

function Where() {
  return <p data-testid="where">{useLocation().pathname + useLocation().search}</p>;
}

const flush = () => act(async () => new Promise((r) => setTimeout(r, 20)));

async function render(auth: Partial<AuthContextValue> = {}) {
  const value = {
    session: { claims: { sub: 'u1' } },
    user: { sub: 'u1', role: 'management_company', apartmentId: 'apt-1', exp: 0 },
    setActiveContext: vi.fn(async () => ({ claims: { sub: 'u1' } })),
    ...auth,
  } as unknown as AuthContextValue;
  const router = createMemoryRouter(
    [
      { path: '/admin/portfolio', element: <PortfolioPage /> },
      { path: '*', element: <Where /> },
    ],
    { initialEntries: ['/admin/portfolio'] },
  );
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <AuthContext value={value}>
          <RouterProvider router={router} />
        </AuthContext>
      </QueryClientProvider>,
    );
  });
  await flush();
  await flush();
  const table = () => host.querySelector('table') as HTMLTableElement;
  const rowNames = () => [...table().querySelectorAll('tbody th[scope="row"]')].map((th) => th.firstChild?.textContent);
  const button = (label: string) => host.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const text = (t: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === t) as HTMLButtonElement | undefined;
  return { host, value, table, rowNames, button, text, router, unmount: () => act(async () => root.unmount()) };
}

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.page.mockResolvedValue(page([LALE, AKASYA, ZAMBAK]));
  api.contexts.mockResolvedValue({ userId: 'u1', isPlatformAdmin: false, active: null, contexts: [] });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('PortfolioPage', () => {
  it('toplamlar, apartman satirlari, rol / salt okunur isaretleri ve eksik veri uyarisi', async () => {
    const view = await render();
    expect(api.page).toHaveBeenCalledWith({ limit: 12 }, expect.anything());
    const text = view.host.textContent ?? '';
    expect(text).toContain('3 apartman');
    expect(text).toContain('Kasım 2026 tahsilat');
    // Toplam oran: (100000 + 150000 + 150000) / (400000 + 200000 + 200000) = %50
    expect(text).toContain('%50');
    expect(text).toContain('1 apartmanın bazı verileri okunamadı');
    // Varsayilan siralama: ada gore (Turkce).
    expect(view.rowNames()).toEqual(['Akasya Apartmanı', 'Lale Sitesi', 'Zambak Konutları']);
    const akasya = view.table().querySelectorAll('tbody tr')[0] as HTMLTableRowElement;
    expect(akasya.textContent).toContain('Denetçi');
    expect(akasya.textContent).toContain('Salt okunur');
    const zambak = view.table().querySelectorAll('tbody tr')[2] as HTMLTableRowElement;
    expect(zambak.textContent).toContain('Eksik veri');
    expect(zambak.textContent).toContain('Okunamayan: Finans, Talepler');
    expect(zambak.textContent).toContain('okunamadı');
    await view.unmount();
  });

  it('arama, dikkat filtresi ve siralama yuklenen kartlarda', async () => {
    const view = await render();
    await type(view.host.querySelector('input[type="search"]') as HTMLInputElement, 'zam');
    expect(view.rowNames()).toEqual(['Zambak Konutları']);
    await type(view.host.querySelector('input[type="search"]') as HTMLInputElement, 'yok-boyle');
    expect(view.host.textContent).toContain('Bu filtreye uyan apartman yok.');
    await type(view.host.querySelector('input[type="search"]') as HTMLInputElement, '');

    const chip = [...view.host.querySelectorAll('[role="group"] button')].find((b) => b.textContent?.startsWith('Dikkat gerektiren')) as HTMLButtonElement;
    await act(async () => chip.click());
    expect(view.rowNames()).toEqual(['Lale Sitesi', 'Zambak Konutları']);
    await act(async () => ([...view.host.querySelectorAll('[role="group"] button')][0] as HTMLButtonElement).click());

    const select = view.host.querySelector('select') as HTMLSelectElement;
    await act(async () => {
      select.value = 'overdue';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // Verisi okunamayan sona.
    expect(view.rowNames()).toEqual(['Lale Sitesi', 'Akasya Apartmanı', 'Zambak Konutları']);
    await act(async () => {
      select.value = 'name';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(view.rowNames()).toEqual(['Akasya Apartmanı', 'Lale Sitesi', 'Zambak Konutları']);
    await view.unmount();
  });

  it('baska apartmana gecis mevcut baglam secimiyle; aktif apartmanda yalnizca sayfa acilir', async () => {
    const view = await render();
    await act(async () => view.button('Akasya Apartmanı Genel Bakış ekranını aç')?.click());
    await flush();
    expect(view.value.setActiveContext).toHaveBeenCalledWith({ apartmentId: 'apt-2', role: 'observer' });
    expect(view.host.querySelector('[data-testid="where"]')?.textContent).toBe('/admin');
    await view.unmount();

    const again = await render();
    const tickets = [...again.table().querySelectorAll('button')].find((b) => b.textContent?.includes('(Lale Sitesi, açık talepler)')) as HTMLButtonElement;
    // Erisilebilir ad gorunen degerle baslar (aria-label yok; WCAG 2.5.3), baglam ekran okuyucuya sonda.
    expect(tickets.hasAttribute('aria-label')).toBe(false);
    expect(tickets.textContent).toMatch(/^5 açık1 acil · 2 SLA aşımı \(Lale Sitesi, açık talepler\)$/);
    expect(tickets.querySelector('.sr-only')?.textContent).toBe(' (Lale Sitesi, açık talepler)');
    await act(async () => tickets.click());
    await flush();
    expect(again.value.setActiveContext).not.toHaveBeenCalled();
    expect(again.host.querySelector('[data-testid="where"]')?.textContent).toBe('/admin/tickets');
    await again.unmount();
  });

  it('daha fazla yukle: sonraki sayfa imlecle istenir, toplamlar yuklenen kartlardan', async () => {
    api.page.mockResolvedValueOnce(page([LALE], { total: 2, nextCursor: 'c2' })).mockResolvedValueOnce(page([AKASYA], { total: 2 }));
    const view = await render();
    expect(view.host.textContent).toContain('toplamlar yüklenen 1 apartman içindir');
    await act(async () => view.text('Daha fazla yükle')?.click());
    await flush();
    expect(api.page).toHaveBeenLastCalledWith({ limit: 12, cursor: 'c2' }, expect.anything());
    expect(view.rowNames()).toEqual(['Akasya Apartmanı', 'Lale Sitesi']);
    expect(view.host.textContent).not.toContain('toplamlar yüklenen');
    expect(view.text('Daha fazla yükle')).toBeUndefined();
    await view.unmount();
  });

  it('bos portfoy ve yukleme hatasi', async () => {
    api.page.mockResolvedValue(page([]));
    const empty = await render();
    expect(empty.host.textContent).toContain('Portföyünüzde apartman yok');
    await empty.unmount();

    api.page.mockRejectedValue(new Error('Sunucuya ulaşılamadı'));
    const failed = await render();
    expect(failed.host.querySelector('[role="alert"]')).not.toBeNull();
    expect(failed.text('Tekrar dene')).toBeDefined();
    await failed.unmount();
  });

  it('destek oturumunda portfoy istenmez', async () => {
    const view = await render({ support: { apartmentId: 'apt-1' } as never, user: { sub: 'u1', role: 'observer', apartmentId: 'apt-1', exp: 0 } as never });
    expect(api.page).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain('Destek oturumunda yönetim portföyü açılamaz');
    await view.unmount();
  });
});

describe('portfoy yardimcilari', () => {
  it('menu: en az iki apartmanda portfoy rolu; sakin / gorevli rolleri sayilmaz', () => {
    const ctx = (apartmentId: string, role: string) => ({ apartmentId, role }) as never;
    expect(portfolioApartmentCount([ctx('a', 'apartment_manager'), ctx('a', 'observer'), ctx('b', 'resident'), ctx('c', 'building_staff')])).toBe(1);
    expect(portfolioApartmentCount([ctx('a', 'apartment_manager'), ctx('b', 'observer')])).toBe(2);
    const paths = (portfolio: boolean) => navItemsFor('management_company', portfolio).map((n) => n.to);
    expect(paths(false)).not.toContain('/admin/portfolio');
    expect(paths(true)[0]).toBe('/admin/portfolio');
    expect(navItemsFor('building_staff', true).map((n) => n.to)).not.toContain('/admin/portfolio');
    expect(navItemsFor('platform_admin', true).map((n) => n.to)).not.toContain('/admin/portfolio');
  });

  it('siralama: tahsilat orani dusuk once, verisi olmayan sona; sayfa toplamlari birlesir', () => {
    expect(sortCards([AKASYA, ZAMBAK, LALE], 'collection').map((c) => c.apartmentId)).toEqual(['apt-1', 'apt-2', 'apt-3']);
    expect(sortCards([AKASYA, ZAMBAK, LALE], 'tickets').map((c) => c.apartmentId)).toEqual(['apt-1', 'apt-2', 'apt-3']);
    const merged = mergePages([page([LALE]), page([AKASYA])]);
    expect(merged.totals).toMatchObject({ charged: 600000, collected: 250000, collectionRatePct: 41.67, openTickets: 7, overdue: 250000 });
  });
});
