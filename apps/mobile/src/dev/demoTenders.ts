import { normalizeQuote } from '@bm/shared/api/tenders';
import type { DemoHandler } from './demoApi';

/*
 * DEMO ihaleler (/api/portal/tenders): sakinlerle paylasilmis mantolama ihalesi (uc teklif, biri
 * KDV haric, biri geri cekilmis; sorular acik) ve karara baglanmis asansor revizyonu. Soru gonderme
 * demo oturumu boyunca hatirlanir (ayni idempotency anahtari ayni sonuc). Teklif belgeleri demo
 * modunda yoktur. Gercek veri DEGILDIR.
 */

const DAY = 86_400_000;

type QuoteSeed = { quoteId: string; supplierName: string; amountKurus: number; vatIncluded: boolean; vatRate: number; deliveryDays?: number; warrantyMonths?: number; validUntil?: string; notes?: string; withdrawn?: string; document?: boolean };
type CommentSeed = { commentId: string; body: string; authorKind: 'resident' | 'management'; mine: boolean; createdAt: string };
type TenderSeed = {
  tenderId: string;
  title: string;
  description: string;
  category: string;
  status: 'published' | 'decided';
  deadline: string;
  minQuotes: number;
  publishedAt: string;
  createdAt: string;
  quotes: QuoteSeed[];
  comments: CommentSeed[];
  shortfallReason?: string;
  decision?: { quoteId: string; reason: string; reference?: string; decidedAt: string };
};

function seed(now: Date): TenderSeed[] {
  const at = (days: number) => new Date(now.getTime() + days * DAY).toISOString();
  const date = (days: number) => at(days).slice(0, 10);
  return [
    {
      tenderId: 't-1',
      title: 'Dış cephe ısı yalıtımı (mantolama)',
      description: 'A ve B blok dış cephelerine 5 cm taşyünü mantolama, iskele ve cephe boyası dahil. Teklifler yaklaşan olağan genel kurulda görüşülecek.',
      category: 'mantolama',
      status: 'published',
      deadline: date(-2),
      minQuotes: 3,
      publishedAt: at(-1),
      createdAt: at(-20),
      quotes: [
        { quoteId: 'q-1', supplierName: 'Yalıtım Yapı Ltd.', amountKurus: 1_850_000_00, vatIncluded: true, vatRate: 20, deliveryDays: 45, warrantyMonths: 60, validUntil: date(30), document: true },
        { quoteId: 'q-2', supplierName: 'Cephe Pro İnşaat', amountKurus: 1_600_000_00, vatIncluded: false, vatRate: 20, deliveryDays: 60, warrantyMonths: 24, validUntil: date(20), notes: 'İskele kirası ayrıca faturalandırılmaz.', document: true },
        { quoteId: 'q-3', supplierName: 'Mavi Mantolama', amountKurus: 2_040_000_00, vatIncluded: true, vatRate: 20, deliveryDays: 40, warrantyMonths: 36, document: true },
        { quoteId: 'q-4', supplierName: 'Hızlı Cephe', amountKurus: 1_500_000_00, vatIncluded: true, vatRate: 20, withdrawn: 'Firma teklifini süre dolmadan geri çekti.', document: true },
      ],
      comments: [
        { commentId: 'c-1', body: 'Taşyünü yerine EPS kullanılırsa fiyat ne kadar düşer?', authorKind: 'resident', mine: false, createdAt: at(-1) },
        { commentId: 'c-2', body: 'Yangın güvenliği için yönetmelik gereği taşyünü istendi; EPS teklifi alınmadı.', authorKind: 'management', mine: false, createdAt: at(-0.5) },
      ],
    },
    {
      tenderId: 't-2',
      title: 'Asansör revizyonu (A Blok)',
      description: 'Kumanda panosu ve kapı mekanizmalarının yenilenmesi; yıllık periyodik kontrolde istenen eksikler.',
      category: 'asansor',
      status: 'decided',
      deadline: date(-60),
      minQuotes: 3,
      publishedAt: at(-55),
      createdAt: at(-80),
      shortfallReason: 'Bölgede yetkili üç firmadan biri teklif vermedi; iki teklifle devam edildi.',
      quotes: [
        { quoteId: 'q-5', supplierName: 'Asansör Teknik A.Ş.', amountKurus: 420_000_00, vatIncluded: false, vatRate: 20, deliveryDays: 21, warrantyMonths: 24, document: true },
        { quoteId: 'q-6', supplierName: 'Güven Asansör', amountKurus: 486_000_00, vatIncluded: true, vatRate: 20, deliveryDays: 14, warrantyMonths: 12, document: true },
      ],
      comments: [],
      decision: { quoteId: 'q-6', reason: 'Daha kısa iş süresi ve periyodik kontrol tarihine yetişmesi nedeniyle seçildi; fark işletme bütçesinin yedeğinden karşılanacak.', reference: 'Yönetim kurulu kararı 2026/7', decidedAt: at(-40) },
    },
  ];
}

function detail(t: TenderSeed, now: Date) {
  const quotes = t.quotes.map((q) => ({
    quoteId: q.quoteId,
    supplierName: q.supplierName,
    amountKurus: q.amountKurus,
    vatIncluded: q.vatIncluded,
    vatRate: q.vatRate,
    ...(q.validUntil ? { validUntil: q.validUntil } : {}),
    ...(q.deliveryDays !== undefined ? { deliveryDays: q.deliveryDays } : {}),
    ...(q.warrantyMonths !== undefined ? { warrantyMonths: q.warrantyMonths } : {}),
    ...(q.notes ? { notes: q.notes } : {}),
    ...(q.document ? { document: { fileName: `${q.quoteId}.pdf`, contentType: 'application/pdf', size: 240_000 } } : {}),
    status: q.withdrawn ? ('withdrawn' as const) : ('active' as const),
    ...(q.withdrawn ? { withdrawnAt: t.publishedAt, withdrawReason: q.withdrawn } : {}),
    createdAt: t.createdAt,
    updatedAt: t.createdAt,
    ...normalizeQuote(q.amountKurus, q.vatIncluded, q.vatRate),
  }));
  const active = quotes.filter((q) => q.status === 'active').sort((a, b) => a.totalKurus - b.totalKurus);
  const lowest = active[0]?.totalKurus;
  const lowestNet = Math.min(...active.map((q) => q.netKurus));
  const rows = active.map((q, i) => ({
    quoteId: q.quoteId,
    netKurus: q.netKurus,
    vatKurus: q.vatKurus,
    totalKurus: q.totalKurus,
    rank: i + 1,
    isLowest: q.totalKurus === lowest,
    diffKurus: q.totalKurus - (lowest ?? 0),
    diffBps: lowest ? Math.round(((q.totalKurus - lowest) / lowest) * 10_000) : 0,
  }));
  const chosen = t.decision ? quotes.find((q) => q.quoteId === t.decision?.quoteId) : undefined;
  const decision =
    t.decision && chosen
      ? { ...t.decision, supplierName: chosen.supplierName, netKurus: chosen.netKurus, vatKurus: chosen.vatKurus, totalKurus: chosen.totalKurus }
      : undefined;
  return {
    tenderId: t.tenderId,
    title: t.title,
    category: t.category,
    status: t.status,
    deadline: t.deadline,
    deadlinePassed: t.deadline < now.toISOString().slice(0, 10),
    minQuotes: t.minQuotes,
    quoteCount: active.length,
    ...(lowest !== undefined ? { lowestTotalKurus: lowest } : {}),
    publishedAt: t.publishedAt,
    ...(decision ? { decision } : {}),
    createdAt: t.createdAt,
    updatedAt: t.publishedAt,
    version: 3,
    description: t.description,
    ...(t.shortfallReason ? { shortfallReason: t.shortfallReason } : {}),
    quotes,
    comparison: {
      rows,
      lowestQuoteIds: rows.filter((r) => r.isLowest).map((r) => r.quoteId),
      ...(lowest !== undefined ? { lowestTotalKurus: lowest, highestTotalKurus: active[active.length - 1]?.totalKurus } : {}),
      lowestNetQuoteIds: active.filter((q) => q.netKurus === lowestNet).map((q) => q.quoteId),
    },
    comments: t.comments,
    canComment: t.status === 'published',
  };
}

const summary = (d: ReturnType<typeof detail>) => {
  const { description: _d, shortfallReason: _s, quotes: _q, comparison: _c, comments: _m, canComment: _k, ...rest } = d;
  return rest;
};

export function createTendersDemo(): DemoHandler {
  let tenders: TenderSeed[] | null = null;
  const replies = new Map<string, string>();

  return ({ method, path, body, now }) => {
    if (!path.startsWith('/api/portal/tenders')) return undefined;
    tenders ??= seed(now);
    if (path === '/api/portal/tenders' && method === 'GET') return { status: 200, body: { items: tenders.map((t) => summary(detail(t, now))) } };
    const [, id, rest] = /^\/api\/portal\/tenders\/([^/]+)(?:\/(.+))?$/.exec(path) ?? [];
    const tender = tenders.find((t) => t.tenderId === decodeURIComponent(id ?? ''));
    if (!tender) return { status: 404, body: { error: 'not_found', message: 'İhale bulunamadı' } };
    if (!rest && method === 'GET') return { status: 200, body: { tender: detail(tender, now) } };
    if (rest?.startsWith('quotes/') && rest.endsWith('/document')) {
      return { status: 404, body: { error: 'not_found', message: 'Demo modunda teklif belgesi yok; gerçek API’de belge burada açılır.' } };
    }
    if (rest === 'comments' && method === 'POST') {
      const { idempotencyKey = '', body: text = '' } = (body ?? {}) as { idempotencyKey?: string; body?: string };
      if (replies.has(idempotencyKey)) return { status: 200, body: { tender: detail(tender, now), replayed: true } };
      if (tender.status !== 'published') return { status: 409, body: { error: 'invalid_state', message: 'Yalnızca yayındaki ihaleye soru yazılabilir' } };
      const trimmed = text.trim();
      if (trimmed.length < 3 || trimmed.length > 500) return { status: 400, body: { error: 'validation', message: 'Mesaj 3-500 karakter olmalı', field: 'body' } };
      const commentId = `c-demo-${replies.size + 1}`;
      replies.set(idempotencyKey, commentId);
      tender.comments = [...tender.comments, { commentId, body: trimmed, authorKind: 'resident', mine: true, createdAt: now.toISOString() }];
      return { status: 200, body: { tender: detail(tender, now), replayed: false } };
    }
    return undefined;
  };
}
