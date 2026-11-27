import { type GrantItem, ROLE_PRECEDENCE, isCurrent, toGrants } from '../../auth/preTokenGeneration.js';
import { mapLimit } from '../core/concurrency.js';
import { ValidationError } from '../core/validation.js';
import type { CoreRepository } from '../core/repository.js';
import type { ExpiryItem } from '../equipment/types.js';
import type { EquipmentService } from '../equipment/service.js';
import type { FinanceService } from '../finance/service.js';
import type { ReportService } from '../finance/reportService.js';
import type { MaintenanceService } from '../maintenance/service.js';
import type { PollService } from '../polls/service.js';
import type { AssemblyService } from '../assemblies/service.js';
import type { TenderService } from '../tenders/service.js';
import type { TicketService } from '../tickets/service.js';
import { type PortfolioRepository, type RoleRecord, portfolioRepository } from './repository.js';
import {
  APARTMENT_CONCURRENCY,
  APARTMENT_TIMEOUT_MS,
  type AssemblyFigures,
  type CollectionFigures,
  DEFAULT_PAGE_SIZE,
  type EquipmentFigures,
  type FinanceFigures,
  MAX_PAGE_SIZE,
  type MaintenanceFigures,
  PORTFOLIO_ROLES,
  type PollFigures,
  type PortfolioCard,
  type PortfolioPage,
  type PortfolioRole,
  type PortfolioSection,
  type PortfolioTotals,
  REQUEST_BUDGET_MS,
  type TenderFigures,
  type TicketFigures,
  sectionsFor,
} from './types.js';

/** Bir apartmandaki okuma baglami: rol kullanicinin o apartmandaki dogrulanmis rolu (token'daki degil). */
export type ApartmentReadContext = { apartmentId: string; userId: string; role: PortfolioRole };

/**
 * Bolum kaynaklari: her biri mevcut bir servisin ozetini dondurur (yeniden hesaplama yok).
 * Portfoy servisi bu ciktilari yalnizca sayilara indirger.
 */
export type PortfolioSources = {
  units(ctx: ApartmentReadContext): Promise<{ count: number }>;
  finance(ctx: ApartmentReadContext): Promise<FinanceFigures>;
  collection(ctx: ApartmentReadContext): Promise<CollectionFigures>;
  tickets(ctx: ApartmentReadContext): Promise<TicketFigures>;
  maintenance(ctx: ApartmentReadContext): Promise<MaintenanceFigures>;
  equipment(ctx: ApartmentReadContext): Promise<{ items: readonly Pick<ExpiryItem, 'kind' | 'expired'>[] }>;
  polls(ctx: ApartmentReadContext): Promise<ReadonlyArray<{ phase: string }>>;
  assemblies(ctx: ApartmentReadContext): Promise<ReadonlyArray<{ status: string; scheduledAt: string }>>;
  tenders(ctx: ApartmentReadContext): Promise<{ items: ReadonlyArray<{ status: string }> }>;
};

/** Gercek servislerden kaynaklar (app.ts). Tum yollar salt okunurdur (Query / GetItem / BatchGet). */
export function createPortfolioSources(s: {
  core: Pick<CoreRepository, 'listUnits'>;
  finance: Pick<FinanceService, 'summary'>;
  reports: Pick<ReportService, 'collection'>;
  tickets: Pick<TicketService, 'stats'>;
  maintenance: Pick<MaintenanceService, 'stats'>;
  equipment: Pick<EquipmentService, 'expiring'>;
  polls: Pick<PollService, 'list'>;
  assemblies: Pick<AssemblyService, 'list'>;
  tenders: Pick<TenderService, 'list'>;
}): PortfolioSources {
  return {
    units: async (ctx) => ({ count: (await s.core.listUnits(ctx.apartmentId)).filter((u) => u.siteId === ctx.apartmentId && u.status === 'active').length }),
    finance: async (ctx) => {
      const f = await s.finance.summary(ctx, { readOnly: true });
      return {
        cash: f.cash,
        bank: f.bank,
        totalFunds: f.totalFunds,
        receivables: f.receivables,
        overdue: f.overdue,
        overdueUnitCount: f.overdueUnitCount,
        advances: f.advances,
        payables: f.payables,
      };
    },
    collection: (ctx) => s.reports.collection(ctx),
    tickets: (ctx) => s.tickets.stats(ctx),
    maintenance: (ctx) => s.maintenance.stats(ctx),
    equipment: (ctx) => s.equipment.expiring(ctx, { days: '30' }),
    polls: (ctx) => s.polls.list(ctx),
    assemblies: (ctx) => s.assemblies.list(ctx),
    tenders: (ctx) => s.tenders.list(ctx),
  };
}

// ---------------------------------------------------------------------------
// Yetki: hangi apartmanlar (saf)
// ---------------------------------------------------------------------------

export type EligibleApartment = { apartmentId: string; role: PortfolioRole };

const isPortfolioRole = (r: unknown): r is PortfolioRole => typeof r === 'string' && (PORTFOLIO_ROLES as readonly string[]).includes(r);

/** GSI1'deki guncel portfoy yetkileri (aday). */
export function candidateGrants(items: readonly GrantItem[], today: string): EligibleApartment[] {
  const seen = new Set<string>();
  const out: EligibleApartment[] = [];
  for (const g of toGrants([...items], today)) {
    if (!isPortfolioRole(g.role)) continue;
    const key = `${g.apartmentId}|${g.role}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ apartmentId: g.apartmentId, role: g.role });
  }
  return out;
}

/**
 * Taban tablo kaydiyla dogrulanan adaylar; apartman basina en yetkili rol. Aday listesinde olmayan
 * (istemcinin veya baska bir kaynagin onerdigi) apartman hicbir zaman donmez.
 */
export function confirmEligible(userId: string, candidates: readonly EligibleApartment[], records: readonly RoleRecord[], today: string): EligibleApartment[] {
  const wanted = new Set(candidates.map((c) => `${c.apartmentId}|${c.role}`));
  const best = new Map<string, PortfolioRole>();
  for (const r of records) {
    if (r.entityType !== 'APARTMENT_ROLE' || r.userId !== userId || !r.apartmentId || !isPortfolioRole(r.role)) continue;
    if (!wanted.has(`${r.apartmentId}|${r.role}`) || !isCurrent(r, today)) continue;
    const prev = best.get(r.apartmentId);
    if (!prev || ROLE_PRECEDENCE.indexOf(r.role) < ROLE_PRECEDENCE.indexOf(prev)) best.set(r.apartmentId, r.role);
  }
  return [...best].map(([apartmentId, role]) => ({ apartmentId, role }));
}

// ---------------------------------------------------------------------------
// Toplamlar (saf)
// ---------------------------------------------------------------------------

export function equipmentFigures(items: readonly Pick<ExpiryItem, 'kind' | 'expired'>[]): EquipmentFigures {
  const soon = items.filter((i) => !i.expired);
  const by = (k: ExpiryItem['kind']) => soon.filter((i) => i.kind === k).length;
  return {
    expiringCount: soon.length,
    expiringByKind: { warranty: by('warranty'), contract: by('contract'), inspection: by('inspection') },
    expiredCount: items.length - soon.length,
  };
}

export function pollFigures(polls: ReadonlyArray<{ phase: string }>): PollFigures {
  return { openCount: polls.filter((p) => p.phase === 'open').length, scheduledCount: polls.filter((p) => p.phase === 'scheduled').length };
}

/** Yaklasan: planli ve toplanti zamani henuz gelmemis genel kurullar. */
export function assemblyFigures(list: ReadonlyArray<{ status: string; scheduledAt: string }>, nowIso: string): AssemblyFigures {
  const upcoming = list.filter((a) => a.status === 'planned' && a.scheduledAt >= nowIso).map((a) => a.scheduledAt).sort();
  return { upcomingCount: upcoming.length, ...(upcoming[0] ? { nextAt: upcoming[0] } : {}) };
}

/** Acik ihale: karar verilmemis ve iptal edilmemis (taslak, teklif toplama, yayinda). */
export function tenderFigures(items: ReadonlyArray<{ status: string }>): TenderFigures {
  return { openCount: items.filter((t) => t.status === 'draft' || t.status === 'collecting' || t.status === 'published').length };
}

export function totalsOf(cards: readonly PortfolioCard[]): PortfolioTotals {
  const sum = (f: (c: PortfolioCard) => number | undefined) => cards.reduce((s, c) => s + (f(c) ?? 0), 0);
  const charged = sum((c) => c.collection?.charged);
  const collected = sum((c) => c.collection?.collected);
  return {
    apartmentCount: cards.length,
    incompleteCount: cards.filter((c) => c.status !== 'ok').length,
    unitCount: sum((c) => c.units?.count),
    charged,
    collected,
    ...(charged > 0 ? { collectionRatePct: Math.round((collected / charged) * 10_000) / 100 } : {}),
    receivables: sum((c) => c.finance?.receivables),
    overdue: sum((c) => c.finance?.overdue),
    overdueUnitCount: sum((c) => c.finance?.overdueUnitCount),
    cash: sum((c) => c.finance?.cash),
    bank: sum((c) => c.finance?.bank),
    totalFunds: sum((c) => c.finance?.totalFunds),
    openTickets: sum((c) => c.tickets?.openCount),
    urgentTickets: sum((c) => c.tickets?.openByPriority.urgent),
    ticketSlaBreaches: sum((c) => c.tickets?.overdueCount),
    maintenanceOverdue: sum((c) => c.maintenance?.overdueCount),
    maintenanceDueThisWeek: sum((c) => c.maintenance?.dueThisWeekCount),
    equipmentExpiring: sum((c) => c.equipment?.expiringCount),
    upcomingAssemblies: sum((c) => c.assemblies?.upcomingCount),
    openPolls: sum((c) => c.polls?.openCount),
    openTenders: sum((c) => c.tenders?.openCount),
  };
}

// ---------------------------------------------------------------------------
// Sayfalama
// ---------------------------------------------------------------------------

const CURSOR_PREFIX = 'o:';
export const encodeCursor = (offset: number) => Buffer.from(`${CURSOR_PREFIX}${offset}`).toString('base64url');

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor === '') return 0;
  const raw = /^[A-Za-z0-9_-]{1,32}$/.test(cursor) ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
  const offset = raw.startsWith(CURSOR_PREFIX) ? Number(raw.slice(CURSOR_PREFIX.length)) : Number.NaN;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new ValidationError('cursor geçersiz', 'cursor');
  return offset;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_PAGE_SIZE;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > MAX_PAGE_SIZE) throw new ValidationError(`limit 1-${MAX_PAGE_SIZE} olmalı`, 'limit');
  return n;
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type PortfolioServiceDeps = {
  repo: PortfolioRepository;
  sources: PortfolioSources;
  now: () => Date;
  concurrency: number;
  apartmentTimeoutMs: number;
  requestBudgetMs: number;
  /** Bolum hatasi yalnizca sunucu gunlugune (apartman + bolum + hata adi); istemciye kod doner. */
  log: (entry: Record<string, unknown>) => void;
};

class SectionTimeout extends Error {
  override name = 'SectionTimeout';
}

const istanbulDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(d);

export function createPortfolioService(overrides: Partial<PortfolioServiceDeps> & Pick<PortfolioServiceDeps, 'sources'>) {
  const deps: PortfolioServiceDeps = {
    repo: portfolioRepository,
    now: () => new Date(),
    concurrency: APARTMENT_CONCURRENCY,
    apartmentTimeoutMs: APARTMENT_TIMEOUT_MS,
    requestBudgetMs: REQUEST_BUDGET_MS,
    log: (entry) => console.error(JSON.stringify(entry)),
    ...overrides,
  };

  /** Kullanicinin bugun portfoyune giren apartmanlari (adla sirali). */
  async function eligible(userId: string) {
    const today = istanbulDate(deps.now());
    const candidates = candidateGrants(await deps.repo.grantItems(userId), today);
    const confirmed = confirmEligible(userId, candidates, await deps.repo.roleRecords(userId, candidates), today);
    const names = await deps.repo.siteNames(confirmed.map((c) => c.apartmentId));
    return confirmed
      .map((c) => ({ ...c, apartmentName: names.get(c.apartmentId) ?? c.apartmentId }))
      .sort((a, b) => a.apartmentName.localeCompare(b.apartmentName, 'tr') || a.apartmentId.localeCompare(b.apartmentId));
  }

  /** Sureyi asan veya hata veren bolum `failed` olur; digerleri doner (apartman bazinda yalitim). */
  function within<T>(p: Promise<T>, ms: number): Promise<T> {
    if (ms <= 0) return Promise.reject(new SectionTimeout());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SectionTimeout()), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  async function card(apt: EligibleApartment & { apartmentName: string }, userId: string, deadline: number): Promise<PortfolioCard> {
    const ctx: ApartmentReadContext = { apartmentId: apt.apartmentId, userId, role: apt.role };
    const sections = sectionsFor(apt.role);
    const budget = Math.min(deps.apartmentTimeoutMs, deadline - Date.now());
    const nowIso = deps.now().toISOString();
    const read: Record<PortfolioSection, () => Promise<unknown>> = {
      units: () => deps.sources.units(ctx),
      finance: () => deps.sources.finance(ctx),
      collection: () => deps.sources.collection(ctx),
      tickets: () => deps.sources.tickets(ctx),
      maintenance: () => deps.sources.maintenance(ctx),
      equipment: async () => equipmentFigures((await deps.sources.equipment(ctx)).items),
      polls: async () => pollFigures(await deps.sources.polls(ctx)),
      assemblies: async () => assemblyFigures(await deps.sources.assemblies(ctx), nowIso),
      tenders: async () => tenderFigures((await deps.sources.tenders(ctx)).items),
    };
    // Istek butcesi bittiyse apartman hic okunmaz (bolumler `failed`; istemci sonra yeniden dener).
    const settled: PromiseSettledResult<unknown>[] =
      budget <= 0
        ? sections.map(() => ({ status: 'rejected', reason: new SectionTimeout() }))
        : await Promise.allSettled(sections.map((s) => within(Promise.resolve().then(read[s]), budget)));
    const out: PortfolioCard = {
      apartmentId: apt.apartmentId,
      apartmentName: apt.apartmentName,
      role: apt.role,
      readOnly: apt.role === 'observer',
      status: 'ok',
      failed: [],
    };
    settled.forEach((r, i) => {
      const section = sections[i] as PortfolioSection;
      if (r.status === 'fulfilled') {
        (out as Record<string, unknown>)[section] = r.value;
      } else {
        out.failed.push(section);
        const err = r.reason as { name?: string; code?: string } | undefined;
        deps.log({ msg: 'portfolio_section_failed', apartmentId: apt.apartmentId, section, error: err?.name ?? 'Error', ...(err?.code ? { code: err.code } : {}) });
      }
    });
    out.status = out.failed.length === 0 ? 'ok' : out.failed.length === sections.length ? 'error' : 'partial';
    return out;
  }

  async function list(ctx: { userId: string }, q: { limit?: string; cursor?: string } = {}): Promise<PortfolioPage> {
    const limit = parseLimit(q.limit);
    const offset = decodeCursor(q.cursor);
    const now = deps.now();
    const deadline = Date.now() + deps.requestBudgetMs;
    const all = await eligible(ctx.userId);
    const page = all.slice(offset, offset + limit);
    const items = await mapLimit(page, deps.concurrency, (apt) => card(apt, ctx.userId, deadline));
    return {
      asOf: istanbulDate(now),
      period: istanbulDate(now).slice(0, 7),
      total: all.length,
      limit,
      items,
      totals: totalsOf(items),
      ...(offset + limit < all.length ? { nextCursor: encodeCursor(offset + limit) } : {}),
    };
  }

  return { list, eligible };
}

export type PortfolioService = ReturnType<typeof createPortfolioService>;
