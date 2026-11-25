/**
 * Finans 2.4-4 - Butce / yillik isletme projesi: taslak, duzenleme, onay (karar referansiyla),
 * aidat onizlemesi ve aylik aidat planina uygulama.
 *
 * Kurallar (plan: claude/finans-2-4-donem-kapanisi-butce-plani.md):
 *  - Yil icinde surumler `revision` ile artar; ayni anda yalnizca bir taslak olabilir.
 *  - Onayli surum degismez; yeni onay oncekini `superseded` yapar (tek atomik yazim + denetim).
 *  - Satirlar aylik kurus dizisi (12) ya da yillik tutar (`annual`; aylara esit, en buyuk kalan).
 *  - Aidat: butcedeki aidat gelir satirinin (dues.incomeAccountId, varsayilan income-dues) ayi.
 *    Onizleme mevcut toplu tahakkuk onizlemesini (dagitim anahtari, muafiyet, bos daire) kullanir.
 */
import type { CoreService } from '../core/service.js';
import type { IsoDate, LiableParty } from '../core/types.js';
import { toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqEnum, reqInt, reqString } from '../core/validation.js';
import {
  type Budget,
  BudgetConflictError,
  type BudgetLine,
  type BudgetRepository,
  budgetKeys,
  budgetRepository,
} from './budgetModel.js';
import { DUES_DISTRIBUTION_KEYS, FinanceError, type FinanceService, MAX_AMOUNT, SYSTEM_ACCOUNTS } from './service.js';

export type BudgetContext = { apartmentId: string; userId: string };

export type BudgetServiceDeps = {
  repo: BudgetRepository;
  finance: Pick<FinanceService, 'listAccounts' | 'previewBulk' | 'resolveIncomeAccount'>;
  core: Pick<CoreService, 'getSite' | 'updateSite'>;
  now: () => Date;
};

const LIABLE_PARTIES = ['occupant', 'owner'] as const satisfies readonly LiableParty[];
const MAX_LINES = 200;
const MONTHS_IN_YEAR = 12;

/** Yillik tutari 12 aya boler; kalan kuruslar ilk aylara (en buyuk kalan). */
export function splitAnnual(annual: number): number[] {
  const base = Math.floor(annual / MONTHS_IN_YEAR);
  const rest = annual - base * MONTHS_IN_YEAR;
  return Array.from({ length: MONTHS_IN_YEAR }, (_, i) => base + (i < rest ? 1 : 0));
}

const sum = (xs: readonly number[]) => xs.reduce((s, v) => s + v, 0);

export function budgetTotals(lines: readonly BudgetLine[]) {
  const income = sum(lines.filter((l) => l.kind === 'income').map((l) => sum(l.months)));
  const expense = sum(lines.filter((l) => l.kind === 'expense').map((l) => sum(l.months)));
  return { income, expense, result: income - expense };
}

const budgetIdOf = (year: number, revision: number) => `${year}-r${revision}`;
function parseBudgetId(value: unknown): { year: number; revision: number } {
  const id = assertId(value, 'budgetId');
  const m = /^(\d{4})-r(\d{1,3})$/.exec(id);
  if (!m) throw new FinanceError('not_found', 'Bütçe bulunamadı');
  return { year: Number(m[1]), revision: Number(m[2]) };
}

export function createBudgetService(overrides: Partial<BudgetServiceDeps> & Pick<BudgetServiceDeps, 'finance' | 'core'>) {
  const deps: BudgetServiceDeps = { repo: budgetRepository, now: () => new Date(), ...overrides };
  const ts = () => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  function view(b: Budget) {
    const { PK: _pk, SK: _sk, ...rest } = b;
    return { ...rest, totals: budgetTotals(b.lines) };
  }

  async function load(ctx: BudgetContext, budgetId: string): Promise<Budget> {
    const { year, revision } = parseBudgetId(budgetId);
    const found = (await deps.repo.list(ctx.apartmentId, year)).find((b) => b.revision === revision);
    if (!found || found.status === 'discarded') throw new FinanceError('not_found', 'Bütçe bulunamadı');
    return found;
  }

  async function write(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      if (err instanceof BudgetConflictError) throw new FinanceError('conflict', err.message);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Girdi dogrulama
  // -------------------------------------------------------------------------

  function parseYear(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 2000 || value > 2100) throw new ValidationError('year 2000-2100 arasinda olmali', 'year');
    return value;
  }

  async function parseLines(ctx: BudgetContext, value: unknown): Promise<BudgetLine[]> {
    if (!Array.isArray(value)) throw new ValidationError('lines bir dizi olmali', 'lines');
    if (value.length > MAX_LINES) throw new ValidationError(`En fazla ${MAX_LINES} bütçe kalemi`, 'lines');
    const accounts = new Map((await deps.finance.listAccounts(ctx)).map((a) => [a.accountId, a]));
    const seen = new Set<string>();
    return value.map((raw, i) => {
      const field = `lines[${i}]`;
      const o = asObject(raw, field);
      const accountId = assertId(o.accountId, `${field}.accountId`);
      const acc = accounts.get(accountId);
      if (!acc || (acc.type !== 'income' && acc.type !== 'expense')) throw new ValidationError(`${field}.accountId bir gelir veya gider hesabı olmalı`, `${field}.accountId`);
      if (acc.status !== 'active') throw new ValidationError(`${field}: "${acc.name}" pasif bir hesap`, `${field}.accountId`);
      if (seen.has(accountId)) throw new ValidationError(`${field}: "${acc.name}" bütçede birden fazla kez geçiyor`, `${field}.accountId`);
      seen.add(accountId);
      let months: number[];
      if (o.months !== undefined) {
        if (!Array.isArray(o.months) || o.months.length !== MONTHS_IN_YEAR) throw new ValidationError(`${field}.months 12 aylık tutar olmalı`, `${field}.months`);
        months = o.months.map((v, m) => {
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_AMOUNT) throw new ValidationError(`${field}.months[${m}] kuruş cinsinden 0 veya pozitif tam sayı olmalı`, `${field}.months`);
          return v;
        });
      } else if (o.annual !== undefined) {
        months = splitAnnual(reqInt(o, 'annual', 0, MAX_AMOUNT));
      } else {
        throw new ValidationError(`${field}: months veya annual gerekli`, field);
      }
      const note = optString(o, 'note', 200);
      return { accountId, kind: acc.type, months: months.map(toKurus), ...(note ? { note } : {}) };
    });
  }

  async function parseDues(ctx: BudgetContext, value: unknown): Promise<Budget['dues']> {
    if (value === null || value === undefined) return undefined;
    const o = asObject(value, 'dues');
    const incomeAccountId = await deps.finance.resolveIncomeAccount(ctx, o.incomeAccountId, 'dues.incomeAccountId');
    return {
      distributionKey: reqEnum(o, 'distributionKey', DUES_DISTRIBUTION_KEYS),
      liableParty: reqEnum(o, 'liableParty', LIABLE_PARTIES),
      ...(incomeAccountId !== SYSTEM_ACCOUNTS.incomeDues ? { incomeAccountId } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Okuma
  // -------------------------------------------------------------------------

  async function list(ctx: BudgetContext, q: { year?: string } = {}) {
    let year: number | undefined;
    if (q.year !== undefined && q.year !== '') year = parseYear(Number(q.year));
    return { items: (await deps.repo.list(ctx.apartmentId, year)).filter((b) => b.status !== 'discarded').map(view) };
  }

  async function get(ctx: BudgetContext, budgetId: string) {
    return view(await load(ctx, budgetId));
  }

  // -------------------------------------------------------------------------
  // Yazim
  // -------------------------------------------------------------------------

  /** Yeni taslak: bos, verilen satirlarla ya da baska bir butceden (`copyFrom`) kopya. */
  async function create(ctx: BudgetContext, body: unknown) {
    const o = asObject(body);
    const year = parseYear(o.year);
    const existing = await deps.repo.list(ctx.apartmentId, year);
    const draft = existing.find((b) => b.status === 'draft');
    if (draft) throw new FinanceError('conflict', `${year} için zaten bir taslak var (r${draft.revision}); onu düzenleyin`);
    const source = o.copyFrom === undefined ? undefined : await load(ctx, assertId(o.copyFrom, 'copyFrom'));
    const lines = o.lines !== undefined ? await parseLines(ctx, o.lines) : (source?.lines ?? []);
    const dues = o.dues !== undefined ? await parseDues(ctx, o.dues) : source?.dues;
    const revision = Math.max(0, ...existing.map((b) => b.revision)) + 1;
    const now = ts();
    const title = optString(o, 'title', 120);
    const budget: Budget = {
      ...budgetKeys.budget(ctx.apartmentId, year, revision),
      entityType: 'BUDGET',
      apartmentId: ctx.apartmentId,
      budgetId: budgetIdOf(year, revision),
      year,
      revision,
      status: 'draft',
      ...(title ? { title } : {}),
      lines,
      ...(dues ? { dues } : {}),
      createdAt: now,
      createdBy: ctx.userId,
      updatedAt: now,
      updatedBy: ctx.userId,
      version: 1,
    };
    await write(() =>
      deps.repo.write(ctx.apartmentId, {
        puts: [{ budget, expectedVersion: 0 }],
        audit: { apartmentId: ctx.apartmentId, action: 'finance.budget_create', target: { type: 'budget', id: budget.budgetId }, actorId: ctx.userId, details: { year, revision, ...(source ? { copyFrom: source.budgetId } : {}) } },
      }),
    );
    return view(budget);
  }

  async function update(ctx: BudgetContext, budgetId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await load(ctx, budgetId);
    if (current.status !== 'draft') throw new FinanceError('unprocessable', 'Onaylı bütçe değiştirilemez; yeni bir revizyon açın');
    if (current.version !== version) throw new FinanceError('conflict', 'Bütçe başka bir işlemle değişti; sayfayı yenileyin');
    const title = o.title === null ? undefined : o.title === undefined ? current.title : optString(o, 'title', 120);
    const lines = o.lines === undefined ? current.lines : await parseLines(ctx, o.lines);
    const dues = o.dues === undefined ? current.dues : await parseDues(ctx, o.dues);
    const { title: _t, dues: _d, ...base } = current;
    const updated: Budget = {
      ...base,
      ...(title ? { title } : {}),
      lines,
      ...(dues ? { dues } : {}),
      updatedAt: ts(),
      updatedBy: ctx.userId,
      version: version + 1,
    };
    await write(() => deps.repo.write(ctx.apartmentId, { puts: [{ budget: updated, expectedVersion: version }] }));
    return view(updated);
  }

  /**
   * Taslagi siler. Kayit fiziksel olarak silinmez (API'nin DeleteItem yetkisi yok, proje kurali):
   * `discarded` durumuna alinir; listelerde ve okumada gorunmez, revizyon numarasi tekrar kullanilmaz.
   */
  async function remove(ctx: BudgetContext, budgetId: string, body: unknown) {
    const version = reqInt(asObject(body), 'version', 1, Number.MAX_SAFE_INTEGER);
    const current = await load(ctx, budgetId);
    if (current.status !== 'draft') throw new FinanceError('unprocessable', 'Yalnızca taslak bütçe silinebilir');
    if (current.version !== version) throw new FinanceError('conflict', 'Bütçe başka bir işlemle değişti; sayfayı yenileyin');
    const discarded: Budget = { ...current, status: 'discarded', updatedAt: ts(), updatedBy: ctx.userId, version: version + 1 };
    await write(() =>
      deps.repo.write(ctx.apartmentId, {
        puts: [{ budget: discarded, expectedVersion: version }],
        audit: { apartmentId: ctx.apartmentId, action: 'finance.budget_delete', target: { type: 'budget', id: budgetId }, actorId: ctx.userId },
      }),
    );
    return { deleted: true };
  }

  /** Taslagi onaylar (genel kurul / yonetim kurulu karari); yilin onceki onayli surumu `superseded`. */
  async function approve(ctx: BudgetContext, budgetId: string, body: unknown) {
    const o = asObject(body);
    const version = reqInt(o, 'version', 1, Number.MAX_SAFE_INTEGER);
    const decisionRef = reqString(o, 'decisionRef', 60);
    const decisionDate = reqString(o, 'decisionDate', 10);
    if (!isIsoDate(decisionDate)) throw new ValidationError('decisionDate YYYY-MM-DD olmali', 'decisionDate');
    if (decisionDate > today()) throw new ValidationError('Karar tarihi gelecekte olamaz', 'decisionDate');
    const current = await load(ctx, budgetId);
    if (current.status !== 'draft') throw new FinanceError('unprocessable', 'Yalnızca taslak bütçe onaylanabilir');
    if (current.version !== version) throw new FinanceError('conflict', 'Bütçe başka bir işlemle değişti; sayfayı yenileyin');
    if (!current.lines.length) throw new FinanceError('unprocessable', 'Boş bütçe onaylanamaz');
    const now = ts();
    const previous = (await deps.repo.list(ctx.apartmentId, current.year)).find((b) => b.status === 'approved');
    const approved: Budget = {
      ...current,
      status: 'approved',
      decision: { ref: decisionRef, date: decisionDate },
      approvedAt: now,
      approvedBy: ctx.userId,
      updatedAt: now,
      updatedBy: ctx.userId,
      version: version + 1,
    };
    const puts = [{ budget: approved, expectedVersion: version }];
    if (previous) puts.push({ budget: { ...previous, status: 'superseded', updatedAt: now, updatedBy: ctx.userId, version: previous.version + 1 }, expectedVersion: previous.version });
    const totals = budgetTotals(approved.lines);
    await write(() =>
      deps.repo.write(ctx.apartmentId, {
        puts,
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.budget_approve',
          target: { type: 'budget', id: budgetId },
          actorId: ctx.userId,
          details: { year: approved.year, revision: approved.revision, decision: approved.decision, totals, ...(previous ? { supersedes: previous.budgetId } : {}) },
        },
      }),
    );
    return { budget: view(approved), ...(previous ? { superseded: previous.budgetId } : {}) };
  }

  // -------------------------------------------------------------------------
  // Aidat
  // -------------------------------------------------------------------------

  function duesFigures(b: Budget, monthValue: unknown) {
    if (!b.dues) throw new FinanceError('unprocessable', 'Bütçede aidat ayarı (dağıtım anahtarı, sorumlu taraf) yok');
    const now = today();
    let month: string;
    if (monthValue === undefined || monthValue === '') month = now.startsWith(`${b.year}-`) ? now.slice(0, 7) : `${b.year}-01`;
    else if (typeof monthValue === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(monthValue) && monthValue.startsWith(`${b.year}-`)) month = monthValue;
    else throw new ValidationError(`month ${b.year} yılından YYYY-MM olmalı`, 'month');
    const incomeAccountId = b.dues.incomeAccountId ?? SYSTEM_ACCOUNTS.incomeDues;
    const duesLine = b.lines.find((l) => l.kind === 'income' && l.accountId === incomeAccountId);
    const amount = duesLine?.months[Number(month.slice(5, 7)) - 1] ?? 0;
    const totals = budgetTotals(b.lines);
    const otherIncome = totals.income - sum(duesLine?.months ?? []);
    const neededAnnual = Math.max(totals.expense - otherIncome, 0);
    const uneven = duesLine ? new Set(duesLine.months).size > 1 : false;
    return {
      month,
      incomeAccountId,
      amount,
      uneven,
      balance: { ...totals, otherIncome, duesAnnual: sum(duesLine?.months ?? []), suggestedMonthlyDues: splitAnnual(neededAnnual) },
    };
  }

  /** Butceden aylik aidat: daire basina dagilim (toplu tahakkuk onizlemesiyle ayni kurallar). */
  async function duesPreview(ctx: BudgetContext, budgetId: string, q: { month?: string } = {}) {
    const b = await load(ctx, budgetId);
    const f = duesFigures(b, q.month);
    const dues = b.dues as NonNullable<Budget['dues']>;
    const site = await deps.core.getSite(ctx.apartmentId);
    const dueDate = `${f.month}-${String(site.settings.dueDayOfMonth ?? 1).padStart(2, '0')}`;
    const preview =
      f.amount > 0
        ? await deps.finance.previewBulk(ctx, {
            liableParty: dues.liableParty,
            totalAmount: f.amount,
            distributionKey: dues.distributionKey,
            date: `${f.month}-01`,
            dueDate,
            description: `Aidat ${f.month}`,
            incomeAccountId: f.incomeAccountId,
          })
        : null;
    return { budgetId, status: b.status, ...f, dues, preview };
  }

  /** Onayli butcenin aidat tutarini aylik aidat planina yazar (site ayarlari, surum kosullu). */
  async function applyDuesPlan(ctx: BudgetContext, budgetId: string, body: unknown) {
    const o = asObject(body);
    const siteVersion = reqInt(o, 'siteVersion', 1, Number.MAX_SAFE_INTEGER);
    const b = await load(ctx, budgetId);
    if (b.status !== 'approved') throw new FinanceError('unprocessable', 'Yalnızca onaylı bütçe aidat planına uygulanabilir');
    const f = duesFigures(b, o.month);
    if (f.amount <= 0) throw new FinanceError('unprocessable', `Bütçede ${f.month} için aidat geliri yok`);
    const dues = b.dues as NonNullable<Budget['dues']>;
    const plan = {
      enabled: true,
      totalAmount: f.amount,
      distributionKey: dues.distributionKey,
      liableParty: dues.liableParty,
      incomeAccountId: f.incomeAccountId,
      budgetId,
    };
    const site = await deps.core.updateSite(ctx.userId, ctx.apartmentId, { version: siteVersion, settings: { monthlyDuesPlan: plan } });
    const warnings: { code: string; message: string }[] = [];
    if (f.uneven) warnings.push({ code: 'uneven_months', message: 'Bütçede aidat tutarı aydan aya değişiyor; plan seçilen ayın tutarıyla sabitlendi' });
    if (f.balance.duesAnnual < f.balance.expense - f.balance.otherIncome) {
      warnings.push({ code: 'budget_deficit', message: 'Bütçelenen aidat geliri, giderleri karşılamıyor' });
    }
    return { plan: site.settings.monthlyDuesPlan, siteVersion: site.version, month: f.month, warnings };
  }

  return { list, get, create, update, remove, approve, duesPreview, applyDuesPlan };
}

export type BudgetService = ReturnType<typeof createBudgetService>;
