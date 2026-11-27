// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { ApiError } from '@/lib/api/errors';
import { type Quote, type Tender, quoteSchema, tenderSchema } from '@/lib/api/tenders';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// happy-dom <dialog> showModal destegi sinirli: acik kabul et.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};

/*
 * Esitlik (409) akisi: pencere acilistaki surumu gonderir; arkadaki yeniden cekme formu ve uyariyi
 * silmez; 409 sonrasi ayni pencereden tekrar gonderilmez; yeniden acilinca guncel kayitla baslar.
 */
const saveFn = vi.fn();
vi.mock('@/hooks/useTenders', async () => {
  const { useMutation } = await import('@tanstack/react-query');
  return {
    useSaveQuote: () => useMutation({ mutationFn: (v: unknown) => saveFn(v) }),
    useSaveTender: () => useMutation({ mutationFn: (v: unknown) => saveFn(v) }),
  };
});
vi.mock('@/hooks/useTickets', () => ({ useTicketList: () => ({ data: { items: [] } }) }));
vi.mock('react-router', async (orig) => ({ ...(await orig<typeof import('react-router')>()), useNavigate: () => vi.fn() }));

const { QuoteDialog } = await import('./QuoteDialog');
const { TenderDialog } = await import('./TenderDialog');

const quote = (over: Record<string, unknown> = {}): Quote =>
  quoteSchema.parse({
    quoteId: 'q1',
    supplierName: 'Kaya Yapı',
    amountKurus: 100_000_00,
    vatIncluded: true,
    vatRate: 20,
    status: 'active',
    createdAt: '2026-11-27T07:00:00.000Z',
    updatedAt: '2026-11-27T07:00:00.000Z',
    netKurus: 83_333_33,
    vatKurus: 16_666_67,
    totalKurus: 100_000_00,
    ...over,
  });

const tender = (version: number, over: Record<string, unknown> = {}): Tender =>
  tenderSchema.parse({
    tenderId: 't1',
    title: 'Dış cephe mantolama',
    category: 'mantolama',
    status: 'collecting',
    deadline: '2027-12-15',
    deadlinePassed: false,
    minQuotes: 3,
    quoteCount: 1,
    createdAt: '2026-11-27T07:00:00.000Z',
    updatedAt: '2026-11-27T07:00:00.000Z',
    version,
    description: 'A ve B blok dış cephe mantolama işi',
    quotes: [quote()],
    comparison: { rows: [], lowestQuoteIds: [], lowestNetQuoteIds: [] },
    comments: [],
    canComment: false,
    ...over,
  });

let container: HTMLDivElement;
let root: Root;
const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  saveFn.mockReset();
});

const draw = async (ui: React.ReactNode) => {
  await act(async () => root.render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>));
};
const field = (name: string) => container.querySelector<HTMLInputElement>(`[name="${name}"]`) as HTMLInputElement;
const type = async (name: string, value: string) => {
  const el = field(name);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submitButton = (label: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(label)) as HTMLButtonElement;
const submit = async (label: string) => {
  await act(async () => {
    submitButton(label).click();
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => new Promise((r) => setTimeout(r, 0)));
};
const conflict = () => new ApiError(409, { error: 'conflict', message: 'İhale başka bir işlemle değişti; sayfayı yenileyin' });
const STALE = 'başka bir işlemle değişti; değişikliğiniz kaydedilmedi';

describe('teklif penceresi: 409 sonrasi eski alanlarla uzerine yazilmaz', () => {
  it('acilistaki surumu gonderir; yeniden cekme formu sifirlamaz; tekrar gonderim engelli; yeniden acinca guncel', async () => {
    const onClose = vi.fn();
    await draw(<QuoteDialog open onClose={onClose} tender={tender(3)} quote={quote()} />);
    expect(field('supplierName').value).toBe('Kaya Yapı');
    await type('supplierName', 'Kaya Yapı A.Ş.');
    saveFn.mockRejectedValueOnce(conflict());
    await submit('Kaydet');
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(saveFn.mock.calls[0]?.[0]).toMatchObject({ tenderId: 't1', quoteId: 'q1', version: 3, input: { supplierName: 'Kaya Yapı A.Ş.' } });
    expect(container.textContent).toContain(STALE);
    expect(submitButton('Kaydet').disabled).toBe(true);

    // Arkada ihale yeniden cekildi (baska yoneticinin degisikligi): form ve uyari yerinde kalir.
    await draw(<QuoteDialog open onClose={onClose} tender={tender(4)} quote={quote({ supplierName: 'Başka Yönetici' })} />);
    expect(field('supplierName').value).toBe('Kaya Yapı A.Ş.');
    expect(container.textContent).toContain(STALE);
    await submit('Kaydet');
    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();

    // Kapatip yeniden acinca guncel kayit ve surumle baslar.
    await draw(<QuoteDialog open={false} onClose={onClose} tender={tender(4)} quote={quote({ supplierName: 'Başka Yönetici' })} />);
    await draw(<QuoteDialog open onClose={onClose} tender={tender(4)} quote={quote({ supplierName: 'Başka Yönetici' })} />);
    // Yerel <dialog> kapanirken `close` olayi onClose'u cagirir; sayac yeniden acilistan itibaren.
    onClose.mockClear();
    expect(field('supplierName').value).toBe('Başka Yönetici');
    expect(container.textContent).not.toContain(STALE);
    saveFn.mockResolvedValueOnce({ tender: tender(5) });
    await submit('Kaydet');
    expect(saveFn).toHaveBeenCalledTimes(2);
    expect(saveFn.mock.calls[1]?.[0]).toMatchObject({ quoteId: 'q1', version: 4, input: { supplierName: 'Başka Yönetici' } });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('ihale bilgileri penceresi: ayni esitlik kurali; asgari teklif sayisi kilitli', () => {
  it('409 uyarisi yeniden cekmede kalir, form sifirlanmaz; yeniden acinca yeni surumle', async () => {
    const onClose = vi.fn();
    await draw(<TenderDialog open onClose={onClose} tender={tender(2)} />);
    expect(field('minQuotes').readOnly).toBe(true);
    await type('title', 'Dış cephe mantolama ve boya');
    saveFn.mockRejectedValueOnce(conflict());
    await submit('Kaydet');
    expect(saveFn.mock.calls[0]?.[0]).toMatchObject({ id: 't1', version: 2, input: { title: 'Dış cephe mantolama ve boya', minQuotes: 3 } });
    expect(container.textContent).toContain(STALE);

    await draw(<TenderDialog open onClose={onClose} tender={tender(3, { title: 'Başkasının başlığı' })} />);
    expect(field('title').value).toBe('Dış cephe mantolama ve boya');
    expect(container.textContent).toContain(STALE);
    expect(submitButton('Kaydet').disabled).toBe(true);

    await draw(<TenderDialog open={false} onClose={onClose} tender={tender(3, { title: 'Başkasının başlığı' })} />);
    await draw(<TenderDialog open onClose={onClose} tender={tender(3, { title: 'Başkasının başlığı' })} />);
    onClose.mockClear();
    expect(field('title').value).toBe('Başkasının başlığı');
    saveFn.mockResolvedValueOnce({ tender: tender(4) });
    await submit('Kaydet');
    expect(saveFn.mock.calls[1]?.[0]).toMatchObject({ id: 't1', version: 3 });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('taslakta asgari teklif sayisi duzenlenebilir', async () => {
    await draw(<TenderDialog open onClose={vi.fn()} tender={tender(1, { status: 'draft' })} />);
    expect(field('minQuotes').readOnly).toBe(false);
  });
});
