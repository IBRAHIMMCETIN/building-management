/**
 * Finans 2.4-4: butce / yillik isletme projesi (taslak, revizyon, onay, silme), butceden aidat
 * onizlemesi, aylik aidat planina uygulama ve ayarlarda aidat plani gelir hesabi dogrulamasi.
 */
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import type { AuditDraft } from '../src/modules/audit/log.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { CoreError, createCoreService, defaultSiteSettings } from '../src/modules/core/service.js';
import type { Site, Unit } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { type Budget, BudgetConflictError, type BudgetRepository } from '../src/modules/finance/budgetModel.js';
import { createBudgetService, splitAnnual } from '../src/modules/finance/budgets.js';
import { FinanceError, type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-1';
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
const NOW = '2026-11-25T09:00:00.000Z';

function unit(id: string, area: number): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: area,
    exemptions: [],
    status: 'active',
    createdAt: NOW,
    createdBy: 'seed',
    updatedAt: NOW,
    updatedBy: 'seed',
    version: 1,
  } as Unit;
}

function createFakeBudgetRepo() {
  const docs = new Map<string, Budget>();
  const audits: AuditDraft[] = [];
  const versionOf = (b: Budget) => docs.get(b.SK)?.version ?? 0;
  const repo: BudgetRepository = {
    async list(apt, year) {
      return [...docs.values()]
        .filter((b) => b.apartmentId === apt && (year === undefined || b.year === year))
        .map((b) => structuredClone(b))
        .sort((a, b) => b.year - a.year || b.revision - a.revision);
    },
    async approvedFor(apt, year) {
      return (await repo.list(apt, year)).find((b) => b.status === 'approved');
    },
    async write(_apt, w) {
      for (const p of w.puts) if (versionOf(p.budget) !== p.expectedVersion) throw new BudgetConflictError();
      for (const p of w.puts) docs.set(p.budget.SK, structuredClone(p.budget));
      if (w.audit) audits.push(w.audit);
    },
  };
  return { repo, docs, audits };
}

function world() {
  const now = new Date(NOW);
  const fake = createFakeFinanceRepo(APT);
  const units = [unit('u1', 1000), unit('u2', 1000)];
  let site: Site = {
    PK: `APT#${APT}`,
    SK: 'SITE',
    entityType: 'SITE',
    status: 'active',
    siteId: APT,
    tenantId: 't1',
    name: 'Hamravat',
    type: 'site',
    address: { line1: 'x', district: 'y', city: 'z' },
    fiscalYearStartMonth: 1,
    settings: { ...defaultSiteSettings(), dueDayOfMonth: 10 },
    createdAt: NOW,
    createdBy: 'seed',
    updatedAt: NOW,
    updatedBy: 'seed',
    version: 1,
  } as Site;
  const coreRepo = {
    getSite: async () => structuredClone(site),
    updateSite: async (s: Site, expected: number) => {
      if (site.version !== expected) throw new CoreError('conflict', 'Kayit baska bir istekle degisti');
      site = structuredClone(s);
    },
    listUnits: async () => units,
    getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id),
  } as unknown as CoreRepository;
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core: coreRepo, now: () => now, newId: () => `id${String(++n).padStart(4, '0')}` });
  const core = createCoreService({
    repository: coreRepo,
    now: () => now,
    validateIncomeAccount: async (apartmentId, actor, accountId) => {
      await finance.resolveIncomeAccount({ apartmentId, userId: actor }, accountId, 'monthlyDuesPlan.incomeAccountId');
    },
  });
  const budgets = createFakeBudgetRepo();
  const service = createBudgetService({ repo: budgets.repo, finance, core, now: () => now });
  return { finance, core, service, budgets, site: () => site };
}

const DUES = { distributionKey: 'equal', liableParty: 'owner' } as const;
const LINES = [
  { accountId: 'income-dues', annual: 2_400_000 },
  { accountId: 'exp-cleaning', annual: 1_200_000 },
  { accountId: 'exp-elevator', months: [100000, 0, 0, 100000, 0, 0, 100000, 0, 0, 100000, 0, 0] },
];

describe('butce olusturucular (saf)', () => {
  it('yillik tutar aylara esit bolunur; kalan kuruslar ilk aylara', () => {
    const m = splitAnnual(100_005);
    expect(m.reduce((s, v) => s + v, 0)).toBe(100_005);
    expect(m.slice(0, 9)).toEqual(Array(9).fill(8334));
    expect(m.slice(9)).toEqual([8333, 8333, 8333]);
    expect(splitAnnual(0)).toEqual(Array(12).fill(0));
  });
});

describe('butce yasam dongusu', () => {
  it('taslak: satir dogrulama, yillik tutar bolme, tek taslak kurali, toplamlar', async () => {
    const w = world();
    const b = await w.service.create(ctx, { year: 2027, title: '2027 İşletme Projesi', lines: LINES, dues: DUES });
    expect(b).toMatchObject({ budgetId: '2027-r1', status: 'draft', revision: 1, version: 1, totals: { income: 2_400_000, expense: 1_600_000, result: 800_000 } });
    expect(b.lines[0]).toMatchObject({ accountId: 'income-dues', kind: 'income', months: Array(12).fill(200_000) });
    expect(w.budgets.audits.map((a) => a.action)).toEqual(['finance.budget_create']);

    await expect(w.service.create(ctx, { year: 2027 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.service.create(ctx, { year: 2028, lines: [{ accountId: 'cash', annual: 1 }] })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.create(ctx, { year: 2028, lines: [{ accountId: 'exp-cleaning', annual: 1 }, { accountId: 'exp-cleaning', annual: 2 }] })).rejects.toThrow(/birden fazla/);
    await expect(w.service.create(ctx, { year: 2028, lines: [{ accountId: 'exp-cleaning', months: [1, 2] }] })).rejects.toThrow(/12 aylık/);
    await expect(w.service.create(ctx, { year: 2028, dues: { ...DUES, incomeAccountId: 'income-late-fee' } })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.create(ctx, { year: 1990 })).rejects.toBeInstanceOf(ValidationError);
  });

  it('duzenleme surum kosullu; onayli butce degismez; onay oncekini gecersiz kilar', async () => {
    const w = world();
    const r1 = await w.service.create(ctx, { year: 2027, lines: LINES, dues: DUES });
    await expect(w.service.update(ctx, r1.budgetId, { version: 9, title: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    const edited = await w.service.update(ctx, r1.budgetId, { version: 1, title: 'Taslak', lines: LINES.slice(0, 2) });
    expect(edited).toMatchObject({ version: 2, title: 'Taslak', totals: { expense: 1_200_000 } });

    await expect(w.service.approve(ctx, r1.budgetId, { version: 2, decisionRef: 'GK-1', decisionDate: '2026-12-01' })).rejects.toThrow(/gelecekte/);
    const ok = await w.service.approve(ctx, r1.budgetId, { version: 2, decisionRef: 'GK-2026/4', decisionDate: '2026-11-20' });
    expect(ok.budget).toMatchObject({ status: 'approved', decision: { ref: 'GK-2026/4', date: '2026-11-20' }, approvedBy: 'mgr-1', version: 3 });
    await expect(w.service.update(ctx, r1.budgetId, { version: 3, title: 'y' })).rejects.toMatchObject({ code: 'unprocessable' });
    await expect(w.service.remove(ctx, r1.budgetId, { version: 3 })).rejects.toMatchObject({ code: 'unprocessable' });

    const r2 = await w.service.create(ctx, { year: 2027, copyFrom: r1.budgetId });
    expect(r2).toMatchObject({ budgetId: '2027-r2', lines: edited.lines, dues: DUES });
    const ok2 = await w.service.approve(ctx, r2.budgetId, { version: 1, decisionRef: 'GK-2026/5', decisionDate: '2026-11-25' });
    expect(ok2.superseded).toBe('2027-r1');
    expect((await w.service.get(ctx, '2027-r1')).status).toBe('superseded');
    expect((await w.budgets.repo.approvedFor(APT, 2027))?.budgetId).toBe('2027-r2');
    expect(w.budgets.audits.at(-1)).toMatchObject({ action: 'finance.budget_approve', details: { supersedes: '2027-r1', totals: { income: 2_400_000 } } });
    expect((await w.service.list(ctx, { year: '2027' })).items.map((b) => b.budgetId)).toEqual(['2027-r2', '2027-r1']);
  });

  it('bos butce onaylanamaz; taslak silinir; bilinmeyen butce 404', async () => {
    const w = world();
    const b = await w.service.create(ctx, { year: 2027 });
    await expect(w.service.approve(ctx, b.budgetId, { version: 1, decisionRef: 'K', decisionDate: '2026-11-01' })).rejects.toThrow(/Boş bütçe/);
    await expect(w.service.remove(ctx, b.budgetId, { version: 9 })).rejects.toMatchObject({ code: 'conflict' });
    expect(await w.service.remove(ctx, b.budgetId, { version: 1 })).toEqual({ deleted: true });
    // Kayit silinmez (DeleteItem yetkisi yok): `discarded` olarak kalir, listede ve okumada gorunmez;
    // yeni taslak bir sonraki revizyonu alir.
    expect([...w.budgets.docs.values()].map((d) => d.status)).toEqual(['discarded']);
    expect((await w.service.list(ctx, { year: '2027' })).items).toEqual([]);
    expect((await w.service.create(ctx, { year: 2027 })).budgetId).toBe('2027-r2');
    await expect(w.service.get(ctx, b.budgetId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.get(ctx, 'garbage')).rejects.toBeInstanceOf(FinanceError);
  });
});

describe('aidat', () => {
  it('onizleme: ayin aidat tutari daire basina dagitilir; denge ve onerilen aidat', async () => {
    const w = world();
    const b = await w.service.create(ctx, { year: 2027, lines: LINES, dues: DUES });
    const p = await w.service.duesPreview(ctx, b.budgetId, { month: '2027-03' });
    expect(p).toMatchObject({ month: '2027-03', amount: 200_000, incomeAccountId: 'income-dues', uneven: false });
    expect(p.preview?.items.map((i) => i.amount)).toEqual([100_000, 100_000]);
    expect(p.balance).toMatchObject({ income: 2_400_000, expense: 1_600_000, otherIncome: 0, duesAnnual: 2_400_000 });
    expect(p.balance.suggestedMonthlyDues.reduce((s, v) => s + v, 0)).toBe(1_600_000);
    // Yil disi ay reddedilir; belirtilmezse gelecek yil butcesi Ocak'tan baslar.
    await expect(w.service.duesPreview(ctx, b.budgetId, { month: '2026-12' })).rejects.toBeInstanceOf(ValidationError);
    expect((await w.service.duesPreview(ctx, b.budgetId)).month).toBe('2027-01');
  });

  it('aidat ayari yoksa 422; aidat satiri yoksa onizleme bos', async () => {
    const w = world();
    const noDues = await w.service.create(ctx, { year: 2027, lines: LINES });
    await expect(w.service.duesPreview(ctx, noDues.budgetId)).rejects.toMatchObject({ code: 'unprocessable' });
    await w.service.update(ctx, noDues.budgetId, { version: 1, lines: LINES.slice(1), dues: DUES });
    expect(await w.service.duesPreview(ctx, noDues.budgetId)).toMatchObject({ amount: 0, preview: null });
  });

  it('aidat planina uygula: yalnizca onayli; plan butce, gelir hesabi ve tutarla yazilir; uyarilar', async () => {
    const w = world();
    const lines = [
      { accountId: 'income-heating', months: [300_000, 300_000, 0, 0, 0, 0, 0, 0, 0, 0, 300_000, 300_000] },
      { accountId: 'exp-heating', annual: 2_000_000 },
    ];
    const b = await w.service.create(ctx, { year: 2026, lines, dues: { ...DUES, incomeAccountId: 'income-heating' } });
    await expect(w.service.applyDuesPlan(ctx, b.budgetId, { siteVersion: 1 })).rejects.toMatchObject({ code: 'unprocessable' });
    await w.service.approve(ctx, b.budgetId, { version: 1, decisionRef: 'YK-7', decisionDate: '2026-11-01' });
    await expect(w.service.applyDuesPlan(ctx, b.budgetId, { siteVersion: 1, month: '2026-05' })).rejects.toThrow(/aidat geliri yok/);

    const r = await w.service.applyDuesPlan(ctx, b.budgetId, { siteVersion: 1 });
    expect(r.month).toBe('2026-11');
    expect(r.plan).toEqual({ enabled: true, totalAmount: 300_000, distributionKey: 'equal', liableParty: 'owner', incomeAccountId: 'income-heating', budgetId: '2026-r1' });
    expect(r.siteVersion).toBe(2);
    expect(r.warnings.map((x) => x.code)).toEqual(['uneven_months', 'budget_deficit']);
    expect(w.site().settings.monthlyDuesPlan?.budgetId).toBe('2026-r1');
    await expect(w.service.applyDuesPlan(ctx, b.budgetId, { siteVersion: 1 })).rejects.toBeInstanceOf(CoreError);
  });

  it('ayarlarda aidat plani gelir hesabi aktif gelir hesabi olmali', async () => {
    const w = world();
    const plan = (incomeAccountId: string) => ({ settings: { monthlyDuesPlan: { totalAmount: 100000, distributionKey: 'equal', liableParty: 'owner', incomeAccountId } } });
    await expect(w.core.updateSite('mgr-1', APT, { version: 1, ...plan('exp-cleaning') })).rejects.toThrow(/aktif bir gelir hesabi/);
    await expect(w.core.updateSite('mgr-1', APT, { version: 1, ...plan('income-late-fee') })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.core.updateSite('mgr-1', APT, { version: 1, ...plan('nope') })).rejects.toBeInstanceOf(ValidationError);
    const ok = await w.core.updateSite('mgr-1', APT, { version: 1, ...plan('income-fixtures') });
    expect(ok.settings.monthlyDuesPlan?.incomeAccountId).toBe('income-fixtures');
    // Hesap sonradan pasiflesse bile ilgisiz ayar kaydi engellenmez (yalnizca degisen hesap dogrulanir).
    await w.finance.updateAccount(ctx, 'income-fixtures', { status: 'inactive' });
    expect((await w.core.updateSite('mgr-1', APT, { version: 2, settings: { dueDayOfMonth: 5 } })).settings.dueDayOfMonth).toBe(5);
  });
});

describe('API uclari', () => {
  it('denetci butceleri okur, olusturamaz; yonetici olusturur ve onizler', async () => {
    const w = world();
    const app = createApp({
      version: 'test',
      financeService: w.finance,
      budgetService: w.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, role: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': JSON.stringify({ userId: 'mgr-1', role, apartmentId: APT }), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    expect((await call('POST', '/api/finance/budgets', 'observer', { year: 2027 })).status).toBe(403);
    const created = await call('POST', '/api/finance/budgets', 'apartment_manager', { year: 2027, lines: LINES, dues: DUES });
    expect(created).toMatchObject({ status: 201, json: { budgetId: '2027-r1' } });
    expect((await call('GET', '/api/finance/budgets?year=2027', 'observer')).json.items).toHaveLength(1);
    expect((await call('GET', '/api/finance/budgets/2027-r1/dues-preview?month=2027-02', 'observer')).json).toMatchObject({ amount: 200_000 });
    expect((await call('PUT', '/api/finance/budgets/2027-r1', 'apartment_manager', { version: 5 })).status).toBe(409);
    expect((await call('DELETE', '/api/finance/budgets/2027-r1?version=1', 'management_company')).json).toEqual({ deleted: true });
    expect((await call('GET', '/api/finance/budgets', 'resident')).status).toBe(403);
  });
});
