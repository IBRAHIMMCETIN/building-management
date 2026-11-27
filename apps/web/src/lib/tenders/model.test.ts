import { describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Tender, tenderSchema } from '@/lib/api/tenders';
import { allowedActions, canEditQuotes, comparisonColumns, deadlineText, formatBps, normalizeQuote, publishBlockers, termsSummary, warrantyText } from './model';

const quote = (id: string, over: Record<string, unknown> = {}) => ({
  quoteId: id,
  supplierName: `Firma ${id}`,
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

const tender = (over: Record<string, unknown> = {}): Tender =>
  tenderSchema.parse({
    tenderId: 't1',
    title: 'Mantolama',
    category: 'mantolama',
    status: 'collecting',
    deadline: '2026-12-15',
    deadlinePassed: false,
    minQuotes: 3,
    quoteCount: 2,
    createdAt: '2026-11-27T07:00:00.000Z',
    updatedAt: '2026-11-27T07:00:00.000Z',
    version: 3,
    description: 'Dış cephe mantolama',
    quotes: [quote('a'), quote('b', { status: 'withdrawn', withdrawReason: 'Firma çekildi' }), quote('c', { amountKurus: 80_000_00, vatIncluded: false, netKurus: 80_000_00, vatKurus: 16_000_00, totalKurus: 96_000_00 })],
    comparison: {
      rows: [
        { quoteId: 'c', netKurus: 80_000_00, vatKurus: 16_000_00, totalKurus: 96_000_00, rank: 1, isLowest: true, diffKurus: 0, diffBps: 0 },
        { quoteId: 'a', netKurus: 83_333_33, vatKurus: 16_666_67, totalKurus: 100_000_00, rank: 2, isLowest: false, diffKurus: 4_000_00, diffBps: 417 },
      ],
      lowestQuoteIds: ['c'],
      lowestTotalKurus: 96_000_00,
      highestTotalKurus: 100_000_00,
      lowestNetQuoteIds: ['c'],
    },
    comments: [],
    canComment: false,
    readiness: { activeQuotes: 2, minQuotes: 3, missingDocuments: ['a'], shortfall: true },
    ...over,
  });

describe('ihale modeli: KDV normalizasyonu (API ile ayni)', () => {
  it('KDV dahil / haric tutar kurus tam sayi, yarim yukari; net + KDV = toplam', () => {
    expect(normalizeQuote(120_000_00, true, 20)).toEqual({ netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00 });
    expect(normalizeQuote(100_000_00, false, 20)).toEqual({ netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00 });
    expect(normalizeQuote(100_001, true, 20)).toEqual({ netKurus: 83_334, vatKurus: 16_667, totalKurus: 100_001 });
    expect(normalizeQuote(25, false, 10)).toEqual({ netKurus: 25, vatKurus: 3, totalKurus: 28 });
    expect(normalizeQuote(5_000_00, false, 0)).toEqual({ netKurus: 5_000_00, vatKurus: 0, totalKurus: 5_000_00 });
    const big = normalizeQuote(99_999_999_999, true, 20);
    expect(big.netKurus + big.vatKurus).toBe(99_999_999_999);
  });

  it('fark orani, garanti ve kalan sure metinleri', () => {
    expect(formatBps(417)).toBe('%4,2');
    expect(formatBps(1250)).toBe('%12,5');
    expect(formatBps(0)).toBe('%0');
    expect(warrantyText(24)).toBe('2 yıl');
    expect(warrantyText(18)).toBe('18 ay');
    expect(warrantyText(6)).toBe('6 ay');
    expect(deadlineText('2026-12-15', '2026-12-12')).toBe('3 gün kaldı');
    expect(deadlineText('2026-12-15', '2026-12-15')).toBe('Son gün bugün');
    expect(deadlineText('2026-12-15', '2026-12-16')).toBe('Süresi doldu');
    expect(termsSummary({ deliveryDays: 45, warrantyMonths: 0, validUntil: '2027-01-31' }, (d) => d)).toEqual(['İş süresi 45 gün', 'Garanti yok', 'Geçerlilik 2027-01-31']);
    expect(termsSummary({}, (d) => d)).toEqual([]);
  });
});

describe('ihale modeli: durumlar ve karsilastirma', () => {
  it('izin verilen gecisler API tablosuyla ayni; teklifler yalnizca taslak / toplamada duzenlenir', () => {
    expect(allowedActions('draft')).toEqual(['collect', 'cancel']);
    expect(allowedActions('collecting')).toEqual(['publish', 'cancel']);
    expect(allowedActions('published')).toEqual(['decide', 'cancel']);
    expect(allowedActions('decided')).toEqual([]);
    expect(allowedActions('cancelled')).toEqual([]);
    expect(canEditQuotes('draft')).toBe(true);
    expect(canEditQuotes('collecting')).toBe(true);
    expect(canEditQuotes('published')).toBe(false);
  });

  it('sutunlar KDV dahil toplama gore (API siralamasi); geri cekilenler ayri', () => {
    const { columns, withdrawn } = comparisonColumns(tender());
    expect(columns.map((c) => [c.quote.quoteId, c.row.isLowest])).toEqual([
      ['c', true],
      ['a', false],
    ]);
    expect(withdrawn.map((q) => q.quoteId)).toEqual(['b']);
  });

  it('yayin engelleri: belgesiz teklif adiyla; asgari sayi alti engel degil (gerekce istenir)', () => {
    expect(publishBlockers(tender())).toEqual(['Belgesi yüklenmemiş teklif: Firma a.']);
    expect(publishBlockers(tender({ readiness: { activeQuotes: 0, minQuotes: 3, missingDocuments: [], shortfall: true } }))).toEqual(['En az bir teklif ekleyin.']);
    expect(publishBlockers(tender({ readiness: { activeQuotes: 3, minQuotes: 3, missingDocuments: [], shortfall: false } }))).toEqual([]);
    expect(publishBlockers(tender({ readiness: undefined }))).toEqual([]);
  });
});
