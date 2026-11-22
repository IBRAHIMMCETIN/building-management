/**
 * Finans 2.2 - Borc yapilandirma / taksitlendirme (plan: claude/finans-2-2-mahsup-yapilandirma-plani.md).
 *
 * Olusturma (R = bugun, TEK atomik yazim):
 *  1. Caride R'ye kadar islemis, deftere yazilmamis kistelyevm tazminati R tarihli `late_fee` ile
 *     kesinlesir (faiz dondurma). `includeLateFees` ise bu tutar da plana alinir.
 *  2. `restructure` islemi (ayni alt caride, kendi icinde dengeli):
 *       alacak: secilen acik kalemlerin kalan tutarlari (`settles` ile hedefli kapama)
 *       borc:   taksitler (`plan.items`, kimlik `<islem>_<n>`), esit bolunmus, kurus kaybi yok
 *     Taksitin tazminat tabani (`feeBase`) yalnizca secilen kalemlerin anapara (tazminat doguran)
 *     payidir; taksitlendirilen tazminata tazminat islemez (karar 1). Vade farki yok (karar 4).
 *  3. `PLAN#<planId>` kaydi + idempotency + denetim.
 *
 * Muacceliyet (karar 2/3): ek sure (`graceDays`) gectigi halde odenmemis taksitler; ardisik
 * `consecutive` veya toplam `total` gecikmede plan temerrude duser. Gunluk zamanlayici tespit
 * edip sakine bildirir (DUES_REMINDER `plan_default`, outbox). Varsayilan: yonetici onayi ile
 * muaccel kilinir; plan `autoAccelerate` ise zamanlayici kendisi muaccel kilar. Muaccel kilma: kalan
 * taksitler hedefli kapatilir, tamami bugun vadeli TEK kalem acilir (`role: accelerate`).
 * Erken kapama (`pull_forward`): ayni islem, borclunun talebiyle, temerrut olmadan.
 *
 * Iptal: planin `restructure` islemleri ters kaydedilir; secilen kalemler eski haline doner,
 * taksitlere yapilan tahsilatlar FIFO ile o kalemlere mahsup edilir. Dondurulan tazminat yerinde
 * kalir (o gune kadar islemis gercek borctur).
 *
 * Kilit (karar 7): odenmemis plan kalemi olan caride tasinma kapamasi / mulk devri yapilamaz
 * (`openPlanIds`, closures.ts ve ownership/service.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type DomainEvent, type NewEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import { type IsoDate, type IsoDateTime, type Kurus, type LiableParty, type TableKeys, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqString } from '../core/validation.js';
import type { PortalContext, PortalService } from '../portal/service.js';
import { feeLedgerFor, unpostedLateFee } from './lateFee.js';
import { type FinanceRepository, LedgerConflictError, type ReplaceRecord, financeKeys, financeRepository } from './repository.js';
import { DEFAULT_LATE_FEE_BASIS_POINTS, FinanceError, type FinanceService, SYSTEM_ACCOUNTS, SYSTEM_ACTOR } from './service.js';
import { type AllocatedCharge, allocate, cancelledIn, linesOfAccount, openPlanIds, readSubledger, transferItemId } from './subledger.js';
import type { Account, ChargeSettlement, PlanItem, Transaction } from './types.js';

// ---------------------------------------------------------------------------
// Kayit
// ---------------------------------------------------------------------------

export type PlanRule = {
  /** Ardisik geciken taksit sayisi (temerrut). */
  consecutive: number;
  /** Toplam geciken taksit sayisi (temerrut). */
  total: number;
  /** Vadeden sonra gecikme sayilmadan once taninan ek sure (gun). */
  graceDays: number;
  /** true: zamanlayici temerrutte plani kendisi muaccel kilar; false: yonetici onayi. */
  autoAccelerate: boolean;
};

export const DEFAULT_PLAN_RULE: PlanRule = { consecutive: 2, total: 3, graceDays: 7, autoAccelerate: false };
export const MAX_INSTALLMENTS = 60;
const MAX_SELECTED = 50;

export type PlanSelectedItem = {
  chargeId: string;
  description: string;
  dueDate: IsoDate;
  /** Plana alinan (hedefli kapatilan) kalan tutar. */
  amount: Kurus;
  /** Bu tutarin tazminat doguran anapara payi. */
  feeBase: Kurus;
  lateFee: boolean;
};

export type PlanInstallment = PlanItem & { chargeId: string };

export const PLAN_STATUSES = ['active', 'accelerated', 'cancelled'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** PK = `APT#<apartmentId>`, SK = `PLAN#<planId>` */
export type InstallmentPlan = TableKeys & {
  entityType: 'INSTALLMENT_PLAN';
  planId: string;
  apartmentId: string;
  accountId: string;
  unitId: string;
  liableParty: LiableParty;
  /** Yapilandirma (dondurma) tarihi. */
  date: IsoDate;
  selected: PlanSelectedItem[];
  /** R'de kesinlesen tazminat (0 olabilir). */
  frozenLateFee: Kurus;
  includeLateFees: boolean;
  total: Kurus;
  feeBaseTotal: Kurus;
  installments: PlanInstallment[];
  rule: PlanRule;
  status: PlanStatus;
  transactionIds: { lateFee?: string; open: string; accelerate?: string };
  /** Temerrut tespiti (yonetici onayi bekleyen muacceliyet). */
  default?: { detectedAt: IsoDate; overdueNos: number[] };
  acceleration?: { at: IsoDateTime; by: string; mode: 'manual' | 'auto' | 'pull_forward'; amount: Kurus; feeBase: Kurus; transactionId: string; reason: string };
  cancellation?: { at: IsoDateTime; by: string; reason: string; transactionIds: string[] };
  reason: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const planKeys = {
  plan: (apartmentId: string, planId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('PLAN', planId) }),
};

export type PlanRepository = {
  get(apartmentId: string, planId: string): Promise<InstallmentPlan | undefined>;
  list(apartmentId: string): Promise<InstallmentPlan[]>;
};

export const planRepository: PlanRepository = {
  get: (apartmentId, planId) => getTenantItem<InstallmentPlan>(planKeys.plan(apartmentId, planId)),
  list: async (apartmentId) =>
    (await queryTenantAll<InstallmentPlan>(apartmentId, 'PLAN#', { ConsistentRead: true })).filter((p) => p.entityType === 'INSTALLMENT_PLAN'),
};

// ---------------------------------------------------------------------------
// Saf hesaplar
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
export const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/** `first` gununden itibaren `i` ay sonrasi; ay sonunu asan gun ayin son gunune cekilir. */
export function addMonths(first: IsoDate, i: number): IsoDate {
  const y = Number(first.slice(0, 4));
  const m = Number(first.slice(5, 7)) - 1 + i;
  const d = Number(first.slice(8, 10));
  const year = y + Math.floor(m / 12);
  const month = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/** `total`'i `n` parcaya kurus kaybi olmadan boler; artan kuruslar ilk parcalara. */
export function splitEven(total: number, n: number): number[] {
  const base = Math.floor(total / n);
  const extra = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Taksit tablosu (toplam ve tazminat tabani esit bolunur; taban hicbir taksitte tutari asmaz). */
export function buildInstallments(total: number, feeBaseTotal: number, n: number, firstDueDate: IsoDate, label: string): PlanItem[] {
  const amounts = splitEven(total, n);
  const bases = splitEven(Math.min(feeBaseTotal, total), n);
  return amounts.map((amount, i) => ({
    no: i + 1,
    description: `${label} - Taksit ${i + 1}/${n}`,
    dueDate: addMonths(firstDueDate, i),
    amount: toKurus(amount),
    feeBase: toKurus(Math.min(bases[i] as number, amount)),
  }));
}

/** Kalemin kalan tazminat tabani: odemeler once anapara payini kapatir. */
export function bearingRemaining(c: AllocatedCharge): number {
  if (!c.feeBearing || c.remaining <= 0) return 0;
  const base = c.feeBase ?? c.amount;
  return Math.max(0, Math.min(c.remaining, base - c.paid));
}

/** Temerrut: ek sure gecmis odenmemis taksitlerden ardisik veya toplam esik asildi mi? */
export function detectDefault(overdueNos: readonly number[], rule: PlanRule): boolean {
  const sorted = [...overdueNos].sort((a, b) => a - b);
  if (sorted.length >= rule.total) return true;
  let run = 0;
  let prev = Number.NaN;
  for (const no of sorted) {
    run = no === prev + 1 ? run + 1 : 1;
    prev = no;
    if (run >= rule.consecutive) return true;
  }
  return false;
}

export type InstallmentState = PlanInstallment & { paid: Kurus; remaining: Kurus; overdue: boolean; daysOverdue: number; settledByAcceleration: boolean };

/** Planin defterden canli durumu. */
export function planState(plan: InstallmentPlan, transactions: readonly Transaction[], day: IsoDate) {
  const cancelled = cancelledIn(transactions);
  const sub = readSubledger(linesOfAccount(plan.accountId, transactions), cancelled);
  const { all } = allocate(sub, day);
  const byId = new Map(all.map((c) => [c.id, c]));
  const accTxId = plan.transactionIds.accelerate && !cancelled.has(plan.transactionIds.accelerate) ? plan.transactionIds.accelerate : undefined;
  const accTx = accTxId ? transactions.find((t) => t.transactionId === accTxId) : undefined;
  const accSettled = new Map((accTx?.lines.find((l) => l.side === 'credit')?.settles ?? []).map((s) => [s.chargeId, s.amount]));
  const installments: InstallmentState[] = plan.installments.map((i) => {
    const c = byId.get(i.chargeId);
    const viaAcc = accSettled.get(i.chargeId) ?? 0;
    const paid = c ? c.paid - viaAcc : 0;
    const remaining = c ? c.remaining : 0;
    return {
      ...i,
      paid: toKurus(Math.max(paid, 0)),
      remaining: toKurus(remaining),
      overdue: c?.overdue ?? false,
      daysOverdue: c?.daysOverdue ?? 0,
      settledByAcceleration: viaAcc > 0,
    };
  });
  const accCharge = accTxId ? byId.get(transferItemId(accTxId, 0)) : undefined;
  const accelerated = accCharge
    ? { chargeId: accCharge.id, dueDate: accCharge.dueDate, amount: toKurus(accCharge.amount), paid: accCharge.paid, remaining: accCharge.remaining, overdue: accCharge.overdue }
    : undefined;
  const remaining = toKurus(installments.reduce((s, i) => s + i.remaining, 0) + (accelerated?.remaining ?? 0));
  const graceCut = addDays(day, -plan.rule.graceDays);
  const overdueNos = installments.filter((i) => i.remaining > 0 && i.dueDate < graceCut).map((i) => i.no);
  const completed = plan.status !== 'cancelled' && remaining === 0;
  return {
    installments,
    accelerated,
    paid: toKurus(plan.total - remaining),
    remaining,
    overdueNos,
    inDefault: plan.status === 'active' && detectDefault(overdueNos, plan.rule),
    completed,
    displayStatus: completed ? ('completed' as const) : plan.status,
    /** Muaccel kilmada acilacak kalem: kalan taksit tutari ve tazminat tabani. */
    open: installments
      .map((i) => ({ i, c: byId.get(i.chargeId) }))
      .filter((x): x is { i: InstallmentState; c: AllocatedCharge } => !!x.c && x.c.remaining > 0),
  };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type PlanContext = { apartmentId: string; userId: string };

export type PlanServiceDeps = {
  finance: Pick<FinanceService, 'ensureSystemAccounts'>;
  financeRepo: FinanceRepository;
  plans: PlanRepository;
  core: Partial<Pick<CoreRepository, 'getSite'>>;
  portal?: Pick<PortalService, 'resolveUnit'>;
  now: () => Date;
  newId: () => string;
};

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = (d: IsoDate) => d.replaceAll('-', '');
const trDate = (d: IsoDate) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;

function reqReason(o: Record<string, unknown>): string {
  const reason = (optString(o, 'reason', 300) ?? '').trim();
  if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
  return reason;
}

function reqKey(o: Record<string, unknown>): string {
  const key = reqString(o, 'idempotencyKey', 100);
  if (key.length < 8 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('idempotencyKey 8-100 karakter, yalnizca harf/rakam/-/_ olmalidir', 'idempotencyKey');
  }
  return key;
}

function intIn(o: Record<string, unknown>, key: string, min: number, max: number, dflt: number): number {
  const v = o[key];
  if (v === undefined) return dflt;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new ValidationError(`${key} ${min}-${max} arasi tam sayi olmalidir`, key);
  return v;
}

function parseRule(value: unknown): PlanRule {
  if (value === undefined) return { ...DEFAULT_PLAN_RULE };
  const o = asObject(value, 'rule');
  const rule: PlanRule = {
    consecutive: intIn(o, 'consecutive', 1, 12, DEFAULT_PLAN_RULE.consecutive),
    total: intIn(o, 'total', 1, MAX_INSTALLMENTS, DEFAULT_PLAN_RULE.total),
    graceDays: intIn(o, 'graceDays', 0, 90, DEFAULT_PLAN_RULE.graceDays),
    autoAccelerate: o.autoAccelerate === undefined ? DEFAULT_PLAN_RULE.autoAccelerate : o.autoAccelerate === true,
  };
  if (o.autoAccelerate !== undefined && typeof o.autoAccelerate !== 'boolean') throw new ValidationError('rule.autoAccelerate boolean olmalidir', 'rule.autoAccelerate');
  if (rule.consecutive > rule.total) throw new ValidationError('rule.consecutive rule.total degerini asamaz', 'rule.consecutive');
  return rule;
}

type ParsedPlan = {
  accountId: string;
  chargeIds: string[];
  includeLateFees: boolean;
  installments: number;
  firstDueDate: IsoDate;
  rule: PlanRule;
  reason: string;
};

function parsePlanBody(o: Record<string, unknown>): ParsedPlan {
  const accountId = assertId(o.accountId, 'accountId');
  if (!Array.isArray(o.chargeIds) || o.chargeIds.length === 0 || o.chargeIds.length > MAX_SELECTED) {
    throw new ValidationError(`chargeIds 1-${MAX_SELECTED} ogeli dizi olmalidir`, 'chargeIds');
  }
  const chargeIds = o.chargeIds.map((v, i) => assertId(v, `chargeIds[${i}]`));
  if (new Set(chargeIds).size !== chargeIds.length) throw new ValidationError('chargeIds tekrar iceremez', 'chargeIds');
  if (o.includeLateFees !== undefined && typeof o.includeLateFees !== 'boolean') throw new ValidationError('includeLateFees boolean olmalidir', 'includeLateFees');
  const firstDueDate = o.firstDueDate;
  if (typeof firstDueDate !== 'string' || !isIsoDate(firstDueDate)) throw new ValidationError('firstDueDate YYYY-MM-DD olmalidir', 'firstDueDate');
  return {
    accountId,
    chargeIds: [...chargeIds].sort(),
    includeLateFees: o.includeLateFees !== false,
    installments: intIn(o, 'installments', 1, MAX_INSTALLMENTS, 0),
    firstDueDate,
    rule: parseRule(o.rule),
    reason: reqReason(o),
  };
}

export function createPlanService(overrides: Partial<PlanServiceDeps> & Pick<PlanServiceDeps, 'finance'>) {
  const deps: PlanServiceDeps = {
    financeRepo: financeRepository,
    plans: planRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.financeRepo;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);
  const toEvent = (e: NewEvent): DomainEvent => buildEvent(e, deps.now) as DomainEvent;

  async function rate(apartmentId: string): Promise<number> {
    const site = deps.core.getSite ? await deps.core.getSite(apartmentId) : undefined;
    return site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
  }

  function newTx(ctx: PlanContext, p: Pick<Transaction, 'kind' | 'date' | 'description' | 'lines'> & Partial<Transaction>): Transaction {
    const transactionId = `${compact(p.date)}-${deps.newId()}`;
    return {
      ...financeKeys.transaction(ctx.apartmentId, transactionId),
      entityType: 'TRANSACTION',
      transactionId,
      siteId: ctx.apartmentId,
      totalAmount: toKurus(p.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
      createdAt: stamp(),
      createdBy: ctx.userId,
      ...p,
    };
  }

  async function requireAccount(ctx: PlanContext, accountId: string): Promise<Account & { unitId: string; liableParty: LiableParty }> {
    const a = await repo.getAccount(ctx.apartmentId, accountId);
    if (!a || a.siteId !== ctx.apartmentId) throw new FinanceError('not_found', 'Hesap bulunamadi');
    if (a.type !== 'receivable' || !a.unitId || !a.liableParty) throw new ValidationError('accountId daireye bagli bir alt cari olmali', 'accountId');
    return a as Account & { unitId: string; liableParty: LiableParty };
  }

  /** Olusturma hesabi (onizleme ve olusturma ortak; yazmaz). */
  async function compute(ctx: PlanContext, p: ParsedPlan) {
    const R = today();
    if (p.installments < 1) throw new ValidationError(`installments 1-${MAX_INSTALLMENTS} arasi tam sayi olmalidir`, 'installments');
    if (p.firstDueDate < R) throw new ValidationError('Ilk taksit vadesi bugunden once olamaz', 'firstDueDate');
    if (p.firstDueDate > addMonths(R, 12)) throw new ValidationError('Ilk taksit vadesi en fazla 12 ay sonra olabilir', 'firstDueDate');
    const account = await requireAccount(ctx, p.accountId);
    if (account.closedThrough && R <= account.closedThrough) throw new FinanceError('conflict', 'Bu cari bugune kadar kapatilmis');
    const [txPage, r, plans] = await Promise.all([repo.listTransactions(ctx.apartmentId), rate(ctx.apartmentId), deps.plans.list(ctx.apartmentId)]);
    const txs = txPage.items;
    if (plans.some((x) => x.accountId === account.accountId && x.status === 'active') || openPlanIds(account.accountId, txs).length > 0) {
      throw new FinanceError('conflict', 'Bu caride zaten aktif bir yapılandırma planı var');
    }
    const cancelled = cancelledIn(txs);
    const frozen = r > 0 ? unpostedLateFee(feeLedgerFor(account.accountId, txs, cancelled), r, R) : 0;
    const { open } = allocate(readSubledger(linesOfAccount(account.accountId, txs), cancelled), R);
    const selected: PlanSelectedItem[] = p.chargeIds.map((id) => {
      const c = open.find((x) => x.id === id);
      if (!c) throw new ValidationError(`Kalem ${id} bu caride acik degil`, 'chargeIds');
      if (c.plan) throw new ValidationError(`Kalem ${id} zaten bir yapılandırma planına ait`, 'chargeIds');
      return { chargeId: c.id, description: c.description, dueDate: c.dueDate, amount: c.remaining, feeBase: toKurus(bearingRemaining(c)), lateFee: c.lateFee };
    });
    const fromItems = selected.reduce((s, x) => s + x.amount, 0);
    const total = fromItems + (p.includeLateFees ? frozen : 0);
    const feeBaseTotal = selected.reduce((s, x) => s + x.feeBase, 0);
    const label = `Yapılandırma ${trDate(R)}`;
    const items = buildInstallments(total, feeBaseTotal, p.installments, p.firstDueDate, label);
    return { R, account, rate: r, frozen: toKurus(frozen), selected, total: toKurus(total), feeBaseTotal: toKurus(feeBaseTotal), items, label };
  }

  async function preview(ctx: PlanContext, body: unknown) {
    const o = asObject(body);
    const p = parsePlanBody({ reason: 'onizleme', ...o });
    const c = await compute(ctx, p);
    return {
      accountId: c.account.accountId,
      date: c.R,
      lateFeeMonthlyBasisPoints: c.rate,
      frozenLateFee: c.frozen,
      includeLateFees: p.includeLateFees,
      selected: c.selected,
      total: c.total,
      feeBaseTotal: c.feeBaseTotal,
      installments: c.items,
      rule: p.rule,
    };
  }

  async function replay(ctx: PlanContext, idemId: string, fp: string): Promise<InstallmentPlan | undefined> {
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    const plan = existing.recordId ? await deps.plans.get(ctx.apartmentId, existing.recordId) : undefined;
    if (!plan) throw new FinanceError('conflict', 'Plan kaydi bulunamadi');
    return plan;
  }

  const mapConflict = (err: unknown): unknown => {
    if (err instanceof LedgerConflictError) {
      if (err.reason === 'closed') return new FinanceError('conflict', 'Cari bu tarihe kadar kapatilmis');
      if (err.reason === 'precondition' || err.reason === 'version') return new FinanceError('conflict', 'Plan veya cari es zamanli degisti; tekrar deneyin');
      return new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
    }
    return err;
  };

  async function create(ctx: PlanContext, body: unknown): Promise<{ plan: InstallmentPlan; replayed: boolean }> {
    const o = asObject(body);
    const key = reqKey(o);
    const p = parsePlanBody(o);
    const idemId = `PLN_${key}`;
    const fp = fingerprint({ op: 'plan', ...p });
    const prior = await replay(ctx, idemId, fp);
    if (prior) return { plan: prior, replayed: true };

    const c = await compute(ctx, p);
    if (c.total < p.installments) throw new ValidationError('Taksit sayisi toplam tutari (kurus) asamaz', 'installments');
    await deps.finance.ensureSystemAccounts(ctx);
    const planId = shortId();
    const { account, R } = c;
    const line = (side: 'debit' | 'credit', amount: number, settles?: ChargeSettlement[]) => ({
      accountId: account.accountId,
      side,
      amount: toKurus(amount),
      unitId: account.unitId,
      liableParty: account.liableParty,
      ...(settles ? { settles } : {}),
    });
    const transactions: Transaction[] = [];
    const settles: ChargeSettlement[] = c.selected.map((s) => ({ chargeId: s.chargeId, amount: s.amount }));
    let lateFeeTxId: string | undefined;
    if (c.frozen > 0) {
      const lf = newTx(ctx, {
        kind: 'late_fee',
        date: R,
        dueDate: R,
        description: `Gecikme tazminatı (yapılandırma ${trDate(R)} tarihine kadar)`,
        reference: `LATE_FEE_PLAN:${planId}`,
        lines: [line('debit', c.frozen), { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: c.frozen }],
      });
      transactions.push(lf);
      lateFeeTxId = lf.transactionId;
      if (p.includeLateFees) settles.push({ chargeId: lf.transactionId, amount: c.frozen });
    }
    const open = newTx(ctx, {
      kind: 'restructure',
      date: R,
      description: `Borç yapılandırma (${p.installments} taksit)`,
      reason: p.reason,
      reference: `PLAN:${planId}`,
      plan: { planId, role: 'open', items: c.items },
      lines: [line('credit', c.total, settles), line('debit', c.total)],
    });
    transactions.push(open);

    const ts = stamp();
    const plan: InstallmentPlan = {
      ...planKeys.plan(ctx.apartmentId, planId),
      entityType: 'INSTALLMENT_PLAN',
      planId,
      apartmentId: ctx.apartmentId,
      accountId: account.accountId,
      unitId: account.unitId,
      liableParty: account.liableParty,
      date: R,
      selected: [
        ...c.selected,
        ...(p.includeLateFees && lateFeeTxId
          ? [{ chargeId: lateFeeTxId, description: 'Dondurulan gecikme tazminatı', dueDate: R, amount: c.frozen, feeBase: toKurus(0), lateFee: true }]
          : []),
      ],
      frozenLateFee: c.frozen,
      includeLateFees: p.includeLateFees,
      total: c.total,
      feeBaseTotal: c.feeBaseTotal,
      installments: c.items.map((it, i) => ({ ...it, chargeId: transferItemId(open.transactionId, i) })),
      rule: p.rule,
      status: 'active',
      transactionIds: { ...(lateFeeTxId ? { lateFee: lateFeeTxId } : {}), open: open.transactionId },
      reason: p.reason,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.postBatch({
        transactions,
        idempotency: { id: idemId, fingerprint: fp, recordId: planId, transactionIds: transactions.map((t) => t.transactionId) },
        expectedVersions: { [account.accountId]: account.version },
        newDocs: [plan],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.plan_create',
          target: { type: 'plan', id: planId },
          actorId: ctx.userId,
          reason: p.reason,
          details: {
            accountId: account.accountId,
            selected: plan.selected.map((s) => ({ chargeId: s.chargeId, amount: s.amount })),
            frozenLateFee: plan.frozenLateFee,
            total: plan.total,
            feeBaseTotal: plan.feeBaseTotal,
            installments: plan.installments.length,
            firstDueDate: p.firstDueDate,
            rule: plan.rule,
            transactionIds: plan.transactionIds,
          },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replay(ctx, idemId, fp);
        if (again) return { plan: again, replayed: true };
      }
      throw mapConflict(err);
    }
    return { plan, replayed: false };
  }

  // ----- Okuma -----

  async function requirePlan(ctx: PlanContext, planId: string): Promise<InstallmentPlan> {
    assertId(planId, 'planId');
    const plan = await deps.plans.get(ctx.apartmentId, planId);
    if (!plan || plan.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Plan bulunamadi');
    return plan;
  }

  function view(plan: InstallmentPlan, txs: readonly Transaction[], day: IsoDate) {
    const { PK: _pk, SK: _sk, ...rest } = plan;
    const st = planState(plan, txs, day);
    const { open: _open, ...state } = st;
    return { ...rest, state };
  }

  async function get(ctx: PlanContext, planId: string) {
    const plan = await requirePlan(ctx, planId);
    const txs = (await repo.listTransactions(ctx.apartmentId)).items;
    return view(plan, txs, today());
  }

  async function list(ctx: PlanContext, q: { accountId?: string; status?: string } = {}) {
    const accountId = q.accountId ? assertId(q.accountId, 'accountId') : undefined;
    const statuses = [...PLAN_STATUSES, 'completed'];
    if (q.status !== undefined && !statuses.includes(q.status)) throw new ValidationError(`status su degerlerden biri olmalidir: ${statuses.join(', ')}`, 'status');
    const [plans, txPage] = await Promise.all([deps.plans.list(ctx.apartmentId), repo.listTransactions(ctx.apartmentId)]);
    const day = today();
    return plans
      .filter((p) => p.apartmentId === ctx.apartmentId && (!accountId || p.accountId === accountId))
      .map((p) => view(p, txPage.items, day))
      .filter((v) => !q.status || v.state.displayStatus === q.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // ----- Muaccel kilma / erken kapama -----

  /**
   * Kalan taksitleri hedefli kapatir, tamamini bugun vadeli tek kalem acar. `outbox`: zamanlayicinin
   * temerrut bildirimi (otomatik muacceliyet) ayni atomik yazimda.
   */
  async function accelerateInternal(
    ctx: PlanContext,
    plan: InstallmentPlan,
    mode: 'manual' | 'auto' | 'pull_forward',
    reason: string,
    outbox: DomainEvent[] = [],
  ): Promise<InstallmentPlan> {
    if (plan.status !== 'active') throw new FinanceError('conflict', 'Yalnizca aktif plan muaccel kilinabilir / erken kapatilabilir');
    const day = today();
    const [txPage, account] = await Promise.all([repo.listTransactions(ctx.apartmentId), repo.getAccount(ctx.apartmentId, plan.accountId)]);
    if (!account) throw new FinanceError('not_found', 'Hesap bulunamadi');
    const st = planState(plan, txPage.items, day);
    if (st.open.length === 0) throw new FinanceError('unprocessable', 'Planda odenmemis taksit yok');
    const amount = st.open.reduce((s, x) => s + x.c.remaining, 0);
    const feeBase = st.open.reduce((s, x) => s + bearingRemaining(x.c), 0);
    const settles = st.open.map((x) => ({ chargeId: x.c.id, amount: x.c.remaining }));
    const line = (side: 'debit' | 'credit', s?: ChargeSettlement[]) => ({
      accountId: plan.accountId,
      side,
      amount: toKurus(amount),
      unitId: plan.unitId,
      liableParty: plan.liableParty,
      ...(s ? { settles: s } : {}),
    });
    const pull = mode === 'pull_forward';
    const description = pull ? 'Erken kapama: kalan taksitler' : 'Muaccel kalan plan borcu';
    const tx = newTx(ctx, {
      kind: 'restructure',
      date: day,
      description: `${description} (${trDate(plan.date)} yapılandırması)`,
      reason,
      reference: `PLAN:${plan.planId}`,
      plan: { planId: plan.planId, role: pull ? 'pull_forward' : 'accelerate', items: [{ no: 0, description, dueDate: day, amount: toKurus(amount), feeBase: toKurus(Math.min(feeBase, amount)) }] },
      lines: [line('credit', settles), line('debit')],
    });
    const ts = stamp();
    const { default: _d, ...base } = plan;
    const next: InstallmentPlan = {
      ...base,
      status: 'accelerated',
      transactionIds: { ...plan.transactionIds, accelerate: tx.transactionId },
      acceleration: { at: ts, by: ctx.userId, mode, amount: toKurus(amount), feeBase: toKurus(feeBase), transactionId: tx.transactionId, reason },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: plan.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [tx],
        idempotency: { id: `PLN_ACC_${plan.planId}`, fingerprint: fingerprint({ op: 'plan_accelerate', planId: plan.planId, mode }), recordId: plan.planId, transactionIds: [tx.transactionId] },
        expectedVersions: { [plan.accountId]: account.version },
        replaceRecords: [{ item: next, expectedVersion: plan.version, label: 'plan' }],
        ...(outbox.length ? { outbox } : {}),
        audit: {
          apartmentId: ctx.apartmentId,
          action: pull ? 'finance.plan_pull_forward' : 'finance.plan_accelerate',
          target: { type: 'plan', id: plan.planId },
          actorId: ctx.userId,
          reason,
          details: { mode, amount, feeBase, transactionId: tx.transactionId, installments: settles },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') throw new FinanceError('conflict', 'Plan zaten muaccel kilinmis / kapatilmis');
      throw mapConflict(err);
    }
    return next;
  }

  async function accelerate(ctx: PlanContext, planId: string, body: unknown) {
    const reason = reqReason(asObject(body));
    const plan = await requirePlan(ctx, planId);
    const next = await accelerateInternal(ctx, plan, 'manual', reason);
    return get(ctx, next.planId);
  }

  async function pullForward(ctx: PlanContext, planId: string, body: unknown) {
    const reason = reqReason(asObject(body));
    const plan = await requirePlan(ctx, planId);
    const next = await accelerateInternal(ctx, plan, 'pull_forward', reason);
    return get(ctx, next.planId);
  }

  // ----- Iptal -----

  async function cancel(ctx: PlanContext, planId: string, body: unknown) {
    const reason = reqReason(asObject(body));
    const plan = await requirePlan(ctx, planId);
    if (plan.status === 'cancelled') throw new FinanceError('conflict', 'Plan zaten iptal edilmis');
    const [txPage, account] = await Promise.all([repo.listTransactions(ctx.apartmentId), repo.getAccount(ctx.apartmentId, plan.accountId)]);
    if (account?.closedThrough && account.closedThrough >= plan.date) {
      throw new FinanceError('unprocessable', 'Cari plandan sonra kapatilmis; plan iptal edilemez');
    }
    const txs = txPage.items;
    const day = today();
    if (planState(plan, txs, day).completed) throw new FinanceError('unprocessable', 'Tamamlanmis plan iptal edilemez');
    const cancelled = cancelledIn(txs);
    const ids = [plan.transactionIds.accelerate, plan.transactionIds.open].filter((id): id is string => !!id && !cancelled.has(id));
    const originals = ids.map((id) => txs.find((t) => t.transactionId === id)).filter((t): t is Transaction => !!t);
    const reversals = originals.map((t) =>
      newTx(ctx, {
        kind: 'reversal',
        date: day,
        description: `Ters kayit: ${t.description}`,
        reversalOf: t.transactionId,
        reason,
        reference: `PLAN:${plan.planId}`,
        lines: t.lines.map(({ settles: _s, ...l }) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
      }),
    );
    const ts = stamp();
    const { default: _d, ...base } = plan;
    const next: InstallmentPlan = {
      ...base,
      status: 'cancelled',
      cancellation: { at: ts, by: ctx.userId, reason, transactionIds: reversals.map((t) => t.transactionId) },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: plan.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: reversals,
        idempotency: { id: `PLN_CNL_${plan.planId}`, fingerprint: fingerprint({ op: 'plan_cancel', planId: plan.planId }), recordId: plan.planId, transactionIds: reversals.map((t) => t.transactionId) },
        replaceRecords: [{ item: next, expectedVersion: plan.version, label: 'plan' }],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.plan_cancel',
          target: { type: 'plan', id: plan.planId },
          actorId: ctx.userId,
          reason,
          details: { reversalTransactionIds: reversals.map((t) => t.transactionId), frozenLateFeeKept: plan.frozenLateFee },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') throw new FinanceError('conflict', 'Plan zaten iptal edilmis');
      throw mapConflict(err);
    }
    return get(ctx, plan.planId);
  }

  // ----- Temerrut taramasi (zamanlayici) -----

  function defaultEvent(apartmentId: string, plan: InstallmentPlan, day: IsoDate, amount: number, dueDate: IsoDate, userId?: string): DomainEvent {
    return toEvent({
      eventId: `PLAN_DEFAULT:${plan.planId}:${day}`,
      type: 'DUES_REMINDER',
      apartmentId,
      actorId: SYSTEM_ACTOR,
      groupKey: plan.unitId,
      payload: {
        date: day,
        items: [{ unitId: plan.unitId, liableParty: plan.liableParty, kind: 'plan_default', dueDate, amount: toKurus(amount), ...(userId ? { userId } : {}) }],
      },
    });
  }

  /**
   * Aktif planlarda temerrut tespiti (gunluk). Yeni temerrut: sakine bildirim (outbox) +
   * `autoAccelerate` ise muaccel kilma, degilse plan isaretlenir (yonetici onayi bekler). Temerrut
   * duzelmisse (geciken taksitler odendi) isaret kaldirilir. Tekrar calisma guvenlidir.
   */
  async function checkDefaults(apartmentId: string, day: IsoDate) {
    if (!isIsoDate(day)) throw new ValidationError('day YYYY-MM-DD olmali', 'day');
    const ctx: PlanContext = { apartmentId, userId: SYSTEM_ACTOR };
    const plans = (await deps.plans.list(apartmentId)).filter((p) => p.apartmentId === apartmentId && p.status === 'active');
    const out = { checked: plans.length, flagged: [] as string[], accelerated: [] as string[], cleared: [] as string[] };
    if (plans.length === 0) return out;
    const [txPage, accounts] = await Promise.all([repo.listTransactions(apartmentId), repo.listAccounts(apartmentId)]);
    for (const plan of plans) {
      const st = planState(plan, txPage.items, day);
      const holder = accounts.find((a) => a.accountId === plan.accountId)?.coOwner?.userId;
      if (st.inDefault && !plan.default) {
        const first = st.installments.find((i) => st.overdueNos.includes(i.no));
        const event = defaultEvent(apartmentId, plan, day, st.remaining, first?.dueDate ?? day, holder);
        if (plan.rule.autoAccelerate) {
          try {
            await accelerateInternal(ctx, plan, 'auto', `Otomatik muacceliyet: ${st.overdueNos.length} taksit gecikmede`, [event]);
            out.accelerated.push(plan.planId);
          } catch (err) {
            if (err instanceof FinanceError && err.code === 'conflict') continue;
            throw err;
          }
          continue;
        }
        const ts = stamp();
        const next: InstallmentPlan = { ...plan, default: { detectedAt: day, overdueNos: st.overdueNos }, updatedAt: ts, updatedBy: SYSTEM_ACTOR, version: plan.version + 1 };
        await writeFlag(ctx, plan, next, `PLN_DEF_${plan.planId}_${day}`, 'finance.plan_default', [event], { overdueNos: st.overdueNos, remaining: st.remaining });
        out.flagged.push(plan.planId);
      } else if (!st.inDefault && plan.default) {
        const { default: _d, ...rest } = plan;
        const ts = stamp();
        const next: InstallmentPlan = { ...rest, updatedAt: ts, updatedBy: SYSTEM_ACTOR, version: plan.version + 1 };
        await writeFlag(ctx, plan, next, `PLN_DEFCLR_${plan.planId}_${day}`, 'finance.plan_default_cleared', [], {});
        out.cleared.push(plan.planId);
      }
    }
    return out;
  }

  async function writeFlag(
    ctx: PlanContext,
    plan: InstallmentPlan,
    next: InstallmentPlan,
    idemId: string,
    action: string,
    outbox: DomainEvent[],
    details: Record<string, unknown>,
  ) {
    const replace: ReplaceRecord = { item: next, expectedVersion: plan.version, label: 'plan' };
    try {
      await repo.postBatch({
        transactions: [],
        idempotency: { id: idemId, fingerprint: fingerprint({ op: action, planId: plan.planId }), recordId: plan.planId },
        replaceRecords: [replace],
        ...(outbox.length ? { outbox } : {}),
        audit: { apartmentId: ctx.apartmentId, action, target: { type: 'plan', id: plan.planId }, actorId: ctx.userId, details },
      });
    } catch (err) {
      // Ayni gun tekrar calisma / es zamanli degisiklik: sonraki tur yeniden degerlendirir.
      if (err instanceof LedgerConflictError) return;
      throw err;
    }
  }

  // ----- Sakin portali -----

  async function portalPlans(ctx: PortalContext, unitId?: string) {
    if (!deps.portal) throw new FinanceError('unprocessable', 'Portal baglantisi yok');
    const resolved = await deps.portal.resolveUnit(ctx, unitId);
    const accounts = new Set(resolved.parties.map((p) => resolved.accounts[p]));
    const [plans, txPage] = await Promise.all([deps.plans.list(ctx.apartmentId), repo.listTransactions(ctx.apartmentId)]);
    const day = today();
    const items = plans
      .filter((p) => p.apartmentId === ctx.apartmentId && accounts.has(p.accountId) && p.status !== 'cancelled')
      .map((p) => {
        const st = planState(p, txPage.items, day);
        // Sakine yalnizca plan ozeti ve taksitler (gerekce / denetim alanlari yok).
        return {
          planId: p.planId,
          liableParty: p.liableParty,
          date: p.date,
          total: p.total,
          frozenLateFee: p.frozenLateFee,
          status: st.displayStatus,
          paid: st.paid,
          remaining: st.remaining,
          inDefault: st.inDefault || Boolean(p.default),
          rule: { consecutive: p.rule.consecutive, total: p.rule.total, graceDays: p.rule.graceDays },
          installments: st.installments.map((i) => ({
            no: i.no,
            dueDate: i.dueDate,
            amount: i.amount,
            paid: i.paid,
            remaining: i.remaining,
            overdue: i.overdue,
            ...(i.settledByAcceleration ? { accelerated: true } : {}),
          })),
          ...(st.accelerated ? { accelerated: st.accelerated } : {}),
        };
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    return { unitId: resolved.unit.unitId, currency: 'TRY' as const, items };
  }

  return { preview, create, get, list, accelerate, pullForward, cancel, checkDefaults, portalPlans };
}

export type PlanService = ReturnType<typeof createPlanService>;
