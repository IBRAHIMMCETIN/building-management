// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useSyncExternalStore } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { ApiError } from '@/lib/api/errors';
import { type Tender, tenderSchema } from '@/lib/api/tenders';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

/*
 * Karara baglanmis ihale: "Hakediş / gider ekle" Finans gider penceresini karardan (kalan tutar,
 * eslestirilmis tedarikci hesabi) on doldurulmus acar (sessiz kayit yok), gider ihale ucuna gider;
 * hakedisler ve ilerleme kartta, ters kayit ilerlemeye sayilmaz; karar tutari asiminda gerekce istenir.
 */
let current: Tender;
const listeners = new Set<() => void>();
/** Ayrinti onbellegi benzetimi: yazim yaniti ayrintiyi gunceller. */
const setCurrent = (t: Tender) => {
  current = t;
  for (const l of listeners) l();
};
let canWrite = true;
const expenseFn = vi.fn();
const linkAssembly = vi.fn(async () => ({}));
const linkSupplier = vi.fn(async () => ({}));
vi.mock('@/hooks/useTenders', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  const stub = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false, isError: false, error: null });
  return {
    useTender: () => ({
      isPending: false,
      isError: false,
      data: useSyncExternalStore(
        (l) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        () => current,
      ),
    }),
    useTenderPermissions: () => ({ canRead: true, canWrite }),
    useTenderActions: () => ({
      collect: stub(),
      publish: stub(),
      decide: stub(),
      cancel: stub(),
      withdrawQuote: stub(),
      comment: stub(),
      hideComment: stub(),
      linkAssemblyDecision: { ...stub(), mutateAsync: linkAssembly },
      linkSupplier: { ...stub(), mutateAsync: linkSupplier },
    }),
    useTenderExpense: () => useMutation({ mutationFn: (v: unknown) => expenseFn(v) }),
    useSaveQuote: () => useMutation({ mutationFn: vi.fn() }),
    useSaveTender: () => useMutation({ mutationFn: vi.fn() }),
    useAssemblyDecisionOptions: () => ({
      isPending: false,
      data: [
        { assemblyId: 'asm1', itemId: 'a1', seq: 1, itemTitle: 'Isı yalıtımı yapılsın', meetingAt: '2026-11-10T16:00:00.000Z', decisionKind: 'beneficial_improvement', decision: 'accepted', assemblyStatus: 'held' },
        { assemblyId: 'asm1', itemId: 'a2', seq: 2, itemTitle: 'Çatı', meetingAt: '2026-11-10T16:00:00.000Z', decisionKind: 'general', decision: 'rejected', assemblyStatus: 'held' },
      ],
    }),
    useSupplierAccounts: () => ({
      isPending: false,
      data: [
        { accountId: 'sup-cephe', name: 'Cephe Yapı Ltd.', suggested: true, linked: false },
        { accountId: 'sup-other', name: 'Başka Firma', suggested: false, linked: false },
      ],
    }),
  };
});
const financeRecord = vi.fn();
vi.mock('@/hooks/useFinance', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useFinanceAccounts: () => ({
      isPending: false,
      data: [
        { accountId: 'exp-repair', name: 'Bakım / Onarım' },
        { accountId: 'exp-elevator', name: 'Asansör Bakımı' },
      ],
    }),
    useFinanceSummary: () => ({ data: { fundsAccounts: [{ accountId: 'cash', name: 'Kasa', type: 'cash', balance: 0 }] } }),
    useRecordExpense: () => useMutation({ mutationFn: (v: unknown) => financeRecord(v) }),
  };
});
vi.mock('@/hooks/useTickets', () => ({ useTicketList: () => ({ data: { items: [] } }) }));
vi.mock('@/hooks/useOpenDocument', () => ({ useOpenDocument: () => ({ open: vi.fn(), pendingId: undefined, error: undefined }) }));
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useParams: () => ({ tenderId: 't1' }), useNavigate: () => vi.fn() }));

const { TenderDetailPage } = await import('./TenderDetailPage');

const decision = { quoteId: 'q1', reason: 'En düşük teklif', reference: 'KD-2026/14', supplierName: 'Cephe Ltd.', netKurus: 90_000_00, vatKurus: 18_000_00, totalKurus: 108_000_00, decidedAt: '2026-11-25T07:00:00.000Z' };
const progress = (active: number, extra: Record<string, number> = {}) => ({
  decidedTotalKurus: 108_000_00,
  activeTotalKurus: active,
  remainingKurus: Math.max(0, 108_000_00 - active),
  overrunKurus: Math.max(0, active - 108_000_00),
  percentBps: Math.floor((active * 10_000) / 108_000_00),
  activeCount: active ? 1 : 0,
  reversedCount: 0,
  ...extra,
});
const draft = (amountKurus: number, extra: Record<string, unknown> = {}) => ({ amountKurus, supplier: 'Cephe Ltd.', description: 'İhale t1: Dış cephe mantolama · Karar KD-2026/14', expenseAccountId: 'exp-repair', date: '2026-11-27', installment: 1, ...extra });
const link = (id: string, amountKurus: number, extra: Record<string, unknown> = {}) => ({ expenseId: id, transactionId: `tx-${id}`, amountKurus, date: '2026-11-27', linkedAt: '2026-11-27T07:00:00.000Z', ...extra });
const tender = (over: Record<string, unknown> = {}): Tender =>
  tenderSchema.parse({
    tenderId: 't1',
    title: 'Dış cephe mantolama',
    category: 'mantolama',
    status: 'decided',
    deadline: '2026-11-20',
    deadlinePassed: true,
    minQuotes: 3,
    quoteCount: 1,
    publishedAt: '2026-11-21T07:00:00.000Z',
    decision,
    createdAt: '2026-11-01T07:00:00.000Z',
    updatedAt: '2026-11-25T07:00:00.000Z',
    version: 5,
    description: 'A ve B blok dış cephe mantolama işi',
    quotes: [],
    comparison: { rows: [], lowestQuoteIds: ['q1'], lowestNetQuoteIds: ['q1'] },
    comments: [],
    canComment: false,
    expenseProgress: progress(0),
    expenseDraft: draft(108_000_00),
    ...over,
  });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  canWrite = true;
  expenseFn.mockReset();
  financeRecord.mockReset();
  linkAssembly.mockClear();
  linkSupplier.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = async () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <TenderDetailPage />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
};
const button = (text: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
/** Acik penceredeki dugme (kapali pencereler de DOM'da). */
const inDialog = (text: string) => [...(document.querySelector('dialog[open]')?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.trim() === text);
const click = async (el: Element | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const field = (selector: string) => document.querySelector(`dialog[open] ${selector}`) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
const setValue = async (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null, value: string) => {
  if (!el) throw new Error('alan yok');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

describe('ihale karari: hakedis / gider kaydi', () => {
  it('"Hakediş / gider ekle" Finans gider penceresini kalan tutarla on doldurulmus acar; kayit ihale ucuna gider', async () => {
    current = tender();
    expenseFn.mockImplementation(async () => {
      const updated = tender({ expenses: [link('e1', 108_000_00, { installment: 1 })], expense: link('e1', 108_000_00), expenseProgress: progress(108_000_00), expenseDraft: draft(0, { installment: 2 }) });
      setCurrent(updated);
      return { replayed: false, expenseId: 'e1', transactionId: 'tx1', tender: updated };
    });
    await render();
    await click(button('Hakediş / gider ekle'));
    expect(document.querySelector('dialog[open]')?.textContent).toContain('İhale için gider / hakediş kaydı');
    expect(field('select[name="expenseAccountId"]')?.value).toBe('exp-repair');
    expect(field('input[name="amount"]')?.value).toBe('108000,00');
    expect(field('input[name="description"]')?.value).toBe('İhale t1: Dış cephe mantolama · Karar KD-2026/14');
    expect(field('input[name="supplier"]')?.value).toBe('Cephe Ltd.');
    await setValue(field('select[name="creditAccountId"]'), 'payable');
    await click(inDialog('Gideri kaydet'));
    await flush();
    expect(financeRecord).not.toHaveBeenCalled();
    expect(expenseFn).toHaveBeenCalledWith({
      id: 't1',
      input: expect.objectContaining({ idempotencyKey: expect.any(String), expenseAccountId: 'exp-repair', creditAccountId: 'payable', amount: 108_000_00, date: '2026-11-27', supplier: 'Cephe Ltd.' }),
    });
    expect(document.querySelector('dialog[open]')?.textContent).toContain('108.000,00');
    expect(container.textContent).toContain('1. Gider kaydedildi: ₺108.000,00');
    // Baglantili kayitta "Yeni gider" sunulmaz (sonraki hakedis karttan, guncel kalanla).
    expect(button('Yeni gider')).toBeUndefined();
  });

  it('hakedis listesi ve ilerleme: ters kayit soluk ve sayilmaz, kalan tutar; asim gerekcesi gosterilir', async () => {
    current = tender({
      expenses: [link('e1', 54_000_00, { installment: 1, reversed: true }), link('e2', 60_000_00, { installment: 2 }), link('e3', 50_000_00, { installment: 3, overrunReason: 'Ek iskele kirası' })],
      expenseProgress: progress(110_000_00, { activeCount: 2, reversedCount: 1 }),
      expenseDraft: draft(0, { installment: 4 }),
    });
    await render();
    const text = container.textContent ?? '';
    expect(text).toContain('₺110.000,00 / ₺108.000,00');
    expect(text).toContain('aşım ₺2.000,00');
    expect(text).toContain('1. Gider ters kaydedildi: ₺54.000,00');
    expect(text).toContain('Ters kayıt');
    expect(text).toContain('Aşım gerekçesi: Ek iskele kirası');
    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
  });

  it('karar tutari asilinca (422 overBudget) "Aşım gerekçesi" istenir ve gerekceyle yeniden gonderilir', async () => {
    current = tender({ expenses: [link('e1', 100_000_00, { installment: 1 })], expenseProgress: progress(100_000_00), expenseDraft: draft(8_000_00, { installment: 2 }) });
    expenseFn.mockImplementationOnce(async () => {
      throw new ApiError(422, { error: 'unprocessable', message: 'Geçerli giderler toplamı karar tutarını aşıyor; aşım için gerekçe yazın', overBudget: true, remainingKurus: 8_000_00 });
    });
    expenseFn.mockImplementationOnce(async () => ({ replayed: false, expenseId: 'e2', transactionId: 'tx2', tender: current }));
    await render();
    await click(button('Hakediş / gider ekle'));
    expect(field('input[name="amount"]')?.value).toBe('8000,00');
    await setValue(field('input[name="amount"]'), '10000,00');
    await setValue(field('select[name="creditAccountId"]'), 'payable');
    await click(inDialog('Gideri kaydet'));
    await flush();
    expect(document.querySelector('dialog[open]')?.textContent).toContain('Aşım gerekçesi');
    expect((inDialog('Gerekçeyle kaydet') as HTMLButtonElement).disabled).toBe(true);
    await setValue(field('textarea'), 'Ek iskele kirası (kurul onaylı)');
    await click(inDialog('Gerekçeyle kaydet'));
    await flush();
    expect(expenseFn).toHaveBeenLastCalledWith({ id: 't1', input: expect.objectContaining({ amount: 10_000_00, overrunReason: 'Ek iskele kirası (kurul onaylı)' }) });
  });

  it('eslestirilmis tedarikci hesabi odeme hesabi varsayilani (vadeli); eslestirme penceresi onerilenle acilir', async () => {
    current = tender({ supplierAccount: { accountId: 'sup-cephe', name: 'Cephe Yapı Ltd.', linkedAt: '2026-11-26T07:00:00.000Z', linkedBy: 'mgr' }, expenseDraft: draft(108_000_00, { creditAccountId: 'sup-cephe' }) });
    await render();
    expect(container.textContent).toContain('Tedarikçi hesabı: Cephe Yapı Ltd.');
    await click(button('Hakediş / gider ekle'));
    expect(field('select[name="creditAccountId"]')?.value).toBe('sup-cephe');
    expect(document.querySelector('dialog[open]')?.textContent).toContain('Vadeli: Cephe Yapı Ltd.');
    await click(inDialog('Vazgeç'));
    await act(async () => setCurrent(tender()));
    await click(button('Eşleştir'));
    expect(field('select')?.value).toBe('sup-cephe');
    await click(inDialog('Kaydet'));
    expect(linkSupplier).toHaveBeenCalledWith({ id: 't1', version: 5, accountId: 'sup-cephe' });
  });

  it('genel kurul karar bagi: baglanti yonetim genel kurul sayfasina; secicide yalnizca kabul edilen secilebilir', async () => {
    current = tender({ assemblyDecision: { assemblyId: 'asm1', itemId: 'a1', itemTitle: 'Isı yalıtımı yapılsın', meetingAt: '2026-11-10T16:00:00.000Z', decision: 'accepted', seq: 1, corrected: true, currentDecision: 'rejected' } });
    await render();
    const a = [...container.querySelectorAll('a')].find((x) => x.textContent?.includes('Isı yalıtımı yapılsın'));
    expect(a?.getAttribute('href')).toBe('/admin/assemblies?assembly=asm1');
    expect(container.textContent).toContain('karar sonradan düzeltildi (güncel kayıt: reddedildi)');
    await click(button('Değiştir / kaldır'));
    const options = [...(field('select') as HTMLSelectElement).options];
    expect(options.find((o) => o.value === 'asm1|a2')?.disabled).toBe(true);
    await setValue(field('select'), '');
    await click(inDialog('Bağlantıyı kaldır'));
    expect(linkAssembly).toHaveBeenCalledWith({ id: 't1', version: 5, assemblyDecision: null });
  });

  it('salt okuyan (denetci) dugmeleri gormez', async () => {
    canWrite = false;
    current = tender({ expenseDraft: undefined });
    await render();
    expect(button('Hakediş / gider ekle')).toBeUndefined();
    expect(button('Eşleştir')).toBeUndefined();
    expect(button('Bağla')).toBeUndefined();
  });
});
