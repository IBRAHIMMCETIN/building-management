// @vitest-environment happy-dom
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type SubscriptionManagerView, managerViewSchema } from '@/lib/api/subscriptions';
import { LICENSABLE_KEYS } from '@/lib/features/catalog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const state: { data?: SubscriptionManagerView; error?: Error; open: ReturnType<typeof vi.fn> } = { open: vi.fn() };
vi.mock('@/hooks/useSubscriptions', () => ({
  useMySubscription: () => ({ data: state.data, isPending: !state.data && !state.error, isError: !!state.error, error: state.error ?? null }),
}));
vi.mock('@/hooks/useOpenDocument', () => ({ useOpenDocument: () => ({ open: state.open, pendingId: null, error: null }) }));
const { SubscriptionCard } = await import('./SubscriptionCard');

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  Object.assign(state, { data: undefined, error: undefined, open: vi.fn() });
});

function render(data?: Record<string, unknown>) {
  if (data) state.data = managerViewSchema.parse(data);
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<SubscriptionCard />));
  return el;
}

const all = Object.fromEntries(LICENSABLE_KEYS.map((k) => [k, true]));

describe('Ayarlar > Abonelik', () => {
  it('abonelik oncesi (legacy): sinirsiz bilgisi, plan ve fatura yok', () => {
    const el = render({ status: 'legacy', legacy: true, readOnly: false, features: all, limits: { maxUnits: null, maxStaffUsers: null }, usage: { units: 12, staffUsers: 2 }, invoices: [] });
    expect(el.querySelector('h2')?.textContent).toContain('Abonelik');
    expect(el.textContent).toContain('tüm modüller açık');
    expect(el.querySelector('ul')).toBeNull();
  });

  it('plan, durum, deneme / donem, kullanim / limit ve fatura PDF', () => {
    const el = render({
      status: 'past_due',
      legacy: false,
      readOnly: false,
      pastDueSince: '2026-12-12',
      suspendOn: '2026-12-26',
      features: { ...all, 'modules.tenders': false },
      limits: { maxUnits: 100, maxStaffUsers: 5 },
      usage: { units: 12, staffUsers: 2 },
      plan: { code: 'temel', name: 'Temel', planVersion: 1, pricing: { model: 'per_unit', monthlyKurus: 0, annualKurus: 0, perUnitMonthlyKurus: 1_500, perUnitAnnualKurus: 15_000, vatRateBps: 2000 } },
      billingPeriod: 'monthly',
      currentPeriodStart: '2026-12-01',
      currentPeriodEnd: '2026-12-31',
      invoices: [
        {
          apartmentId: 'apt-1',
          invoiceId: '2026-12-01',
          invoiceNumber: 'YNS-2026-000002',
          siteName: 'Gül Sitesi',
          status: 'issued',
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          billingPeriod: 'monthly',
          planName: 'Temel',
          planVersion: 1,
          unitCount: 12,
          lines: [],
          netKurus: 18_000,
          vatRateBps: 2000,
          vatKurus: 3_600,
          totalKurus: 21_600,
          issueDate: '2026-12-01',
          dueDate: '2026-12-11',
          version: 1,
        },
      ],
    });
    expect(el.textContent).toContain('Temel');
    expect(el.textContent).toContain('Ödemesi gecikmiş');
    expect(el.textContent).toContain('salt okunur olur');
    const usage = el.querySelector('ul[aria-label="Kullanım ve sınırlar"]');
    expect(usage?.textContent).toContain('12 / 100');
    expect(usage?.textContent).toContain('2 / 5');
    expect(usage?.textContent).toContain('İhale / teklif toplama (aboneliğinizde yok)');
    const inv = el.querySelector('ul[aria-label="Abonelik faturaları"] > li');
    expect(inv?.textContent).toContain('YNS-2026-000002');
    expect(inv?.textContent).toContain('216,00');
    act(() => (inv?.querySelector('button') as HTMLButtonElement).click());
    expect(state.open).toHaveBeenCalledWith('2026-12-01', expect.any(Function));
  });

  it('okuma hatasi gosterilir', () => {
    state.error = new Error('x');
    const el = render();
    expect(el.textContent).toContain('Beklenmeyen bir hata oluştu.');
  });
});
