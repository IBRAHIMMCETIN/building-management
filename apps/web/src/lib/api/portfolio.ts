import { z } from 'zod';
import type { SelectableContext } from '@/lib/auth/contexts';
import { PORTFOLIO_ROLES } from '@/types/roles';
import { apiClient } from './client';

/**
 * Yonetim firmasi portfoyu (apps/api/src/modules/portfolio):
 *   GET /api/portfolio?limit=&cursor=  -> { asOf, period, total, limit, items[], totals, nextCursor? }
 * Kartlar yalnizca toplamlar tasir (kisisel veri yok). Listelenen apartmanlari sunucu her istekte
 * kullanicinin guncel yetki kayitlarindan cikarir; istemci apartman kimligi gondermez.
 */

/** Portfoye giren roller (API `PORTFOLIO_ROLES` ile ayni). */
export { PORTFOLIO_ROLES };
export type PortfolioRole = (typeof PORTFOLIO_ROLES)[number];

export const PORTFOLIO_SECTIONS = ['units', 'finance', 'collection', 'tickets', 'maintenance', 'equipment', 'polls', 'assemblies', 'tenders'] as const;
export type PortfolioSection = (typeof PORTFOLIO_SECTIONS)[number];

export const SECTION_LABELS: Record<PortfolioSection, string> = {
  units: 'Daireler',
  finance: 'Finans',
  collection: 'Tahsilat',
  tickets: 'Talepler',
  maintenance: 'Bakım',
  equipment: 'Ekipman',
  polls: 'Oylamalar',
  assemblies: 'Genel kurul',
  tenders: 'İhaleler',
};

const count = z.number().int().nonnegative();
const kurus = z.number().int();

export const portfolioCardSchema = z.object({
  apartmentId: z.string(),
  apartmentName: z.string(),
  role: z.enum(PORTFOLIO_ROLES),
  readOnly: z.boolean(),
  status: z.enum(['ok', 'partial', 'error']),
  failed: z.array(z.enum(PORTFOLIO_SECTIONS)),
  units: z.object({ count }).optional(),
  finance: z
    .object({ cash: kurus, bank: kurus, totalFunds: kurus, receivables: kurus, overdue: kurus, overdueUnitCount: count, advances: kurus, payables: kurus })
    .optional(),
  collection: z.object({ period: z.string(), charged: kurus, collected: kurus, collectionRatePct: z.number().optional() }).optional(),
  tickets: z
    .object({ openCount: count, openByPriority: z.object({ low: count, normal: count, high: count, urgent: count }), overdueCount: count })
    .optional(),
  maintenance: z.object({ overdueCount: count, dueThisWeekCount: count }).optional(),
  equipment: z
    .object({ expiringCount: count, expiringByKind: z.object({ warranty: count, contract: count, inspection: count }), expiredCount: count })
    .optional(),
  polls: z.object({ openCount: count, scheduledCount: count }).optional(),
  assemblies: z.object({ upcomingCount: count, nextAt: z.string().optional() }).optional(),
  tenders: z.object({ openCount: count }).optional(),
});
export type PortfolioCard = z.infer<typeof portfolioCardSchema>;

export const portfolioTotalsSchema = z.object({
  apartmentCount: count,
  incompleteCount: count,
  unitCount: count,
  charged: kurus,
  collected: kurus,
  collectionRatePct: z.number().optional(),
  receivables: kurus,
  overdue: kurus,
  overdueUnitCount: count,
  cash: kurus,
  bank: kurus,
  totalFunds: kurus,
  openTickets: count,
  urgentTickets: count,
  ticketSlaBreaches: count,
  maintenanceOverdue: count,
  maintenanceDueThisWeek: count,
  equipmentExpiring: count,
  upcomingAssemblies: count,
  openPolls: count,
  openTenders: count,
});
export type PortfolioTotals = z.infer<typeof portfolioTotalsSchema>;

export const portfolioPageSchema = z.object({
  asOf: z.string(),
  period: z.string(),
  total: count,
  limit: count,
  items: z.array(portfolioCardSchema),
  totals: portfolioTotalsSchema,
  nextCursor: z.string().optional(),
});
export type PortfolioPage = z.infer<typeof portfolioPageSchema>;

export const portfolioApi = {
  page: (query: { cursor?: string; limit?: number }, signal?: AbortSignal) => apiClient.get('/api/portfolio', { signal, query, schema: portfolioPageSchema }),
};

// ---------------------------------------------------------------------------
// Saf yardimcilar (birim testlenir)
// ---------------------------------------------------------------------------

/**
 * Menu: portfoy, kullanicinin en az iki apartmaninda portfoy rolu varsa gorunur (tek apartmanda
 * Genel Bakis ayni bilgiyi verir). Kaynak baglam secicisiyle ayni `GET /api/me/contexts` listesidir;
 * asil yetki kontrolu API'dedir.
 */
export function portfolioApartmentCount(contexts: readonly Pick<SelectableContext, 'apartmentId' | 'role'>[]): number {
  return new Set(contexts.filter((c) => (PORTFOLIO_ROLES as readonly string[]).includes(c.role)).map((c) => c.apartmentId)).size;
}

/** Sayfalari tek listede birlestirir; toplamlar yuklenen kartlardan yeniden hesaplanir (API ile ayni kural). */
export function mergePages(pages: readonly PortfolioPage[]): { items: PortfolioCard[]; total: number; totals: PortfolioTotals } {
  const items = pages.flatMap((p) => p.items);
  const sum = (f: (t: PortfolioTotals) => number) => pages.reduce((s, p) => s + f(p.totals), 0);
  const keys = Object.keys(portfolioTotalsSchema.shape).filter((k) => k !== 'collectionRatePct') as Exclude<keyof PortfolioTotals, 'collectionRatePct'>[];
  const totals = Object.fromEntries(keys.map((k) => [k, sum((t) => t[k])])) as PortfolioTotals;
  if (totals.charged > 0) totals.collectionRatePct = Math.round((totals.collected / totals.charged) * 10_000) / 100;
  return { items, total: pages.at(-1)?.total ?? 0, totals };
}

export type PortfolioSort = 'name' | 'collection' | 'overdue' | 'tickets';
export type PortfolioFilter = 'all' | 'attention' | 'incomplete';

/** Dikkat gerektiren: vadesi gecmis alacak, SLA asimi, geciken bakim veya okunamayan bolum. */
export function needsAttention(c: PortfolioCard): boolean {
  return c.status !== 'ok' || (c.finance?.overdue ?? 0) > 0 || (c.tickets?.overdueCount ?? 0) > 0 || (c.maintenance?.overdueCount ?? 0) > 0;
}

/**
 * Siralama: ad (A-Z), tahsilat orani (dusuk once), vadesi gecmis alacak ve acik talep (yuksek once).
 * Verisi olmayan kart her siralamada sona; esitlikte ad.
 */
export function sortCards(items: readonly PortfolioCard[], sort: PortfolioSort): PortfolioCard[] {
  const byName = (a: PortfolioCard, b: PortfolioCard) => a.apartmentName.localeCompare(b.apartmentName, 'tr');
  if (sort === 'name') return [...items].sort(byName);
  const metric = (c: PortfolioCard): number | undefined =>
    sort === 'collection' ? c.collection?.collectionRatePct : sort === 'overdue' ? c.finance?.overdue : c.tickets?.openCount;
  const ascending = sort === 'collection';
  return [...items].sort((a, b) => {
    const x = metric(a);
    const y = metric(b);
    if (x === undefined || y === undefined) return x === y ? byName(a, b) : x === undefined ? 1 : -1;
    return (ascending ? x - y : y - x) || byName(a, b);
  });
}

export function filterCards(items: readonly PortfolioCard[], filter: PortfolioFilter, query: string): PortfolioCard[] {
  const q = query.trim().toLocaleLowerCase('tr');
  return items.filter(
    (c) =>
      (filter === 'all' || (filter === 'attention' ? needsAttention(c) : c.status !== 'ok')) &&
      (!q || c.apartmentName.toLocaleLowerCase('tr').includes(q)),
  );
}
