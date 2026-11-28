// @vitest-environment happy-dom
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { invoiceSchema, planSchema, subscriptionSchema } from '@/lib/api/subscriptions';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const state = {
  plans: [] as unknown[],
  subs: { items: [] as unknown[], counts: {} as Record<string, number> },
  invoices: [] as unknown[],
  action: vi.fn(async (_a: unknown) => ({})),
  mutate: vi.fn(),
  open: vi.fn(),
};

const mutation = () => ({ mutateAsync: state.action, mutate: state.mutate, isPending: false, isError: false, error: null, reset: () => {} });
const query = <T,>(data: T) => ({ data, isPending: false, isError: false, error: null, refetch: vi.fn() });

vi.mock('@/hooks/useSubscriptions', () => ({
  usePlans: () => query({ items: state.plans }),
  usePlatformSubscriptions: () => query(state.subs),
  usePlatformSubscriptionInvoices: () => ({ ...query({ pages: [{ items: state.invoices, totals: { net: 0, vat: 0, total: 0, unpaid: 0 } }] }), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: vi.fn() }),
  useBillingAction: () => mutation(),
  useBillingSettings: () => query({ enabled: true, automation: false, version: 1 }),
}));
vi.mock('@/hooks/useOpenDocument', () => ({ useOpenDocument: () => ({ open: state.open, pendingId: null, error: null, clearError: () => {} }) }));

const { PlatformPlansPage } = await import('./PlatformPlansPage');
const { PlatformSubscriptionsPage } = await import('./PlatformSubscriptionsPage');
const { PlatformSubscriptionInvoicesPage } = await import('./PlatformSubscriptionInvoicesPage');

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
  Object.assign(state, { plans: [], subs: { items: [], counts: {} }, invoices: [], action: vi.fn(async () => ({})), mutate: vi.fn(), open: vi.fn() });
});

function render(node: React.ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(node));
  const button = (text: string) => [...el.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
  const click = (text: string) => act(() => button(text)?.click());
  return { el, button, click };
}

function type(input: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  if (!input) throw new Error('alan yok');
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const fieldByLabel = (el: HTMLElement, label: string) => {
  const l = [...el.ownerDocument.querySelectorAll('label')].find((x) => x.textContent?.trim() === label);
  return l ? el.ownerDocument.getElementById(l.htmlFor) : null;
};

const invoice = (over: Record<string, unknown> = {}) =>
  invoiceSchema.parse({
    apartmentId: 'apt-1',
    invoiceId: '2026-12-01',
    invoiceNumber: 'YNS-2026-000002',
    siteName: 'Gül Sitesi',
    status: 'issued',
    periodStart: '2026-12-01',
    periodEnd: '2026-12-31',
    billingPeriod: 'monthly',
    planName: 'Standart',
    planVersion: 1,
    unitCount: 12,
    lines: [{ description: 'Standart (aylık)', quantity: 1, unitPriceKurus: 39_400, amountKurus: 39_400 }],
    netKurus: 39_400,
    vatRateBps: 2000,
    vatKurus: 7_880,
    totalKurus: 47_280,
    issueDate: '2026-12-01',
    dueDate: '2099-12-11',
    version: 3,
    ...over,
  });

describe('platform: abonelik faturalari', () => {
  it('liste: durum, tutar, KDV; odendi isaretleme referans ister ve surumu gonderir', async () => {
    state.invoices = [invoice(), invoice({ invoiceId: '2026-11-01', invoiceNumber: 'YNS-2026-000001', status: 'paid', paidOn: '2026-11-05', paymentReference: 'EFT-9' })];
    const { el, button, click } = render(<PlatformSubscriptionInvoicesPage />);
    expect(el.querySelector('h1')?.textContent).toContain('Abonelik faturaları');
    const rows = el.querySelectorAll('ul[aria-label="Abonelik faturaları"] > li');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Ödeme bekliyor');
    expect(rows[0]?.textContent).toContain('472,80');
    expect(rows[1]?.textContent).toContain('EFT-9');
    // Ödendi yalnizca bekleyen faturada.
    expect([...rows[1]!.querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['PDF']);

    const payButton = [...rows[0]!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Ödendi') as HTMLButtonElement;
    act(() => payButton.click());
    expect(el.ownerDocument.body.textContent).toContain('Ödendi olarak işaretle');
    click('Ödendi olarak kaydet');
    expect(state.action).not.toHaveBeenCalled();
    expect(el.ownerDocument.body.textContent).toContain('Referans 3-100 karakter');
    type(fieldByLabel(el, 'Referans') as HTMLInputElement, 'EFT-123456');
    await act(async () => button('Ödendi olarak kaydet')?.click());
    expect(state.action).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'paid', apartmentId: 'apt-1', invoiceId: '2026-12-01', input: expect.objectContaining({ version: 3, method: 'bank_transfer', reference: 'EFT-123456' }) }),
    );
  });

  it('PDF imzali linkle acilir; filtre: odendi', () => {
    state.invoices = [invoice(), invoice({ invoiceId: '2026-11-01', invoiceNumber: 'YNS-2026-000001', status: 'paid', paidOn: '2026-11-05' })];
    const { el, click } = render(<PlatformSubscriptionInvoicesPage />);
    act(() => (el.querySelector('ul[aria-label="Abonelik faturaları"] li button') as HTMLButtonElement).click());
    expect(state.open).toHaveBeenCalledWith('apt-1:2026-12-01', expect.any(Function));
    click('Ödendi');
    expect(el.querySelectorAll('ul[aria-label="Abonelik faturaları"] > li')).toHaveLength(1);
  });

  it('bos liste', () => {
    const { el } = render(<PlatformSubscriptionInvoicesPage />);
    expect(el.textContent).toContain('Henüz abonelik faturası yok.');
  });
});

describe('platform: abonelikler', () => {
  const sub = subscriptionSchema.parse({
    apartmentId: 'apt-2',
    status: 'past_due',
    plan: { code: 'standart', name: 'Standart', planVersion: 1, pricing: { model: 'flat', monthlyKurus: 1, annualKurus: 1, vatRateBps: 2000 }, features: {}, limits: { maxUnits: null, maxStaffUsers: null } },
    billingPeriod: 'monthly',
    currentPeriodStart: '2026-12-01',
    currentPeriodEnd: '2026-12-31',
    unitCountSnapshot: 40,
    graceDays: 14,
    paymentTermDays: 10,
    pastDueSince: '2026-12-12',
    version: 4,
  });

  it('legacy satirda Baslat, abonelikte Durum; durum filtresi sayilarla', () => {
    state.subs = {
      items: [
        { apartmentId: 'apt-1', siteName: 'Gül Sitesi', city: 'Diyarbakır', siteStatus: 'active', status: 'legacy' },
        { apartmentId: 'apt-2', siteName: 'Lale Apt.', city: 'Diyarbakır', siteStatus: 'active', status: 'past_due', subscription: sub },
      ],
      counts: { legacy: 1, past_due: 1 },
    };
    const { el, click } = render(<PlatformSubscriptionsPage />);
    const rows = el.querySelectorAll('ul[aria-label="Abonelikler"] > li');
    expect(rows[0]?.textContent).toContain('Abonelik öncesi');
    expect(rows[0]?.textContent).toContain('Başlat');
    expect(rows[1]?.textContent).toContain('Ödemesi gecikmiş');
    expect(rows[1]?.textContent).toContain('40 bölüm');
    expect(el.textContent).toContain('1 apartmanın ödemesi gecikmiş');
    const chips = el.querySelector('[role="group"][aria-label="Abonelik durumu"]');
    expect(chips?.textContent).toContain('Ödemesi gecikmiş1');
    click('Askıda');
    expect(el.textContent).toContain('Bu filtreye uyan apartman yok.');
  });

  it('durum penceresi: yalnizca izinli islemler; gerekce zorunlu; surum gonderilir', async () => {
    state.subs = { items: [{ apartmentId: 'apt-2', siteName: 'Lale Apt.', city: 'Diyarbakır', siteStatus: 'active', status: 'past_due', subscription: sub }], counts: { past_due: 1 } };
    const { el, button, click } = render(<PlatformSubscriptionsPage />);
    click('Durum');
    const select = fieldByLabel(el, 'İşlem') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['suspend', 'cancel']);
    click('Uygula');
    expect(state.action).not.toHaveBeenCalled();
    type(fieldByLabel(el, 'Gerekçe') as HTMLTextAreaElement, 'Ödeme yapılmadı, askıya alınıyor');
    await act(async () => button('Uygula')?.click());
    expect(state.action).toHaveBeenCalledWith({ kind: 'status', apartmentId: 'apt-2', input: { version: 4, action: 'suspend', reason: 'Ödeme yapılmadı, askıya alınıyor' } });
  });
});

describe('platform: planlar', () => {
  it('bos katalog: ornek planlari yukle', () => {
    const { el, click } = render(<PlatformPlansPage />);
    expect(el.textContent).toContain('Henüz plan yok.');
    click('Örnek planları yükle');
    expect(state.mutate).toHaveBeenCalledWith({ kind: 'seed' });
  });

  it('plan satiri: fiyat ozeti, ornek fiyat uyarisi, arsiv penceresi gerekce ister', async () => {
    state.plans = [
      planSchema.parse({
        code: 'temel',
        name: 'Temel',
        pricing: { model: 'per_unit', monthlyKurus: 0, annualKurus: 0, perUnitMonthlyKurus: 1_500, perUnitAnnualKurus: 15_000, vatRateBps: 2000 },
        features: { 'payments.online': true },
        limits: { maxUnits: 100, maxStaffUsers: 5 },
        trialDays: 30,
        placeholder: true,
        status: 'active',
        planVersion: 1,
        updatedAt: '2026-11-28T00:00:00.000Z',
        version: 2,
      }),
    ];
    const { el, button, click } = render(<PlatformPlansPage />);
    const row = el.querySelector('ul[aria-label="Abonelik planları"] > li');
    expect(row?.textContent).toContain('Örnek fiyat');
    expect(row?.textContent).toContain('bölüm başı');
    expect(row?.textContent).toContain('en fazla 100 bölüm');
    expect(el.textContent).toContain('fiyatları yer tutucudur');
    click('Arşivle');
    type(fieldByLabel(el, 'Gerekçe') as HTMLTextAreaElement, 'Satıştan kaldırıldı');
    const dialogButton = [...el.ownerDocument.querySelectorAll('dialog button')].find((b) => b.textContent?.trim() === 'Arşivle') as HTMLButtonElement;
    await act(async () => dialogButton.click());
    expect(state.action).toHaveBeenCalledWith({ kind: 'planStatus', code: 'temel', input: { version: 2, status: 'archived', reason: 'Satıştan kaldırıldı' } });
    expect(button('Yeni plan')).toBeTruthy();
  });

  it('yeni plan penceresi: TL tutar kuruşa, idempotency anahtari ile', async () => {
    const { el, click } = render(<PlatformPlansPage />);
    click('Yeni plan');
    type(fieldByLabel(el, 'Kod') as HTMLInputElement, 'ozel');
    type(fieldByLabel(el, 'Ad') as HTMLInputElement, 'Özel');
    type(fieldByLabel(el, 'Aylık bedel (₺, KDV hariç)') as HTMLInputElement, '500,00');
    type(fieldByLabel(el, 'Yıllık bedel (₺, KDV hariç)') as HTMLInputElement, '5.000');
    const submit = [...el.ownerDocument.querySelectorAll('dialog button')].find((b) => b.textContent?.trim() === 'Planı oluştur') as HTMLButtonElement;
    await act(async () => submit.click());
    expect(state.action).toHaveBeenCalledWith({
      kind: 'createPlan',
      input: expect.objectContaining({ code: 'ozel', name: 'Özel', pricing: { model: 'flat', monthlyKurus: 50_000, annualKurus: 500_000, vatRateBps: 2000 }, idempotencyKey: expect.any(String) }),
    });
  });
});
