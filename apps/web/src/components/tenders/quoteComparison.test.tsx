// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { comparisonSchema, quoteSchema } from '@/lib/api/tenders';
import { QuoteComparison } from './QuoteComparison';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const q = (id: string, totalKurus: number, over: Record<string, unknown> = {}) =>
  quoteSchema.parse({
    quoteId: id,
    supplierName: `Firma ${id.toUpperCase()}`,
    amountKurus: totalKurus,
    vatIncluded: true,
    vatRate: 20,
    status: 'active',
    createdAt: '2026-11-27T07:00:00.000Z',
    updatedAt: '2026-11-27T07:00:00.000Z',
    netKurus: Math.round(totalKurus / 1.2),
    vatKurus: totalKurus - Math.round(totalKurus / 1.2),
    totalKurus,
    document: { fileName: `${id}.pdf`, contentType: 'application/pdf', size: 100 },
    ...over,
  });

let container: HTMLDivElement | undefined;
afterEach(() => {
  container?.remove();
  container = undefined;
});

function render(ui: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return container;
}

describe('teklif karsilastirma tablosu', () => {
  const quotes = [q('a', 120_000_00), q('b', 96_000_00, { vatIncluded: false, amountKurus: 80_000_00 }), q('c', 99_000_00, { status: 'withdrawn', withdrawReason: 'Firma çekildi' })];
  const comparison = comparisonSchema.parse({
    rows: [
      { quoteId: 'b', netKurus: 80_000_00, vatKurus: 16_000_00, totalKurus: 96_000_00, rank: 1, isLowest: true, diffKurus: 0, diffBps: 0 },
      { quoteId: 'a', netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00, rank: 2, isLowest: false, diffKurus: 24_000_00, diffBps: 2500 },
    ],
    lowestQuoteIds: ['b'],
    lowestTotalKurus: 96_000_00,
    highestTotalKurus: 120_000_00,
    lowestNetQuoteIds: ['b'],
  });

  it('teklifler yan yana, en dusuk once ve vurgulu; secilen isaretli; geri cekilen ayri; belge acilir', async () => {
    const load = vi.fn(async (id: string) => ({ url: `https://example.test/${id}`, fileName: `${id}.pdf`, contentType: 'application/pdf', expiresAt: '' }));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { value: { ...window.location, assign }, configurable: true });
    const el = render(<QuoteComparison tender={{ quotes, comparison, decision: { quoteId: 'a', reason: 'Garanti', supplierName: 'Firma A', netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00, decidedAt: '2026-12-20T07:00:00.000Z' } }} loadDocument={load} />);
    const headers = [...el.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    expect(headers[1]).toContain('Firma B');
    expect(headers[1]).toContain('En düşük');
    expect(headers[2]).toContain('Firma A');
    expect(headers[2]).toContain('Seçilen teklif');
    expect(headers[2]).toContain('2. sırada');
    const totalRow = [...el.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.startsWith('KDV dahil toplam'));
    expect(totalRow?.textContent).toMatch(/96\.000,00.*120\.000,00/);
    const diffRow = [...el.querySelectorAll('tbody tr')].find((tr) => tr.textContent?.startsWith('En düşüğe göre'));
    expect(diffRow?.textContent).toContain('%25');
    expect(el.textContent).toContain('Geri çekilen teklifler');
    expect(el.textContent).toContain('Firma çekildi');
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Teklifi aç'));
    await act(async () => {
      button?.click();
    });
    expect(load).toHaveBeenCalledWith('b');
    expect(assign).toHaveBeenCalledWith('https://example.test/b');
    open.mockRestore();
  });

  it('teklif yoksa bos durum', () => {
    const el = render(<QuoteComparison tender={{ quotes: [], comparison: { rows: [], lowestQuoteIds: [], lowestNetQuoteIds: [] } }} loadDocument={vi.fn()} />);
    expect(el.textContent).toContain('Henüz teklif eklenmedi.');
  });
});
