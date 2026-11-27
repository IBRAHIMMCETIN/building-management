// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, useSyncExternalStore } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Tender, tenderSchema } from '@/lib/api/tenders';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

/*
 * Karara baglanmis ihale: "Gider kaydı oluştur" Finans gider penceresini karardan on doldurulmus acar
 * (sessiz kayit yok), gider ihale ucuna gider; kaydedilmis gider kartta baglantisiyla gorunur.
 */
let current: Tender;
const listeners = new Set<() => void>();
/** Ayrinti onbellegi benzetimi: yazim yaniti ayrintiyi gunceller (on dolum kalkar). */
const setCurrent = (t: Tender) => {
  current = t;
  for (const l of listeners) l();
};
let canWrite = true;
const expenseFn = vi.fn();
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
    useTenderActions: () => ({ collect: stub(), publish: stub(), decide: stub(), cancel: stub(), withdrawQuote: stub(), comment: stub() }),
    useTenderExpense: () => useMutation({ mutationFn: (v: unknown) => expenseFn(v) }),
    useSaveQuote: () => useMutation({ mutationFn: vi.fn() }),
    useSaveTender: () => useMutation({ mutationFn: vi.fn() }),
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
    expenseDraft: { amountKurus: 108_000_00, supplier: 'Cephe Ltd.', description: 'İhale t1: Dış cephe mantolama · Karar KD-2026/14', expenseAccountId: 'exp-repair', date: '2026-11-27' },
    ...over,
  });

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  canWrite = true;
  expenseFn.mockReset();
  financeRecord.mockReset();
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
const click = async (el: Element | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const field = (selector: string) => document.querySelector(`dialog[open] ${selector}`) as HTMLInputElement | HTMLSelectElement | null;
const setValue = async (el: HTMLInputElement | HTMLSelectElement | null, value: string) => {
  if (!el) throw new Error('alan yok');
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('ihale karari: gider kaydi', () => {
  it('"Gider kaydı oluştur" Finans gider penceresini karardan on doldurulmus acar; kayit ihale ucuna gider', async () => {
    current = tender();
    expenseFn.mockImplementation(async () => {
      const updated = tender({ expenseDraft: undefined, expense: { expenseId: 'e1', transactionId: 'tx1', amountKurus: 108_000_00, date: '2026-11-27', linkedAt: '2026-11-27T07:00:00.000Z' } });
      // Yazim yaniti ayrintiyi gunceller: on dolum kalkar, pencere basari ekraninda kalmali.
      setCurrent(updated);
      return { replayed: false, expenseId: 'e1', transactionId: 'tx1', tender: updated };
    });
    await render();
    await click(button('Gider kaydı oluştur'));
    expect(document.querySelector('dialog[open]')?.textContent).toContain('İhale için gider kaydı');
    expect(field('select[name="expenseAccountId"]')?.value).toBe('exp-repair');
    expect(field('input[name="amount"]')?.value).toBe('108000,00');
    expect(field('input[name="description"]')?.value).toBe('İhale t1: Dış cephe mantolama · Karar KD-2026/14');
    expect(field('input[name="supplier"]')?.value).toBe('Cephe Ltd.');
    // Odeme kaynagi ihalede yok: yonetici secer (sessiz kayit yok).
    await setValue(field('select[name="creditAccountId"]'), 'payable');
    await click(button('Gideri kaydet'));
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(financeRecord).not.toHaveBeenCalled();
    expect(expenseFn).toHaveBeenCalledWith({
      id: 't1',
      input: expect.objectContaining({ idempotencyKey: expect.any(String), expenseAccountId: 'exp-repair', creditAccountId: 'payable', amount: 108_000_00, date: '2026-11-27', supplier: 'Cephe Ltd.' }),
    });
    const dialog = document.querySelector('dialog[open]');
    expect(container.textContent).toContain('Gider kaydedildi: ₺108.000,00');
    expect(dialog?.textContent).toContain('108.000,00');
    expect(dialog?.textContent).toContain('gider kaydedildi');
    // Ihale basina tek gider: "Yeni gider" sunulmaz.
    expect(button('Yeni gider')).toBeUndefined();
  });

  it('kaydedilmis gider kartta tutar ve Finans baglantisiyla gorunur; dugme yok', async () => {
    current = tender({ expenseDraft: undefined, expense: { expenseId: 'e1', transactionId: 'tx1', amountKurus: 54_000_00, date: '2026-11-27', linkedAt: '2026-11-27T07:00:00.000Z' } });
    await render();
    expect(container.textContent).toContain('Gider kaydedildi: ₺54.000,00');
    expect([...container.querySelectorAll('a')].find((a) => a.textContent === "Finans'ta görüntüle")?.getAttribute('href')).toBe('/admin/finance');
    expect(button('Gider kaydı oluştur')).toBeUndefined();
  });

  it('salt okuyan (denetci) dugmeyi gormez', async () => {
    canWrite = false;
    current = tender({ expenseDraft: undefined });
    await render();
    expect(button('Gider kaydı oluştur')).toBeUndefined();
    expect(container.textContent).not.toContain('Finans\'a kaydedin');
  });
});
