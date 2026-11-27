/**
 * Yonetim firmasi portfoyu: yetki (yalnizca uygun apartmanlar, dun biten rol, tenant izolasyonu,
 * denetci sinirlari, destek oturumu / platform yoneticisi), mevcut ozetlerle birebir toplamlar,
 * apartman bazinda hata yalitimi, sure butcesi, sayfalama / ust sinir ve HTTP onbellegi.
 */
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { GrantItem } from '../src/auth/preTokenGeneration.js';
import type { Block, Site, Unit } from '../src/modules/core/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { createEquipmentService } from '../src/modules/equipment/service.js';
import type { Equipment } from '../src/modules/equipment/types.js';
import type { EquipmentRepository } from '../src/modules/equipment/repository.js';
import { createReportService } from '../src/modules/finance/reportService.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import { createMaintenanceService } from '../src/modules/maintenance/service.js';
import type { MaintenanceTask } from '../src/modules/maintenance/types.js';
import { DataAccessError } from '../src/config/dynamodb.js';
import { type PortfolioRepository, type RoleRecord, createPortfolioRepository } from '../src/modules/portfolio/repository.js';
import {
  type ApartmentReadContext,
  type PortfolioSources,
  assemblyFigures,
  candidateGrants,
  confirmEligible,
  createPortfolioService,
  createPortfolioSources,
  encodeCursor,
  equipmentFigures,
  pollFigures,
  tenderFigures,
  totalsOf,
} from '../src/modules/portfolio/service.js';
import { DEFAULT_PAGE_SIZE, FALLBACK_BUDGET_MS, LAMBDA_MARGIN_MS, MAX_PAGE_SIZE, PORTFOLIO_SECTIONS, sectionsFor } from '../src/modules/portfolio/types.js';
import { requestDeadline } from '../src/modules/portfolio/routes.js';
import { createTenderService } from '../src/modules/tenders/service.js';
import { createTicketService } from '../src/modules/tickets/service.js';
import { DEFAULT_TICKET_SETTINGS } from '../src/modules/tickets/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';
import { createFakeMaintenanceRepo } from './fakes/maintenanceRepo.js';
import { createFakeTenderRepo } from './fakes/tenderRepo.js';
import { createFakeTicketRepo } from './fakes/ticketRepo.js';

const NOW = new Date('2026-11-25T09:00:00.000Z'); // Istanbul 12:00
const TODAY = '2026-11-25';
const USER = 'user-1';

const role = (apartmentId: string, r: string, extra: Partial<RoleRecord> = {}): RoleRecord & { userId: string } => ({
  entityType: 'APARTMENT_ROLE',
  apartmentId,
  userId: USER,
  role: r,
  status: 'active',
  startDate: '2026-01-01',
  ...extra,
});

// ---------------------------------------------------------------------------
// Sahte yetki deposu ve kaynaklar
// ---------------------------------------------------------------------------

/** GSI1 (aday) ve taban tablo (dogrulama) ayri tutulur: GSI gecikmesi taklit edilebilir. */
function fakeRepo(opts: { gsi: GrantItem[]; base?: RoleRecord[]; names?: Record<string, string> }) {
  const calls = { roleKeys: [] as Array<{ apartmentId: string; role: string }>, names: [] as string[] };
  const base = opts.base ?? (opts.gsi as RoleRecord[]).map((g) => ({ ...g, userId: USER }));
  const repo: PortfolioRepository = {
    grantItems: async () => opts.gsi,
    roleRecords: async (userId, keys) => {
      calls.roleKeys.push(...keys);
      return base.filter((r) => r.userId === userId && keys.some((k) => k.apartmentId === r.apartmentId && k.role === r.role));
    },
    siteNames: async (ids) => {
      calls.names.push(...ids);
      return new Map(ids.filter((id) => opts.names?.[id]).map((id) => [id, opts.names?.[id] as string]));
    },
  };
  return { repo, calls };
}

/** Her bolum icin sabit deger; `fail` ile belirli apartman/bolum hata verir. */
function fakeSources(opts: { fail?: Record<string, string[]>; hang?: Record<string, string[]>; onRead?: (ctx: ApartmentReadContext, section: string) => void } = {}) {
  const read = <T>(section: string, value: (ctx: ApartmentReadContext) => T) => async (ctx: ApartmentReadContext): Promise<T> => {
    opts.onRead?.(ctx, section);
    if (opts.hang?.[ctx.apartmentId]?.includes(section)) return new Promise<T>(() => {});
    if (opts.fail?.[ctx.apartmentId]?.includes(section)) throw new Error(`gizli ic hata ${ctx.apartmentId}`);
    return value(ctx);
  };
  const n = (ctx: ApartmentReadContext) => Number(ctx.apartmentId.replace(/\D/g, '')) || 1;
  const sources: PortfolioSources = {
    units: read('units', (c) => ({ count: 10 * n(c) })),
    finance: read('finance', (c) => ({ cash: 100 * n(c), bank: 200 * n(c), totalFunds: 300 * n(c), receivables: 50 * n(c), overdue: 20 * n(c), overdueUnitCount: n(c), advances: 0, payables: 0 })),
    collection: read('collection', (c) => ({ period: '2026-11', charged: 1000 * n(c), collected: 500 * n(c), collectionRatePct: 50 })),
    tickets: read('tickets', () => ({ openCount: 3, openByPriority: { low: 0, normal: 1, high: 1, urgent: 1 }, overdueCount: 1 })),
    maintenance: read('maintenance', () => ({ overdueCount: 2, dueThisWeekCount: 1 })),
    equipment: read('equipment', () => ({ items: [{ kind: 'warranty' as const, expired: false }, { kind: 'inspection' as const, expired: true }] })),
    polls: read('polls', () => [{ phase: 'open' }, { phase: 'closed' }]),
    assemblies: read('assemblies', () => [{ status: 'planned', scheduledAt: '2026-12-10T10:00:00.000Z' }]),
    tenders: read('tenders', () => ({ items: [{ status: 'collecting' }, { status: 'decided' }] })),
  };
  return sources;
}

const silent = () => {};

/** Gercek kaynaklar: yalnizca testin kullandigi servisler verilir. */
const withSources = (partial: Partial<Parameters<typeof createPortfolioSources>[0]>) =>
  createPortfolioSources({
    core: {} as never,
    ledger: {} as never,
    finance: {} as never,
    reports: {} as never,
    tickets: {} as never,
    maintenance: {} as never,
    equipment: {} as never,
    polls: {} as never,
    assemblies: {} as never,
    tenders: {} as never,
    ...partial,
  });

// ---------------------------------------------------------------------------
// Yetki (saf)
// ---------------------------------------------------------------------------

describe('portfoy yetkisi (saf)', () => {
  const gsi: GrantItem[] = [
    role('apt-a', 'management_company', { organizationId: 'org-1' }),
    role('apt-b', 'apartment_manager'),
    role('apt-b', 'observer'),
    role('apt-c', 'observer'),
    // Portfoye girmeyen roller / gecersiz kayitlar
    role('apt-d', 'building_staff'),
    role('apt-e', 'security_guard'),
    { entityType: 'UNIT_MEMBERSHIP', apartmentId: 'apt-f', status: 'active' },
    role('apt-g', 'apartment_manager', { endDate: '2026-11-24' }), // dun bitti
    role('apt-h', 'apartment_manager', { startDate: '2026-11-26' }), // yarin baslar
    role('apt-i', 'management_company', { status: 'inactive' }),
    role('apt-j', 'platform_admin'),
  ];

  it('adaylar: yalnizca bugun gecerli yonetici / yonetim firmasi / denetci yetkileri', () => {
    expect(candidateGrants(gsi, TODAY)).toEqual([
      { apartmentId: 'apt-a', role: 'management_company' },
      { apartmentId: 'apt-b', role: 'apartment_manager' },
      { apartmentId: 'apt-b', role: 'observer' },
      { apartmentId: 'apt-c', role: 'observer' },
    ]);
    // Bugun biten rol hala gecerlidir (endDate dahil).
    expect(candidateGrants([role('apt-g', 'apartment_manager', { endDate: TODAY })], TODAY)).toHaveLength(1);
  });

  it('taban kayitla dogrulama: apartman basina en yetkili rol; GSI gecikmesi, baska kullanici ve aday disi kayit dusulur', () => {
    const candidates = candidateGrants(gsi, TODAY);
    const base: RoleRecord[] = [
      role('apt-a', 'management_company'),
      role('apt-b', 'observer'),
      role('apt-b', 'apartment_manager'),
      // GSI hala aktif gosteriyor ama rol az once bitirildi (tutarli okuma).
      role('apt-c', 'observer', { status: 'inactive', endDate: '2026-11-25' }),
      // Aday olmayan apartman: istemci / baska kaynak onerse bile donmez.
      role('apt-x', 'apartment_manager'),
      // Baska kullanicinin kaydi.
      { ...role('apt-a', 'apartment_manager'), userId: 'someone-else' },
    ];
    expect(confirmEligible(USER, candidates, base, TODAY)).toEqual([
      { apartmentId: 'apt-a', role: 'management_company' },
      { apartmentId: 'apt-b', role: 'apartment_manager' },
    ]);
  });

  it('denetci bolumleri: kaynak uclarin okuma listesiyle ayni', () => {
    expect(sectionsFor('observer')).toEqual([...PORTFOLIO_SECTIONS]);
    expect(sectionsFor('apartment_manager')).toEqual([...PORTFOLIO_SECTIONS]);
  });
});

// ---------------------------------------------------------------------------
// Indirgeme (saf)
// ---------------------------------------------------------------------------

describe('portfoy toplamlari (saf)', () => {
  it('ekipman, oylama, genel kurul ve ihale sayilari', () => {
    expect(
      equipmentFigures([
        { kind: 'warranty', expired: false },
        { kind: 'contract', expired: false },
        { kind: 'contract', expired: true },
        { kind: 'inspection', expired: false },
      ]),
    ).toEqual({ expiringCount: 3, expiringByKind: { warranty: 1, contract: 1, inspection: 1 }, expiredCount: 1 });
    expect(pollFigures([{ phase: 'open' }, { phase: 'scheduled' }, { phase: 'open' }, { phase: 'draft' }])).toEqual({ openCount: 2, scheduledCount: 1 });
    expect(
      assemblyFigures(
        [
          { status: 'planned', scheduledAt: '2027-01-10T10:00:00.000Z' },
          { status: 'planned', scheduledAt: '2026-12-01T10:00:00.000Z' },
          { status: 'planned', scheduledAt: '2026-11-01T10:00:00.000Z' }, // gecmis
          { status: 'held', scheduledAt: '2026-12-20T10:00:00.000Z' },
          { status: 'cancelled', scheduledAt: '2026-12-21T10:00:00.000Z' },
        ],
        NOW.toISOString(),
      ),
    ).toEqual({ upcomingCount: 2, nextAt: '2026-12-01T10:00:00.000Z' });
    expect(assemblyFigures([], NOW.toISOString())).toEqual({ upcomingCount: 0 });
    expect(tenderFigures([{ status: 'draft' }, { status: 'collecting' }, { status: 'published' }, { status: 'decided' }, { status: 'cancelled' }])).toEqual({ openCount: 3 });
  });

  it('sayfa toplami: okunamayan bolum toplama girmez; oran toplam tahakkuk / tahsilattan', () => {
    const base = { apartmentName: 'x', role: 'apartment_manager' as const, readOnly: false };
    const totals = totalsOf([
      { ...base, apartmentId: 'a', status: 'ok', failed: [], collection: { period: '2026-11', charged: 1000, collected: 900 }, finance: { cash: 1, bank: 2, totalFunds: 3, receivables: 10, overdue: 5, overdueUnitCount: 1, advances: 0, payables: 0 } },
      { ...base, apartmentId: 'b', status: 'partial', failed: ['finance'], collection: { period: '2026-11', charged: 1000, collected: 100 } },
    ]);
    expect(totals).toMatchObject({ apartmentCount: 2, incompleteCount: 1, charged: 2000, collected: 1000, collectionRatePct: 50, receivables: 10, overdue: 5, totalFunds: 3 });
    expect(totalsOf([])).not.toHaveProperty('collectionRatePct');
  });
});

// ---------------------------------------------------------------------------
// Servis: yetki, yalitim, butce, sayfalama
// ---------------------------------------------------------------------------

describe('portfoy servisi', () => {
  const gsi = [role('apt-1', 'management_company'), role('apt-2', 'apartment_manager'), role('apt-3', 'observer'), role('apt-4', 'resident'), role('apt-5', 'apartment_manager', { endDate: '2026-11-24' })];
  const names = { 'apt-1': 'Zambak Sitesi', 'apt-2': 'Akasya Apartmanı', 'apt-3': 'Çınar Konutları' };

  it('yalnizca dogrulanmis apartmanlar okunur; rol token degil kayittan; adla sirali; kisisel veri yok', async () => {
    const { repo, calls } = fakeRepo({ gsi, names });
    const reads: string[] = [];
    const service = createPortfolioService({ repo, sources: fakeSources({ onRead: (c, s) => reads.push(`${c.apartmentId}:${c.role}:${s}`) }), now: () => NOW, log: silent });
    const page = await service.list({ userId: USER });
    expect(page.items.map((c) => [c.apartmentName, c.role, c.readOnly, c.status])).toEqual([
      ['Akasya Apartmanı', 'apartment_manager', false, 'ok'],
      ['Çınar Konutları', 'observer', true, 'ok'],
      ['Zambak Sitesi', 'management_company', false, 'ok'],
    ]);
    expect(new Set(reads.map((r) => r.split(':')[0]))).toEqual(new Set(['apt-1', 'apt-2', 'apt-3']));
    expect(reads).toContain('apt-3:observer:tenders');
    expect(calls.roleKeys.map((k) => k.apartmentId).sort()).toEqual(['apt-1', 'apt-2', 'apt-3']);
    expect(page).toMatchObject({ asOf: TODAY, period: '2026-11', total: 3, limit: DEFAULT_PAGE_SIZE });
    expect(page).not.toHaveProperty('nextCursor');
    expect(page.items[0]).toMatchObject({
      units: { count: 20 },
      collection: { charged: 2000, collected: 1000 },
      tickets: { openCount: 3, overdueCount: 1 },
      equipment: { expiringCount: 1, expiredCount: 1 },
      polls: { openCount: 1 },
      assemblies: { upcomingCount: 1 },
      tenders: { openCount: 1 },
    });
    expect(page.totals).toMatchObject({ apartmentCount: 3, incompleteCount: 0, unitCount: 60, charged: 6000, collected: 3000, collectionRatePct: 50, openTickets: 9, urgentTickets: 3 });
  });

  it('GSI aktif gosterse de taban kayitta biten rol listelenmez; hicbir yetki yoksa bos sayfa', async () => {
    const base = [role('apt-1', 'management_company'), role('apt-2', 'apartment_manager', { status: 'inactive' }), role('apt-3', 'observer', { endDate: '2026-11-24' })];
    const { repo } = fakeRepo({ gsi, base, names });
    const service = createPortfolioService({ repo, sources: fakeSources(), now: () => NOW, log: silent });
    expect((await service.list({ userId: USER })).items.map((c) => c.apartmentId)).toEqual(['apt-1']);

    const empty = createPortfolioService({ repo: fakeRepo({ gsi: [role('apt-4', 'resident')] }).repo, sources: fakeSources(), now: () => NOW, log: silent });
    expect(await empty.list({ userId: USER })).toMatchObject({ total: 0, items: [], totals: { apartmentCount: 0 } });
  });

  it('bir apartmanin bolum hatasi yalnizca o karti etkiler; hata ayrintisi istemciye donmez', async () => {
    const log = vi.fn();
    const { repo } = fakeRepo({ gsi, names });
    const service = createPortfolioService({
      repo,
      sources: fakeSources({ fail: { 'apt-2': ['finance', 'tickets'], 'apt-3': [...PORTFOLIO_SECTIONS] } }),
      now: () => NOW,
      log,
    });
    const page = await service.list({ userId: USER });
    const byId = new Map(page.items.map((c) => [c.apartmentId, c]));
    expect(byId.get('apt-1')).toMatchObject({ status: 'ok', failed: [] });
    expect(byId.get('apt-2')).toMatchObject({ status: 'partial', failed: ['finance', 'tickets'] });
    expect(byId.get('apt-2')).not.toHaveProperty('finance');
    expect(byId.get('apt-2')?.units).toEqual({ count: 20 });
    expect(byId.get('apt-3')).toMatchObject({ status: 'error', failed: [...PORTFOLIO_SECTIONS] });
    expect(page.totals).toMatchObject({ apartmentCount: 3, incompleteCount: 2, unitCount: 10 + 20, receivables: 50 });
    expect(JSON.stringify(page)).not.toContain('gizli');
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'portfolio_section_failed', apartmentId: 'apt-2', section: 'finance', error: 'Error' }));
    expect(JSON.stringify(log.mock.calls)).not.toContain('gizli');
  });

  it('suresini asan bolum failed; son tarih gecmisse apartman hic okunmaz', async () => {
    const { repo } = fakeRepo({ gsi, names });
    const slow = createPortfolioService({ repo, sources: fakeSources({ hang: { 'apt-1': ['collection'] } }), now: () => NOW, apartmentTimeoutMs: 20, log: silent });
    const page = await slow.list({ userId: USER });
    expect(page.items.find((c) => c.apartmentId === 'apt-1')).toMatchObject({ status: 'partial', failed: ['collection'] });
    expect(page.items.filter((c) => c.status === 'ok')).toHaveLength(2);

    const reads: string[] = [];
    const log = vi.fn();
    const spent = createPortfolioService({ repo, sources: fakeSources({ onRead: (c, s) => reads.push(`${c.apartmentId}:${s}`) }), now: () => NOW, log });
    expect((await spent.list({ userId: USER }, {}, { deadline: Date.now() - 1 })).items.every((c) => c.status === 'error')).toBe(true);
    expect(reads).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'portfolio_apartment_skipped', reason: 'request_budget' }));
  });

  it('gercek saat: yavas kaynak butce icinde kismi kart doner; butce bitince baslamamis apartman okunmaz', async () => {
    const { repo } = fakeRepo({ gsi, names });
    const sources = fakeSources({ hang: { 'apt-2': ['finance', 'tickets'] } });
    const started = Date.now();
    const page = await createPortfolioService({ repo, sources, now: () => NOW, log: silent }).list({ userId: USER }, {}, { deadline: started + 150 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1_000);
    const byId = new Map(page.items.map((c) => [c.apartmentId, c]));
    expect(byId.get('apt-2')).toMatchObject({ status: 'partial', failed: ['finance', 'tickets'], units: { count: 20 } });
    expect(byId.get('apt-1')?.status).toBe('ok');

    // Tek yuva, ilk apartman hic bitmiyor: ikinci ve ucuncu son tarihe kadar baslayamaz.
    const reads: string[] = [];
    const blocked = createPortfolioService({
      repo,
      sources: fakeSources({ hang: { 'apt-2': ['units'] }, onRead: (c, s) => reads.push(`${c.apartmentId}:${s}`) }),
      now: () => NOW,
      concurrency: 1,
      apartmentTimeoutMs: 30,
      log: silent,
    });
    const t0 = Date.now();
    const result = await blocked.list({ userId: USER }, {}, { deadline: t0 + 120 });
    expect(Date.now() - t0).toBeLessThan(1_000);
    // Adla sira: Akasya (apt-2), Cinar (apt-3), Zambak (apt-1).
    expect(result.items.map((c) => [c.apartmentId, c.status])).toEqual([
      ['apt-2', 'partial'],
      ['apt-3', 'error'],
      ['apt-1', 'error'],
    ]);
    expect(new Set(reads.map((r) => r.split(':')[0]))).toEqual(new Set(['apt-2']));
  });

  it('zaman asiminda yuva, alttaki okuma bitene kadar dolu kalir (es zamanli apartman siniri korunur)', async () => {
    const many = Array.from({ length: 6 }, (_, i) => role(`apt-${i + 1}`, 'apartment_manager'));
    const { repo } = fakeRepo({ gsi: many, names: Object.fromEntries(many.map((g, i) => [g.apartmentId as string, `Site ${i + 1}`])) });
    const inFlight = new Set<string>();
    let peak = 0;
    const sources = fakeSources();
    // Her apartmanin daire okumasi kart suresinden (15 ms) uzun surer (60 ms).
    const slowUnits: PortfolioSources['units'] = async (ctx) => {
      inFlight.add(ctx.apartmentId);
      peak = Math.max(peak, inFlight.size);
      await new Promise((r) => setTimeout(r, 60));
      inFlight.delete(ctx.apartmentId);
      return sources.units(ctx);
    };
    const service = createPortfolioService({ repo, sources: { ...sources, units: slowUnits }, now: () => NOW, concurrency: 2, apartmentTimeoutMs: 15, log: silent });
    const page = await service.list({ userId: USER }, {}, { deadline: Date.now() + 2_000 });
    expect(peak).toBe(2);
    expect(page.items.every((c) => c.status === 'partial' && c.failed.join() === 'units')).toBe(true);
  });

  it('kararli sira: adsiz (site kaydi olmayan) apartman sonda, kimlikle; ayni ad kimlikle', async () => {
    const grants = [role('apt-c', 'apartment_manager'), role('apt-a', 'apartment_manager'), role('apt-b', 'apartment_manager'), role('apt-0', 'observer')];
    const { repo } = fakeRepo({ gsi: grants, names: { 'apt-c': 'Lale', 'apt-a': 'Lale', 'apt-b': 'Akasya' } });
    const service = createPortfolioService({ repo, sources: fakeSources(), now: () => NOW, log: silent });
    expect((await service.eligible(USER)).map((a) => a.apartmentId)).toEqual(['apt-b', 'apt-a', 'apt-c', 'apt-0']);
  });

  it('sayfalama, ust sinir ve es zamanli apartman siniri', async () => {
    const many = Array.from({ length: 7 }, (_, i) => role(`apt-${i + 1}`, 'apartment_manager'));
    const { repo } = fakeRepo({ gsi: many, names: Object.fromEntries(many.map((g, i) => [g.apartmentId as string, `Site ${i + 1}`])) });
    let inFlight = 0;
    let peak = 0;
    const sources = fakeSources();
    const slowUnits: PortfolioSources['units'] = async (ctx) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return sources.units(ctx);
    };
    const service = createPortfolioService({ repo, sources: { ...sources, units: slowUnits }, now: () => NOW, concurrency: 2, log: silent });
    const first = await service.list({ userId: USER }, { limit: '3' });
    expect(first.items.map((c) => c.apartmentName)).toEqual(['Site 1', 'Site 2', 'Site 3']);
    expect(first).toMatchObject({ total: 7, limit: 3, nextCursor: encodeCursor(3) });
    expect(peak).toBeLessThanOrEqual(2);
    const second = await service.list({ userId: USER }, { limit: '3', cursor: first.nextCursor });
    expect(second.items.map((c) => c.apartmentName)).toEqual(['Site 4', 'Site 5', 'Site 6']);
    const last = await service.list({ userId: USER }, { limit: '3', cursor: second.nextCursor });
    expect(last.items.map((c) => c.apartmentName)).toEqual(['Site 7']);
    expect(last).not.toHaveProperty('nextCursor');

    await expect(service.list({ userId: USER }, { limit: String(MAX_PAGE_SIZE + 1) })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.list({ userId: USER }, { limit: '0' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.list({ userId: USER }, { cursor: 'bozuk!' })).rejects.toBeInstanceOf(ValidationError);
    await expect(service.list({ userId: USER }, { cursor: Buffer.from('o:-1').toString('base64url') })).rejects.toBeInstanceOf(ValidationError);
    expect(await service.list({ userId: USER }, { limit: String(MAX_PAGE_SIZE) })).toMatchObject({ total: 7 });
  });
});

// ---------------------------------------------------------------------------
// Mevcut ozetlerle birebir (gercek servisler, bellek ici depolar)
// ---------------------------------------------------------------------------

describe('mevcut ozetlerle birebir toplamlar', () => {
  const APT = 'apt-1';
  const mgr = { apartmentId: APT, userId: 'mgr-1', role: 'apartment_manager' as const };
  const obs = { apartmentId: APT, userId: 'obs-1', role: 'observer' as const };

  it('finans: Genel Bakis ozeti ve bu ay tahakkuk / tahsilat; hazir hesap yazimi yok, bayat ozet en iyi caba geri yazilir, hesap / bolum listesi bir kez', async () => {
    const fake = createFakeFinanceRepo(APT);
    const fiscal = createFakeFiscalRepo(fake.docs);
    const units = ['u1', 'u2'].map((id) => ({ unitId: id, siteId: APT, blockId: 'b1', number: id, status: 'active', exemptions: [], grossAreaTenthsM2: 1000 }) as unknown as Unit);
    const core = { getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id), listUnits: vi.fn(async () => units) };
    let n = 0;
    const finance = createFinanceService({ repository: fake.repo, core, now: () => NOW, newId: () => `id${String(++n).padStart(4, '0')}` });
    const zero = async () => 0;
    const reports = createReportService({
      finance: fake.repo,
      fiscal: fiscal.repo,
      budgets: { approvedFor: async () => undefined } as never,
      ledger: finance,
      core: { getSite: async () => ({ siteId: APT, name: 'Örnek' }) as Site, listUnits: async () => units, listBlocks: async () => [] as Block[] },
      sources: { meterPeriods: async () => [], reviewPayments: zero, unmatchedBankLines: zero, pendingOffsetRequests: zero, lateFeeSettings: async () => ({ monthlyBasisPoints: 0 }) },
      store: undefined,
      now: () => NOW,
    });
    const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
    let k = 0;
    for (const m of ['10', '11']) {
      for (const u of ['u1', 'u2']) await finance.chargeUnit(ctx, { idempotencyKey: `c-${++k}`, unitId: u, liableParty: 'owner', amount: 100000, date: `2026-${m}-01`, dueDate: `2026-${m}-05`, description: 'Aidat' });
    }
    await finance.recordPayment(ctx, { idempotencyKey: `p-${++k}`, unitId: 'u1', liableParty: 'owner', amount: 150000, method: 'cash', paidAt: '2026-11-10' });

    const sources = withSources({ core, ledger: fake.repo, finance, reports });
    const ensure = vi.spyOn(fake.repo, 'ensureAccounts');
    const listAccounts = vi.spyOn(fake.repo, 'listAccounts');
    core.listUnits.mockClear();

    // Ozet onbellegi yazilamazsa sonuc yine doner (en iyi caba).
    const failingPut = vi.spyOn(fake.repo, 'putAccountSummary').mockRejectedValue(new Error('yazilamadi'));
    const c1 = { ...mgr };
    const [first] = await Promise.all([sources.finance(c1), sources.collection(c1), sources.units(c1)]);
    expect(failingPut).toHaveBeenCalled();
    // Ayni kartin bolumleri hesap ve bolum listesini paylasir.
    expect(listAccounts).toHaveBeenCalledTimes(1);
    expect(core.listUnits).toHaveBeenCalledTimes(1);
    failingPut.mockRestore();

    // Bayat ozet (onceki yazim basarisiz) bu kez geri yazilir: sonraki portfoy istegi yeniden uretmez.
    const putSummary = vi.spyOn(fake.repo, 'putAccountSummary');
    const figures = await sources.finance({ ...mgr });
    expect(putSummary).toHaveBeenCalled();
    expect(figures).toEqual(first);
    expect(ensure).not.toHaveBeenCalled();

    const dashboard = await reports.dashboard(ctx);
    const summary = await finance.summary(ctx);
    expect(figures).toEqual({
      cash: summary.cash,
      bank: summary.bank,
      totalFunds: summary.totalFunds,
      receivables: summary.receivables,
      overdue: summary.overdue,
      overdueUnitCount: summary.overdueUnitCount,
      advances: summary.advances,
      payables: summary.payables,
    });
    expect(figures).toMatchObject({ totalFunds: 150000, overdueUnitCount: 2 });
    expect(await sources.collection(mgr)).toEqual(dashboard.thisMonth);
    expect(dashboard.thisMonth).toEqual({ period: '2026-11', charged: 200000, collected: 150000, collectionRatePct: 75 });
    expect(await sources.units(mgr)).toEqual({ count: 2 });
  });

  it('talepler: pano ile ayni acik / SLA sayilari, icerik yok', async () => {
    let now = new Date('2026-11-20T09:00:00.000Z');
    const fake = createFakeTicketRepo();
    const site = { siteId: APT, settings: { ...defaultSiteSettings(), tickets: DEFAULT_TICKET_SETTINGS } } as unknown as Site;
    let n = 0;
    const tickets = createTicketService({
      repo: fake.repo,
      core: { getSite: async () => site, getUnit: async () => ({ unitId: 'u1', blockId: 'b1', status: 'active' }) as Unit, getBlock: async () => ({ blockId: 'b1', status: 'active' }) as Block },
      memberships: { listMemberships: async () => [] },
      roles: { list: async () => [] },
      now: () => now,
      newId: () => `id${String(++n).padStart(6, '0')}`,
    });
    let k = 0;
    const open = (priority: string) =>
      tickets.create(mgr, { idempotencyKey: `t-${++k}`, title: 'Asansör arızalı', description: 'Asansör katlar arasında kaldı.', category: 'elevator', priority, location: { kind: 'common', area: 'A Blok' } });
    await open('urgent');
    await open('high');
    await open('normal');
    const resolved = await open('low');
    await tickets.transition(mgr, resolved.ticket.ticketId, { version: resolved.ticket.version, action: 'resolve', note: 'Tamam' });
    now = new Date('2026-11-25T09:00:00.000Z'); // acil / yuksek SLA asildi
    const board = await tickets.board(mgr);
    const sources = withSources({ tickets });
    const list = vi.spyOn(fake.repo, 'list');
    const stats = await sources.tickets(mgr);
    // Durum indeksi yok: panodaki gibi tum talepler, sayi icin eventually consistent okuma.
    expect(list).toHaveBeenCalledWith(APT, { consistent: false });
    const active = board.columns.filter((c) => c.status !== 'resolved').reduce((s, c) => s + c.count, 0);
    expect(stats.openCount).toBe(active);
    expect(stats.overdueCount).toBe(board.overdueCount);
    expect(stats.openByPriority.urgent).toBe(board.urgentOpenCount);
    expect(stats).toMatchObject({ openCount: 3, openByPriority: { urgent: 1, high: 1, normal: 1, low: 0 } });
    expect(stats.overdueCount).toBeGreaterThan(0);
    expect(await sources.tickets(obs)).toEqual(stats);
    expect(JSON.stringify(stats)).not.toContain('Asansör');
  });

  it('bakim: Genel Bakis ile ayni geciken sayisi (90 gunluk gorev listesi) + 7 gun icinde son gunu gelenler', async () => {
    const fake = createFakeMaintenanceRepo();
    const task = (dueDate: string, status: MaintenanceTask['status'], templateId = 'tpl1') =>
      fake.items.set(`MTASK#${dueDate}#${templateId}`, { PK: `APT#${APT}`, SK: `MTASK#${dueDate}#${templateId}`, entityType: 'MAINT_TASK', apartmentId: APT, templateId, dueDate, status, name: 'Asansör bakımı', version: 1 } as unknown as MaintenanceTask);
    task('2025-10-01', 'scheduled'); // 1 yildan eski
    task('2026-08-01', 'scheduled'); // 90 gun disi: Genel Bakis da saymaz (takvim sayar)
    task('2026-10-01', 'scheduled');
    task('2026-11-20', 'in_progress');
    task('2026-11-21', 'done');
    task('2026-11-25', 'scheduled');
    task('2026-12-01', 'scheduled');
    task('2026-12-02', 'scheduled'); // 7 gun disi
    task('2026-11-28', 'cancelled');
    const site = { siteId: APT, settings: defaultSiteSettings() } as unknown as Site;
    const tickets = createTicketService({ repo: createFakeTicketRepo().repo, core: { getSite: async () => site, getUnit: async () => undefined, getBlock: async () => undefined }, memberships: { listMemberships: async () => [] }, roles: { list: async () => [] }, now: () => NOW });
    const maintenance = createMaintenanceService({ repo: fake.repo, tickets, roles: { list: async () => [] }, now: () => NOW });
    const sources = withSources({ maintenance });
    const stats = await sources.maintenance(mgr);
    // Genel Bakis'in "geciken bakim" kaynagi: GET /tasks?status=open&overdue=true (varsayilan pencere).
    const dashboardOverdue = (await maintenance.listTasks(mgr, { status: 'open', overdue: 'true' })).items.length;
    expect(stats.overdueCount).toBe(dashboardOverdue);
    expect(stats).toEqual({ overdueCount: 2, dueThisWeekCount: 2 });
    expect(await sources.maintenance(obs)).toEqual(stats);
  });

  it('ekipman: son tarih listesiyle ayni 30 gunluk pencere', async () => {
    const eq = (id: string, extra: Partial<Equipment>) => ({ equipmentId: id, apartmentId: APT, name: id, status: 'active', ...extra }) as Equipment;
    const list = [
      eq('e1', { warrantyEndDate: '2026-12-10' }),
      eq('e2', { serviceContractEndDate: '2026-12-20', nextInspectionDate: '2026-11-30' }),
      eq('e3', { nextInspectionDate: '2026-10-01' }), // dolmus kontrol
      eq('e4', { warrantyEndDate: '2027-06-01' }), // pencere disi
      eq('e5', { warrantyEndDate: '2026-12-01', status: 'retired' }),
    ];
    const equipment = createEquipmentService({ repo: { list: async () => list } as unknown as EquipmentRepository, store: undefined, now: () => NOW });
    const sources = withSources({ equipment });
    const expiring = await equipment.expiring(mgr, { days: '30' });
    expect(equipmentFigures((await sources.equipment(mgr)).items)).toEqual(equipmentFigures(expiring.items));
    expect(equipmentFigures(expiring.items)).toEqual({ expiringCount: 3, expiringByKind: { warranty: 1, contract: 1, inspection: 1 }, expiredCount: 1 });
  });

  it('ihale: denetci yalnizca paylasilan ihaleleri sayar (ihale servisinin kendi kurali)', async () => {
    const fake = createFakeTenderRepo();
    let n = 0;
    const tenders = createTenderService({
      repo: fake.repo,
      documents: { promote: async () => { throw new Error('yok'); }, sign: async () => { throw new Error('yok'); } } as never,
      tickets: { get: async () => undefined },
      memberships: { listMemberships: async () => [] },
      now: () => NOW,
      newId: () => String(++n).padStart(10, '0'),
    });
    await tenders.create(mgr, { idempotencyKey: 'tender-key-1', title: 'Dış cephe mantolama', description: 'A ve B blok dış cephe', category: 'mantolama', deadline: '2026-12-15' });
    const sources = withSources({ tenders });
    expect(tenderFigures((await sources.tenders(mgr)).items)).toEqual({ openCount: 1 });
    expect(tenderFigures((await sources.tenders(obs)).items)).toEqual({ openCount: 0 });
  });
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

describe('GET /api/portfolio', () => {
  const gsi = [role('apt-1', 'management_company'), role('apt-2', 'observer')];
  const make = (opts: Parameters<typeof createApp>[0] extends infer C ? Partial<C> : never = {}) => {
    const { repo } = fakeRepo({ gsi, names: { 'apt-1': 'Lale', 'apt-2': 'Gül' } });
    const list = vi.fn();
    const service = createPortfolioService({ repo, sources: fakeSources(), now: () => NOW, log: silent });
    const spied = { ...service, list: (...args: Parameters<typeof service.list>) => (list(...args), service.list(...args)) };
    const app = createApp({
      version: 'test',
      portfolioService: spied,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
      ...opts,
    });
    const get = (claims: Partial<AuthClaims> | null, path = '/api/portfolio', headers: Record<string, string> = {}) =>
      app.request(path, { headers: { ...(claims ? { 'x-test-claims': JSON.stringify({ userId: USER, apartmentId: 'apt-1', ...claims }) } : {}), ...headers } });
    return { app, get, list };
  };

  it('kimliksiz 401; portfoy disi roller ve platform yoneticisi 403', async () => {
    const { get, list } = make();
    expect((await get(null)).status).toBe(401);
    for (const r of ['resident', 'building_staff', 'security_guard', 'platform_admin'] as const) {
      const res = await get({ role: r });
      expect(res.status).toBe(403);
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('destek oturumu (platform yoneticisi -> denetci claim) portfoy acamaz', async () => {
    const { get, list } = make();
    const res = await get({ role: 'observer', apartmentId: 'apt-2', supportSessionId: 'sup-1' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'forbidden' });
    expect(list).not.toHaveBeenCalled();
  });

  it('zorunlu MFA kurulmamissa 403 MFA_REQUIRED', async () => {
    const { get } = make({ mfaPolicy: { mode: 'enforce', graceDays: 7 } });
    const res = await get({ role: 'management_company' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'MFA_REQUIRED' });
    expect((await get({ role: 'management_company', mfaEnabled: true })).status).toBe(200);
  });

  it('liste token apartmanindan bagimsizdir; istemcinin apartman parametresi yok sayilir', async () => {
    const { get, list } = make();
    const res = await get({ role: 'observer', apartmentId: 'apt-2' }, '/api/portfolio?apartmentId=apt-9&userId=other');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { apartmentId: string; role: string }[] };
    expect(body.items.map((c) => [c.apartmentId, c.role])).toEqual([
      ['apt-2', 'observer'],
      ['apt-1', 'management_company'],
    ]);
    expect(list).toHaveBeenCalledWith({ userId: USER }, { limit: undefined, cursor: undefined }, { deadline: expect.any(Number) });
  });

  it('kullaniciya ozel onbellek: ETag ile 304; gecersiz limit 400', async () => {
    const { get } = make();
    const res = await get({ role: 'management_company' });
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('vary')).toMatch(/authorization/i);
    const tag = res.headers.get('etag');
    expect(tag).toBeTruthy();
    const again = await get({ role: 'management_company' }, '/api/portfolio', { 'if-none-match': tag as string });
    expect(again.status).toBe(304);
    const bad = await get({ role: 'management_company' }, '/api/portfolio?limit=500');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'validation_error', field: 'limit' });
  });

  it('son tarih Lambda kalan suresinden: yavas kaynakla kismi kartlar butce icinde doner (gercek saat)', async () => {
    const { repo } = fakeRepo({ gsi: [role('apt-1', 'management_company'), role('apt-2', 'observer')], names: { 'apt-1': 'Lale', 'apt-2': 'Gül' } });
    const service = createPortfolioService({ repo, sources: fakeSources({ hang: { 'apt-1': ['collection', 'finance'] } }), now: () => NOW, log: silent });
    const app = createApp({ version: 'test', portfolioService: service, authenticate: () => ({ userId: USER, role: 'management_company', apartmentId: 'apt-1' }) as AuthClaims });
    const started = Date.now();
    // Kalan 2,8 sn - 2,5 sn pay = 300 ms butce (API Lambda zaman asimi 15 sn; sabit 22 sn degil).
    const res = await app.request('/api/portfolio', {}, { lambdaContext: { getRemainingTimeInMillis: () => LAMBDA_MARGIN_MS + 300 } });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(1_500);
    const body = (await res.json()) as { items: { apartmentId: string; status: string; failed: string[] }[] };
    expect(body.items.find((c) => c.apartmentId === 'apt-1')).toMatchObject({ status: 'partial', failed: ['finance', 'collection'] });
    expect(body.items.find((c) => c.apartmentId === 'apt-2')).toMatchObject({ status: 'ok' });

    // Kalan sure payin altindaysa hic apartman okunmaz, yanit hemen doner.
    const quick = await app.request('/api/portfolio', {}, { lambdaContext: { getRemainingTimeInMillis: () => 1_000 } });
    expect(((await quick.json()) as { items: { status: string }[] }).items.every((c) => c.status === 'error')).toBe(true);
  });

  it('requestDeadline: Lambda varsa kalan sure - pay, yoksa sabit butce', () => {
    expect(requestDeadline({ lambdaContext: { getRemainingTimeInMillis: () => 12_000 } }, 1_000)).toBe(1_000 + 12_000 - LAMBDA_MARGIN_MS);
    expect(requestDeadline({ lambdaContext: { getRemainingTimeInMillis: () => 100 } }, 1_000)).toBe(1_000);
    expect(requestDeadline(undefined, 1_000)).toBe(1_000 + FALLBACK_BUDGET_MS);
    expect(requestDeadline({}, 1_000)).toBe(1_000 + FALLBACK_BUDGET_MS);
  });
});

// ---------------------------------------------------------------------------
// BatchGet: islenemeyen anahtarlar
// ---------------------------------------------------------------------------

describe('portfoy deposu BatchGet', () => {
  const keyOf = (input: unknown) => ((input as { RequestItems: Record<string, { Keys: Record<string, string>[] }> }).RequestItems.t?.Keys ?? []);
  const setup = (respond: (keys: Record<string, string>[], call: number) => { found: Record<string, string>[]; unprocessed: Record<string, string>[] }) => {
    let call = 0;
    const sleeps: number[] = [];
    const log = vi.fn();
    const client = {
      send: vi.fn(async (cmd: { input: unknown }) => {
        const keys = keyOf(cmd.input);
        const { found, unprocessed } = respond(keys, call++);
        return { Responses: { t: found }, ...(unprocessed.length ? { UnprocessedKeys: { t: { Keys: unprocessed } } } : {}) };
      }),
    };
    const repo = createPortfolioRepository({ dynamo: () => ({ client: client as never, tableName: 't' }), sleep: async (ms) => void sleeps.push(ms), random: () => 0.5, log, grantItems: async () => [] });
    return { repo, client, sleeps, log };
  };
  const site = (k: Record<string, string>) => ({ siteId: k.PK?.replace('APT#', '') ?? '', name: `Ad ${k.PK}` });

  it('islenemeyen anahtar ustel bekleme + jitter ile yeniden istenir', async () => {
    const { repo, sleeps } = setup((keys, call) => (call < 2 ? { found: keys.slice(0, 1).map(site), unprocessed: keys.slice(1) } : { found: keys.map(site), unprocessed: [] }));
    const names = await repo.siteNames(['a', 'b', 'c']);
    expect([...names.keys()].sort()).toEqual(['a', 'b', 'c']);
    expect(sleeps).toEqual([50 + 25, 100 + 50]);
  });

  it('yine kalirsa sessizce dusurulmez: 503 ve gunluk satiri', async () => {
    const { repo, client, sleeps, log } = setup((keys) => ({ found: [], unprocessed: keys }));
    const err = await repo.roleRecords(USER, [{ apartmentId: 'a', role: 'apartment_manager' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DataAccessError);
    expect((err as DataAccessError).httpStatus).toBe(503);
    expect(client.send).toHaveBeenCalledTimes(5);
    expect(sleeps).toEqual([75, 150, 300, 600]);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ msg: 'portfolio_batch_get_unprocessed', purpose: 'roles', unprocessed: 1 }));
  });
});
