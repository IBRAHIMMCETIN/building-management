import { type Quote, type Tender, type TenderSummary, normalizeQuote, tenderSchema, tenderSummarySchema } from '@bm/shared/api/tenders';

/** Teklif: tutarlar API kuraliyla KDV dahil normalize edilir. */
export const quote = (quoteId: string, supplierName: string, amountKurus: number, vatIncluded: boolean, over: Partial<Quote> = {}): Quote => ({
  quoteId,
  supplierName,
  amountKurus,
  vatIncluded,
  vatRate: 20,
  status: 'active',
  createdAt: '2026-11-01T08:00:00.000Z',
  updatedAt: '2026-11-01T08:00:00.000Z',
  document: { fileName: `${quoteId}.pdf`, contentType: 'application/pdf', size: 1000 },
  ...normalizeQuote(amountKurus, vatIncluded, 20),
  ...over,
});

export const tenderSummary = (over: Partial<TenderSummary> = {}): TenderSummary =>
  tenderSummarySchema.parse({
    tenderId: 't-1',
    title: 'Dış cephe mantolama',
    category: 'mantolama',
    status: 'published',
    deadline: '2026-11-20',
    deadlinePassed: true,
    minQuotes: 3,
    quoteCount: 2,
    lowestTotalKurus: 120_000_00,
    publishedAt: '2026-11-21T08:00:00.000Z',
    createdAt: '2026-11-01T08:00:00.000Z',
    updatedAt: '2026-11-21T08:00:00.000Z',
    version: 3,
    ...over,
  });

/**
 * Yayindaki ihale: KDV haric 100.000 TL (KDV dahil 120.000, en dusuk) ve KDV dahil 150.000 TL
 * teklif, bir geri cekilmis teklif, bir yonetim yaniti ve bir baska sakinin sorusu.
 */
export const tender = (over: Partial<Tender> = {}): Tender => {
  const quotes = [
    quote('q-a', 'Yalıtım Ltd.', 150_000_00, true, { deliveryDays: 30, warrantyMonths: 24, validUntil: '2026-12-31' }),
    quote('q-b', 'Cephe A.Ş.', 100_000_00, false, { warrantyMonths: 0, notes: 'İskele dahil' }),
    quote('q-c', 'Geri Çekilen Yapı', 90_000_00, true, { status: 'withdrawn', withdrawReason: 'Firma vazgeçti', withdrawnAt: '2026-11-10T08:00:00.000Z' }),
  ];
  return tenderSchema.parse({
    ...tenderSummary(),
    description: 'A ve B blok dış cephe yalıtımı.',
    quotes,
    comparison: {
      rows: [
        { quoteId: 'q-b', netKurus: 100_000_00, vatKurus: 20_000_00, totalKurus: 120_000_00, rank: 1, isLowest: true, diffKurus: 0, diffBps: 0 },
        { quoteId: 'q-a', netKurus: 125_000_00, vatKurus: 25_000_00, totalKurus: 150_000_00, rank: 2, isLowest: false, diffKurus: 30_000_00, diffBps: 2500 },
      ],
      lowestQuoteIds: ['q-b'],
      lowestTotalKurus: 120_000_00,
      highestTotalKurus: 150_000_00,
      lowestNetQuoteIds: ['q-b'],
    },
    comments: [
      { commentId: 'c1', body: 'İskele ne zaman kurulacak?', authorKind: 'resident', mine: false, createdAt: '2026-11-22T08:00:00.000Z' },
      { commentId: 'c2', body: 'Karar sonrası iki hafta içinde.', authorKind: 'management', mine: false, createdAt: '2026-11-22T10:00:00.000Z' },
      { commentId: 'c3', body: 'Garanti süresi uzatılabilir mi?', authorKind: 'resident', mine: true, createdAt: '2026-11-23T08:00:00.000Z' },
    ],
    canComment: true,
    ...over,
  });
};
