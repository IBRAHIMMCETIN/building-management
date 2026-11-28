/**
 * Finans 2.2 sonrasi - Tedarikci avans mahsubu.
 *
 * Tedarikciye fatura oncesi yapilan odeme (avans / on odeme) tedarikcinin borc hesabina (`payable`)
 * yazilmaz; tedarikci basina ayri bir ALACAK alt hesabinda (`supadv-<tedarikci>`, borc-normal,
 * `supplierAdvanceOf`) tutulur. Boylece avans, gelecek faturalarla ACIKCA ve tarihli bir kayitla
 * mahsup edilene kadar acik kalem olarak izlenir.
 *
 * Defter kayitlari (her biri cift tarafli, kendi icinde dengeli; append-only):
 *   1. Avans verme (`supplier_advance`):         borc  tedarikci avans hesabi / alacak kasa-banka
 *   2. Avans mahsubu (`supplier_advance_offset`): borc  tedarikci `payable`   / alacak tedarikci avans hesabi
 *      `supplierAdvance.settles` hangi faturalarin kapandigini soyler (tedarikci FIFO dokumunde once
 *      bu faturalar kapanir; bkz. payables.ts).
 *   3. Geri alma: ters kayit (`reversal`, `reversalOf`); mahsup geri alinir (avans yeniden acik, borc
 *      geri gelir) veya hic mahsup edilmemis avans iptal edilir (para kasa/bankaya doner).
 * Genel ters kayit ucu (`/transactions/:id/reversal`) bu islemleri reddeder; avans mahsubunun
 * hedefledigi fatura (gider) da mahsup geri alinmadan ters cevrilemez (service.ts `reversalBlockOf`).
 *
 * Kayitlar: `SUPADV#<avans>` (tutar, mahsup edilen, durum; surumlu) ve `SUPADVOFS#<mahsup>`. Her
 * yazim defter islemi + kayit + idempotency + denetim kaydiyla TEK atomik yazimdir. Es zamanlilik:
 * mahsup tedarikci ve avans hesaplarinin surumune (`expectedVersions`) ve avans kaydinin surumune
 * kosulludur; ayni avansi iki es zamanli mahsup asamaz.
 */
import { createHash, randomUUID } from 'node:crypto';
import { getTenantItem, queryTenantAll, skKey, tenantPk } from '../../config/dynamodb.js';
import { type IsoDate, type IsoDateTime, type Kurus, type TableKeys, toKurus } from '../core/types.js';
import { ValidationError, asObject, assertId, isIsoDate, optString, reqString } from '../core/validation.js';
import { type PayableSummary, payableSummary } from './payables.js';
import { type FinanceRepository, LedgerConflictError, accountTransactions, financeKeys, financeRepository, toLedgerEntries } from './repository.js';
import { FinanceError, type FinanceService, MAX_AMOUNT, SYSTEM_ACCOUNTS } from './service.js';
import type { Account, LedgerEntry, Transaction } from './types.js';

// ---------------------------------------------------------------------------
// Kayitlar
// ---------------------------------------------------------------------------

export const SUPPLIER_ADVANCE_STATUSES = ['open', 'applied', 'reversed'] as const;
export type SupplierAdvanceStatus = (typeof SUPPLIER_ADVANCE_STATUSES)[number];

/** PK = `APT#<apartmentId>`, SK = `SUPADV#<advanceId>` */
export type SupplierAdvance = TableKeys & {
  entityType: 'SUPPLIER_ADVANCE';
  advanceId: string;
  apartmentId: string;
  payableAccountId: string;
  advanceAccountId: string;
  fundsAccountId: string;
  amount: Kurus;
  /** Mahsup edilen (geri alinmamis) toplam. Acik avans = amount - applied. */
  applied: Kurus;
  date: IsoDate;
  description: string;
  reference?: string;
  transactionId: string;
  /** open: mahsup edilebilir kalan var; applied: tamami mahsup edildi; reversed: iptal (ters kayit). */
  status: SupplierAdvanceStatus;
  /** Bu avansin mahsup kayitlari (ayrinti okumasi tum mahsuplari taramaz). */
  offsetIds?: string[];
  reversal?: { at: IsoDateTime; by: string; reason: string; transactionId: string };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

/** PK = `APT#<apartmentId>`, SK = `SUPADVOFS#<offsetId>` */
export type SupplierAdvanceOffset = TableKeys & {
  entityType: 'SUPPLIER_ADVANCE_OFFSET';
  offsetId: string;
  apartmentId: string;
  advanceId: string;
  payableAccountId: string;
  advanceAccountId: string;
  amount: Kurus;
  date: IsoDate;
  /** Kapatilan faturalar (gider islemi kimligi). Toplam = amount. */
  settles: { transactionId: string; amount: Kurus }[];
  transactionId: string;
  status: 'completed' | 'reversed';
  reason: string;
  reversal?: { at: IsoDateTime; by: string; reason: string; transactionId: string };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const supplierAdvanceKeys = {
  advance: (apartmentId: string, advanceId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('SUPADV', advanceId) }),
  offset: (apartmentId: string, offsetId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: skKey('SUPADVOFS', offsetId) }),
};

export type SupplierAdvanceRepository = {
  get(apartmentId: string, advanceId: string): Promise<SupplierAdvance | undefined>;
  list(apartmentId: string): Promise<SupplierAdvance[]>;
  getOffset(apartmentId: string, offsetId: string): Promise<SupplierAdvanceOffset | undefined>;
  listOffsets(apartmentId: string): Promise<SupplierAdvanceOffset[]>;
};

export const supplierAdvanceRepository: SupplierAdvanceRepository = {
  get: (apartmentId, advanceId) => getTenantItem<SupplierAdvance>(supplierAdvanceKeys.advance(apartmentId, advanceId)),
  // `SUPADV#` oneki `SUPADVOFS#` kayitlarini kapsamaz (`#` ayirici).
  list: async (apartmentId) =>
    (await queryTenantAll<SupplierAdvance>(apartmentId, 'SUPADV#', { ConsistentRead: true })).filter((a) => a.entityType === 'SUPPLIER_ADVANCE'),
  getOffset: (apartmentId, offsetId) => getTenantItem<SupplierAdvanceOffset>(supplierAdvanceKeys.offset(apartmentId, offsetId)),
  listOffsets: async (apartmentId) =>
    (await queryTenantAll<SupplierAdvanceOffset>(apartmentId, 'SUPADVOFS#', { ConsistentRead: true })).filter((o) => o.entityType === 'SUPPLIER_ADVANCE_OFFSET'),
};

/** Avans alt hesaplarinin ayrilmis on eki (`POST /accounts` bu onekle hesap acamaz). */
export const SUPPLIER_ADVANCE_ACCOUNT_PREFIX = 'supadv-';

/** Hesap gercekten bu tedarikcinin avans alt hesabi mi? */
export const isAdvanceAccountOf = (a: Pick<Account, 'type' | 'supplierAdvanceOf'> | undefined, payableAccountId: string) =>
  !!a && a.type === 'receivable' && a.supplierAdvanceOf === payableAccountId;

/** Tedarikcinin avans alt hesabi (deterministik; hesap kimligi 64 karakteri asmaz). */
export function supplierAdvanceAccountId(payableAccountId: string): string {
  const plain = `supadv-${payableAccountId}`;
  return plain.length <= 64 ? plain : `supadv-h${createHash('sha256').update(payableAccountId).digest('hex').slice(0, 24)}`;
}

/** Acik avans (mahsup edilebilir kalan). */
export const openOfAdvance = (a: Pick<SupplierAdvance, 'amount' | 'applied' | 'status'>): Kurus =>
  toKurus(a.status === 'reversed' ? 0 : Math.max(0, a.amount - a.applied));

// ---------------------------------------------------------------------------
// Saf: tedarikci ekstresi
// ---------------------------------------------------------------------------

/** invoice: fatura (borc artar), payment: odeme, advance: verilen avans, advance_offset: avans mahsubu, reversal: ters kayit. */
export const SUPPLIER_STATEMENT_CATEGORIES = ['invoice', 'payment', 'advance', 'advance_offset', 'reversal', 'other'] as const;
export type SupplierStatementCategory = (typeof SUPPLIER_STATEMENT_CATEGORIES)[number];

export type SupplierStatementRow = {
  date: IsoDate;
  transactionId: string;
  kind: Transaction['kind'];
  category: SupplierStatementCategory;
  description: string;
  reference?: string;
  /** Ters kayitta iptal edilen islem ve onun kategorisi (toplamlar o kategoriden netlenir). */
  reversalOf?: string;
  reverses?: SupplierStatementCategory;
  /** Isaretli degisim: acik borc (tedarikciye; + artar) ve acik avans (tedarikciden; + artar). */
  payableChange: number;
  advanceChange: number;
  /** Satirdan sonra: acik borc, acik avans ve net (borc - avans). */
  payableBalance: number;
  advanceBalance: number;
  net: number;
};

function categoryOf(kind: Transaction['kind'], dPayable: number, dAdvance: number): SupplierStatementCategory {
  if (kind === 'reversal') return 'reversal';
  if (kind === 'supplier_advance_offset') return 'advance_offset';
  if (kind === 'supplier_advance') return 'advance';
  if (dAdvance === 0 && dPayable > 0) return 'invoice';
  if (dAdvance === 0 && dPayable < 0) return 'payment';
  return 'other';
}

/**
 * Tedarikci ekstresi: tedarikci borc hesabi + avans hesabi satirlari tek zaman cizelgesinde (tarih,
 * yazim sirasi). Iptal edilen islem ve ters kaydi gorunur kalir (append-only); bakiyeler hesap
 * bakiyeleriyle ayni (isaretli toplam). `from` oncesi satirlar devire (`opening`) girer, `to`
 * sonrasi satirlar alinmaz.
 */
export function buildSupplierStatement(
  payableAccountId: string,
  advanceAccountId: string,
  entries: readonly Pick<LedgerEntry, 'accountId' | 'transactionId' | 'side' | 'amount' | 'date' | 'createdAt'>[],
  txById: ReadonlyMap<string, Pick<Transaction, 'transactionId' | 'kind' | 'description' | 'reference' | 'reversalOf'>>,
  range: { from?: IsoDate; to?: IsoDate } = {},
) {
  type E = (typeof entries)[number];
  const byTx = new Map<string, E[]>();
  for (const e of entries) {
    if (e.accountId !== payableAccountId && e.accountId !== advanceAccountId) continue;
    byTx.set(e.transactionId, [...(byTx.get(e.transactionId) ?? []), e]);
  }
  const ordered = [...byTx.entries()].sort(([ia, a], [ib, b]) => {
    const ea = a[0] as E;
    const eb = b[0] as E;
    return ea.date.localeCompare(eb.date) || ea.createdAt.localeCompare(eb.createdAt) || ia.localeCompare(ib);
  });
  let payable = 0;
  let advance = 0;
  let opening = { payableBalance: 0, advanceBalance: 0 };
  const rows: SupplierStatementRow[] = [];
  /**
   * Toplamlar isaretli ve NET: ters kayit iptal ettigi islemin kategorisinden duser. Boylece
   *   kapanis borcu = devir + fatura - odeme - mahsup,  kapanis avansi = devir + verilen avans - mahsup.
   */
  const totals = { invoice: 0, payment: 0, advanceGiven: 0, advanceApplied: 0 };
  const apply = (cat: SupplierStatementCategory, dP: number, dA: number) => {
    if (cat === 'invoice') totals.invoice += dP;
    else if (cat === 'payment') totals.payment -= dP;
    else if (cat === 'advance') totals.advanceGiven += dA;
    else if (cat === 'advance_offset') totals.advanceApplied -= dP;
    else {
      // Beklenmeyen bilesim: borc etkisi fatura / odeme, avans etkisi verilen avans olarak sayilir.
      if (dP > 0) totals.invoice += dP;
      else totals.payment -= dP;
      totals.advanceGiven += dA;
    }
  };
  const deltasOf = (lines: readonly E[]) => ({
    // Tedarikci (alacak-normal) acik borcu = alacak - borc; avans (borc-normal) = borc - alacak.
    dP: lines.filter((l) => l.accountId === payableAccountId).reduce((s, l) => s + (l.side === 'credit' ? l.amount : -l.amount), 0),
    dA: lines.filter((l) => l.accountId === advanceAccountId).reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0),
  });
  for (const [transactionId, lines] of ordered) {
    const tx = txById.get(transactionId);
    const date = (lines[0] as E).date;
    if (range.to && date > range.to) continue;
    const { dP: dPayable, dA: dAdvance } = deltasOf(lines);
    payable += dPayable;
    advance += dAdvance;
    if (range.from && date < range.from) {
      opening = { payableBalance: payable, advanceBalance: advance };
      continue;
    }
    const kind = tx?.kind ?? 'expense';
    const category = categoryOf(kind, dPayable, dAdvance);
    let reverses: SupplierStatementCategory | undefined;
    if (category === 'reversal') {
      // Iptal edilen islemin kategorisi: kendi turu ve (ters kaydin tersi olan) etkisi.
      const original = tx?.reversalOf ? txById.get(tx.reversalOf) : undefined;
      reverses = categoryOf(original?.kind ?? 'expense', -dPayable, -dAdvance);
      apply(reverses, dPayable, dAdvance);
    } else {
      apply(category, dPayable, dAdvance);
    }
    rows.push({
      date,
      transactionId,
      kind,
      category,
      description: tx?.description ?? transactionId,
      ...(tx?.reference ? { reference: tx.reference } : {}),
      ...(tx?.reversalOf ? { reversalOf: tx.reversalOf } : {}),
      ...(reverses ? { reverses } : {}),
      payableChange: dPayable,
      advanceChange: dAdvance,
      payableBalance: payable,
      advanceBalance: advance,
      net: payable - advance,
    });
  }
  return {
    opening: { ...opening, net: opening.payableBalance - opening.advanceBalance },
    rows,
    totals,
    closing: { payableBalance: payable, advanceBalance: advance, net: payable - advance },
  };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export type SupplierAdvanceContext = { apartmentId: string; userId: string };

export type SupplierAdvanceServiceDeps = {
  finance: Pick<FinanceService, 'ensureSystemAccounts'>;
  financeRepo: FinanceRepository;
  advances: SupplierAdvanceRepository;
  now: () => Date;
  newId: () => string;
};

const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compact = (d: IsoDate) => d.replaceAll('-', '');
const MAX_SETTLES = 50;

function reqKey(o: Record<string, unknown>): string {
  const key = reqString(o, 'idempotencyKey', 100);
  if (key.length < 8 || !/^[A-Za-z0-9_-]+$/.test(key)) {
    throw new ValidationError('idempotencyKey 8-100 karakter, yalnizca harf/rakam/-/_ olmalidir', 'idempotencyKey');
  }
  return key;
}

function reqAmount(o: Record<string, unknown>, field = 'amount'): Kurus {
  const v = o[field];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > MAX_AMOUNT) throw new ValidationError(`${field} pozitif tam sayi (kurus) olmalidir`, field);
  return toKurus(v);
}

function reqReason(o: Record<string, unknown>): string {
  const reason = (optString(o, 'reason', 300) ?? '').trim();
  if (reason.length < 5) throw new ValidationError('Gerekce en az 5 karakter olmalidir', 'reason');
  return reason;
}

function optDate(o: Record<string, unknown>, field: string): IsoDate | undefined {
  const v = o[field];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${field} YYYY-MM-DD olmalidir`, field);
  return v;
}

function parseSettles(value: unknown): { transactionId: string; amount: Kurus }[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SETTLES) throw new ValidationError(`settles 1-${MAX_SETTLES} ogeli dizi olmalidir`, 'settles');
  const out = value.map((v, i) => {
    const o = asObject(v, `settles[${i}]`);
    return { transactionId: assertId(o.transactionId, `settles[${i}].transactionId`), amount: reqAmount(o, 'amount') };
  });
  if (new Set(out.map((s) => s.transactionId)).size !== out.length) throw new ValidationError('settles ayni faturayi iki kez iceremez', 'settles');
  return out;
}

export function createSupplierAdvanceService(overrides: Partial<SupplierAdvanceServiceDeps> & Pick<SupplierAdvanceServiceDeps, 'finance'>) {
  const deps: SupplierAdvanceServiceDeps = {
    financeRepo: financeRepository,
    advances: supplierAdvanceRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.financeRepo;
  const stamp = (): IsoDateTime => deps.now().toISOString();
  const today = (): IsoDate => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());
  const shortId = () => deps.newId().replace(/[^A-Za-z0-9]/g, '').slice(0, 16);

  function newTx(ctx: SupplierAdvanceContext, p: Pick<Transaction, 'kind' | 'date' | 'description' | 'lines'> & Partial<Transaction>): Transaction {
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

  async function requirePayable(ctx: SupplierAdvanceContext, accountId: unknown, field = 'payableAccountId'): Promise<Account> {
    const id = assertId(accountId, field);
    const a = await repo.getAccount(ctx.apartmentId, id);
    if (!a || a.siteId !== ctx.apartmentId) throw new FinanceError('not_found', 'Tedarikci hesabi bulunamadi');
    if (a.type !== 'payable') throw new ValidationError(`${field} bir tedarikci (borc) hesabi olmali`, field);
    return a;
  }

  /** Tedarikcinin avans alt hesabi (yoksa acilir; var olan ezilmez). */
  async function ensureAdvanceAccount(ctx: SupplierAdvanceContext, payable: Account): Promise<Account> {
    const accountId = supplierAdvanceAccountId(payable.accountId);
    const existing = await repo.getAccount(ctx.apartmentId, accountId);
    if (existing) {
      // Ayrilmis kimlik baska bir hesapca tutuluyorsa (or. eski elle acilmis hesap) yazilmaz.
      if (!isAdvanceAccountOf(existing, payable.accountId)) throw new FinanceError('conflict', `${accountId} kimligi baska bir hesapca kullaniliyor; avans hesabi acilamaz`);
      return existing;
    }
    const ts = stamp();
    const account: Account = {
      ...financeKeys.account(ctx.apartmentId, accountId),
      entityType: 'ACCOUNT',
      accountId,
      siteId: ctx.apartmentId,
      type: 'receivable',
      name: `${payable.name} - Verilen avans`.slice(0, 120),
      status: 'active',
      system: true,
      balance: toKurus(0),
      supplierAdvanceOf: payable.accountId,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    await repo.ensureAccounts([account]);
    const created = (await repo.getAccount(ctx.apartmentId, accountId)) ?? account;
    if (!isAdvanceAccountOf(created, payable.accountId)) throw new FinanceError('conflict', `${accountId} kimligi baska bir hesapca kullaniliyor; avans hesabi acilamaz`);
    return created;
  }

  /** Tedarikci ve avans hesabinin islemleri (yalnizca bu iki hesabin satirlari). */
  async function supplierLedger(ctx: SupplierAdvanceContext, payableAccountId: string) {
    const advanceAccountId = supplierAdvanceAccountId(payableAccountId);
    const txs = await accountTransactions(repo, ctx.apartmentId, [payableAccountId, advanceAccountId]);
    const entries = txs.flatMap((t) => toLedgerEntries(t)).filter((e) => e.accountId === payableAccountId || e.accountId === advanceAccountId);
    return { advanceAccountId, txs, entries, txById: new Map(txs.map((t) => [t.transactionId, t])) };
  }

  async function payableOf(ctx: SupplierAdvanceContext, payableAccountId: string): Promise<PayableSummary> {
    const { entries, txById } = await supplierLedger(ctx, payableAccountId);
    return payableSummary(payableAccountId, entries, txById);
  }

  const mapConflict = (err: unknown, message = 'Es zamanli bir islem cakismasi oldu, tekrar deneyin'): unknown => {
    if (err instanceof LedgerConflictError) {
      if (err.reason === 'closed') return new FinanceError('conflict', 'Hesap bu tarihe kadar kapatilmis');
      if (err.reason === 'precondition' || err.reason === 'version') return new FinanceError('conflict', 'Avans veya tedarikci hesabi es zamanli degisti; tekrar deneyin');
      return new FinanceError('conflict', message);
    }
    return err;
  };

  async function requireAdvance(ctx: SupplierAdvanceContext, advanceId: string): Promise<SupplierAdvance> {
    assertId(advanceId, 'advanceId');
    const a = await deps.advances.get(ctx.apartmentId, advanceId);
    if (!a || a.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Avans kaydi bulunamadi');
    return a;
  }

  async function requireOffset(ctx: SupplierAdvanceContext, offsetId: string): Promise<SupplierAdvanceOffset> {
    assertId(offsetId, 'offsetId');
    const o = await deps.advances.getOffset(ctx.apartmentId, offsetId);
    if (!o || o.apartmentId !== ctx.apartmentId) throw new FinanceError('not_found', 'Avans mahsubu bulunamadi');
    return o;
  }

  async function replayRecord<T>(ctx: SupplierAdvanceContext, idemId: string, fp: string, load: (id: string) => Promise<T | undefined>): Promise<T | undefined> {
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    const rec = existing.recordId ? await load(existing.recordId) : undefined;
    if (!rec) throw new FinanceError('conflict', 'Kayit bulunamadi');
    return rec;
  }

  // ----- Avans verme -----

  async function create(ctx: SupplierAdvanceContext, body: unknown): Promise<{ advance: SupplierAdvance; replayed: boolean }> {
    const o = asObject(body);
    const key = reqKey(o);
    const payableAccountId = assertId(o.payableAccountId, 'payableAccountId');
    const fundsAccountId = o.fundsAccountId === undefined ? SYSTEM_ACCOUNTS.bank : assertId(o.fundsAccountId, 'fundsAccountId');
    const amount = reqAmount(o);
    const day = today();
    const date = optDate(o, 'date') ?? day;
    if (date > day) throw new ValidationError('Avans tarihi bugunden sonra olamaz', 'date');
    const description = (optString(o, 'description', 200) ?? '').trim() || 'Tedarikçi avansı';
    const reference = (optString(o, 'reference', 60) ?? '').trim() || undefined;
    // Ad alanlari: istemci anahtarlari `_C_`, ic geri alma kimlikleri `_R_` (birbirleriyle cakismaz).
    const idemId = `SADV_C_${key}`;
    const fp = fingerprint({ op: 'supplier_advance', payableAccountId, fundsAccountId, amount, date, description, reference });
    const prior = await replayRecord(ctx, idemId, fp, (id) => deps.advances.get(ctx.apartmentId, id));
    if (prior) return { advance: prior, replayed: true };

    await deps.finance.ensureSystemAccounts(ctx);
    const payable = await requirePayable(ctx, payableAccountId);
    if (payable.status !== 'active') throw new FinanceError('unprocessable', 'Pasif tedarikciye avans verilemez');
    const funds = await repo.getAccount(ctx.apartmentId, fundsAccountId);
    if (!funds || (funds.type !== 'cash' && funds.type !== 'bank') || funds.status !== 'active') {
      throw new FinanceError('unprocessable', 'Odeme hesabi aktif bir kasa/banka hesabi olmali');
    }
    if (funds.balance < amount) throw new FinanceError('insufficient_funds', 'Kasa/banka bakiyesi bu avans icin yetersiz');
    const advAccount = await ensureAdvanceAccount(ctx, payable);

    const advanceId = shortId();
    const tx = newTx(ctx, {
      kind: 'supplier_advance',
      date,
      description: `${description} (${payable.name})`.slice(0, 200),
      reference: `SUPADV:${advanceId}`,
      supplierAdvance: { advanceId, payableAccountId },
      lines: [
        { accountId: advAccount.accountId, side: 'debit', amount },
        { accountId: fundsAccountId, side: 'credit', amount },
      ],
    });
    const ts = stamp();
    const advance: SupplierAdvance = {
      ...supplierAdvanceKeys.advance(ctx.apartmentId, advanceId),
      entityType: 'SUPPLIER_ADVANCE',
      advanceId,
      apartmentId: ctx.apartmentId,
      payableAccountId,
      advanceAccountId: advAccount.accountId,
      fundsAccountId,
      amount,
      applied: toKurus(0),
      date,
      description,
      ...(reference ? { reference } : {}),
      transactionId: tx.transactionId,
      status: 'open',
      offsetIds: [],
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    try {
      await repo.postBatch({
        transactions: [tx],
        idempotency: { id: idemId, fingerprint: fp, recordId: advanceId, transactionIds: [tx.transactionId] },
        // Kasa/banka bakiyesine bagli kural: okumadan sonra degistiyse reddedilir.
        expectedVersions: { [fundsAccountId]: funds.version },
        newDocs: [advance],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.supplier_advance',
          target: { type: 'supplier_advance', id: advanceId },
          actorId: ctx.userId,
          details: { payableAccountId, advanceAccountId: advAccount.accountId, fundsAccountId, amount, date, transactionId: tx.transactionId, ...(reference ? { reference } : {}) },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replayRecord(ctx, idemId, fp, (id) => deps.advances.get(ctx.apartmentId, id));
        if (again) return { advance: again, replayed: true };
      }
      throw mapConflict(err);
    }
    return { advance, replayed: false };
  }

  // ----- Mahsup -----

  async function offsetPreview(ctx: SupplierAdvanceContext, advanceId: string) {
    const advance = await requireAdvance(ctx, advanceId);
    const summary = await payableOf(ctx, advance.payableAccountId);
    const open = openOfAdvance(advance);
    return {
      advanceId,
      payableAccountId: advance.payableAccountId,
      advanceOpen: open,
      openBalance: toKurus(summary.openBalance),
      maxAmount: toKurus(Math.min(open, summary.openBalance)),
      openItems: summary.openItems,
    };
  }

  async function offset(ctx: SupplierAdvanceContext, advanceId: string, body: unknown): Promise<{ offset: SupplierAdvanceOffset; advance: SupplierAdvance; replayed: boolean }> {
    const o = asObject(body);
    const key = reqKey(o);
    const amount = reqAmount(o);
    const reason = reqReason(o);
    const requested = parseSettles(o.settles);
    const day = today();
    const date = optDate(o, 'date') ?? day;
    if (date > day) throw new ValidationError('Mahsup tarihi bugunden sonra olamaz', 'date');
    const idemId = `SADVO_C_${key}`;
    const fp = fingerprint({ op: 'supplier_advance_offset', advanceId, amount, reason, settles: requested ?? null, date });
    const loadOffset = (id: string) => deps.advances.getOffset(ctx.apartmentId, id);
    const prior = await replayRecord(ctx, idemId, fp, loadOffset);
    if (prior) return { offset: prior, advance: await requireAdvance(ctx, prior.advanceId), replayed: true };

    const advance = await requireAdvance(ctx, advanceId);
    if (advance.status !== 'open') throw new FinanceError('conflict', advance.status === 'reversed' ? 'Avans iptal edilmis' : 'Avansin tamami mahsup edilmis');
    const advOpen = openOfAdvance(advance);
    if (amount > advOpen) throw new FinanceError('unprocessable', `Tutar acik avansi (${advOpen} kurus) asiyor`);
    if (date < advance.date) throw new ValidationError('Mahsup tarihi avans tarihinden once olamaz', 'date');
    const [payable, advAccount] = await Promise.all([repo.getAccount(ctx.apartmentId, advance.payableAccountId), repo.getAccount(ctx.apartmentId, advance.advanceAccountId)]);
    if (!payable || payable.type !== 'payable') throw new FinanceError('not_found', 'Tedarikci hesabi bulunamadi');
    if (!advAccount || !isAdvanceAccountOf(advAccount, payable.accountId)) throw new FinanceError('conflict', 'Avans hesabi bu tedarikciye ait degil');
    const summary = await payableOf(ctx, advance.payableAccountId);
    if (summary.openBalance < 1) throw new FinanceError('unprocessable', 'Tedarikcinin mahsup edilecek acik faturasi yok');
    if (amount > summary.openBalance) throw new FinanceError('unprocessable', `Tutar tedarikcinin acik borcunu (${summary.openBalance} kurus) asiyor`);

    // Hedef faturalar: verildiyse dogrulanir, yoksa acik faturalar eskiden yeniye (FIFO).
    let settles: { transactionId: string; amount: Kurus }[];
    if (requested) {
      const total = requested.reduce((s, x) => s + x.amount, 0);
      if (total !== amount) throw new ValidationError('settles toplami tutara esit olmalidir', 'settles');
      for (const st of requested) {
        const item = summary.openItems.find((i) => i.transactionId === st.transactionId);
        if (!item) throw new ValidationError(`Fatura ${st.transactionId} bu tedarikcide acik degil`, 'settles');
        if (st.amount > item.open) throw new ValidationError(`Fatura ${st.transactionId} icin tutar acik kalani asiyor`, 'settles');
        if (date < item.date) throw new ValidationError('Mahsup tarihi mahsup edilen faturanin tarihinden once olamaz', 'date');
      }
      settles = requested;
    } else {
      settles = [];
      let left: number = amount;
      for (const item of summary.openItems) {
        if (left <= 0) break;
        const take = Math.min(left, item.open);
        settles.push({ transactionId: item.transactionId, amount: toKurus(take) });
        left -= take;
        if (date < item.date) throw new ValidationError('Mahsup tarihi mahsup edilen faturanin tarihinden once olamaz', 'date');
      }
    }

    const offsetId = shortId();
    const tx = newTx(ctx, {
      kind: 'supplier_advance_offset',
      date,
      description: `Avans mahsubu: ${payable.name}`.slice(0, 200),
      reason,
      reference: `SUPADV:${advance.advanceId}`,
      supplierAdvance: { advanceId: advance.advanceId, payableAccountId: advance.payableAccountId, offsetId, settles },
      lines: [
        { accountId: advance.payableAccountId, side: 'debit', amount },
        { accountId: advance.advanceAccountId, side: 'credit', amount },
      ],
    });
    const ts = stamp();
    const record: SupplierAdvanceOffset = {
      ...supplierAdvanceKeys.offset(ctx.apartmentId, offsetId),
      entityType: 'SUPPLIER_ADVANCE_OFFSET',
      offsetId,
      apartmentId: ctx.apartmentId,
      advanceId: advance.advanceId,
      payableAccountId: advance.payableAccountId,
      advanceAccountId: advance.advanceAccountId,
      amount,
      date,
      settles,
      transactionId: tx.transactionId,
      status: 'completed',
      reason,
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
    };
    const applied = toKurus(advance.applied + amount);
    const next: SupplierAdvance = {
      ...advance,
      applied,
      status: applied >= advance.amount ? 'applied' : 'open',
      offsetIds: [...(advance.offsetIds ?? []), offsetId],
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: advance.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [tx],
        idempotency: { id: idemId, fingerprint: fp, recordId: offsetId, transactionIds: [tx.transactionId] },
        // Acik borc / acik avans okunduktan sonra degistiyse (es zamanli odeme / mahsup) reddedilir.
        expectedVersions: { [advance.payableAccountId]: payable.version, [advance.advanceAccountId]: advAccount.version },
        newDocs: [record],
        replaceRecords: [{ item: next, expectedVersion: advance.version, label: 'supplier_advance' }],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.supplier_advance_offset',
          target: { type: 'supplier_advance', id: advance.advanceId },
          actorId: ctx.userId,
          reason,
          details: { offsetId, payableAccountId: advance.payableAccountId, amount, date, settles, transactionId: tx.transactionId, advanceOpenAfter: openOfAdvance(next) },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replayRecord(ctx, idemId, fp, loadOffset);
        if (again) return { offset: again, advance: await requireAdvance(ctx, again.advanceId), replayed: true };
      }
      throw mapConflict(err);
    }
    return { offset: record, advance: next, replayed: false };
  }

  /** Mahsubun geri alinmasi: ters kayit; avans yeniden acik, tedarikci borcu geri gelir. */
  async function reverseOffset(ctx: SupplierAdvanceContext, offsetId: string, body: unknown) {
    const reason = reqReason(asObject(body));
    const record = await requireOffset(ctx, offsetId);
    if (record.status === 'reversed') throw new FinanceError('conflict', 'Avans mahsubu zaten geri alinmis');
    const [original, advance] = await Promise.all([repo.getTransaction(ctx.apartmentId, record.transactionId), requireAdvance(ctx, record.advanceId)]);
    if (!original) throw new FinanceError('conflict', 'Mahsup islemi bulunamadi');
    const day = today();
    const rev = newTx(ctx, {
      kind: 'reversal',
      date: day,
      description: `Ters kayit: ${original.description}`,
      reversalOf: original.transactionId,
      reason,
      reference: original.reference,
      supplierAdvance: { advanceId: record.advanceId, payableAccountId: record.payableAccountId, offsetId },
      lines: original.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
    });
    const ts = stamp();
    const nextOffset: SupplierAdvanceOffset = {
      ...record,
      status: 'reversed',
      reversal: { at: ts, by: ctx.userId, reason, transactionId: rev.transactionId },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: record.version + 1,
    };
    const applied = toKurus(Math.max(0, advance.applied - record.amount));
    const nextAdvance: SupplierAdvance = {
      ...advance,
      applied,
      status: advance.status === 'reversed' ? 'reversed' : applied >= advance.amount ? 'applied' : 'open',
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: advance.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [rev],
        idempotency: { id: `SADVO_R_${offsetId}`, fingerprint: fingerprint({ op: 'supplier_advance_offset_reverse', offsetId }), recordId: offsetId, transactionIds: [rev.transactionId] },
        replaceRecords: [
          { item: nextOffset, expectedVersion: record.version, label: 'supplier_advance_offset' },
          { item: nextAdvance, expectedVersion: advance.version, label: 'supplier_advance' },
        ],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.supplier_advance_offset_reverse',
          target: { type: 'supplier_advance', id: record.advanceId },
          actorId: ctx.userId,
          reason,
          details: { offsetId, amount: record.amount, reversalTransactionId: rev.transactionId, originalTransactionId: original.transactionId },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && (err.reason === 'duplicate' || err.reason === 'precondition')) {
        throw new FinanceError('conflict', 'Avans mahsubu zaten geri alinmis veya es zamanli degisti');
      }
      throw mapConflict(err);
    }
    return { offset: nextOffset, advance: nextAdvance };
  }

  /** Hic mahsup edilmemis avansin iptali: ters kayit, para kasa/bankaya doner. */
  async function reverseAdvance(ctx: SupplierAdvanceContext, advanceId: string, body: unknown) {
    const reason = reqReason(asObject(body));
    const advance = await requireAdvance(ctx, advanceId);
    if (advance.status === 'reversed') throw new FinanceError('conflict', 'Avans zaten iptal edilmis');
    if (advance.applied > 0) throw new FinanceError('unprocessable', 'Mahsup edilmis avans iptal edilemez; once mahsuplari geri alin');
    const original = await repo.getTransaction(ctx.apartmentId, advance.transactionId);
    if (!original) throw new FinanceError('conflict', 'Avans islemi bulunamadi');
    const day = today();
    const rev = newTx(ctx, {
      kind: 'reversal',
      date: day,
      description: `Ters kayit: ${original.description}`,
      reversalOf: original.transactionId,
      reason,
      reference: original.reference,
      supplierAdvance: { advanceId, payableAccountId: advance.payableAccountId },
      lines: original.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
    });
    const ts = stamp();
    const next: SupplierAdvance = {
      ...advance,
      status: 'reversed',
      reversal: { at: ts, by: ctx.userId, reason, transactionId: rev.transactionId },
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: advance.version + 1,
    };
    try {
      await repo.postBatch({
        transactions: [rev],
        idempotency: { id: `SADV_R_${advanceId}`, fingerprint: fingerprint({ op: 'supplier_advance_reverse', advanceId }), recordId: advanceId, transactionIds: [rev.transactionId] },
        replaceRecords: [{ item: next, expectedVersion: advance.version, label: 'supplier_advance' }],
        audit: {
          apartmentId: ctx.apartmentId,
          action: 'finance.supplier_advance_reverse',
          target: { type: 'supplier_advance', id: advanceId },
          actorId: ctx.userId,
          reason,
          details: { amount: advance.amount, reversalTransactionId: rev.transactionId, originalTransactionId: original.transactionId },
        },
      });
    } catch (err) {
      if (err instanceof LedgerConflictError && (err.reason === 'duplicate' || err.reason === 'precondition')) {
        throw new FinanceError('conflict', 'Avans zaten iptal edilmis veya es zamanli degisti');
      }
      throw mapConflict(err);
    }
    return next;
  }

  // ----- Okuma -----

  const view = (a: SupplierAdvance, offsets: readonly SupplierAdvanceOffset[]) => {
    const { PK: _pk, SK: _sk, ...rest } = a;
    return {
      ...rest,
      open: openOfAdvance(a),
      offsets: offsets
        .filter((o) => o.advanceId === a.advanceId)
        .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
        .map(({ PK: _p, SK: _s, ...o }) => o),
    };
  };

  async function list(ctx: SupplierAdvanceContext, q: { payableAccountId?: string; status?: string } = {}) {
    const payableAccountId = q.payableAccountId ? assertId(q.payableAccountId, 'payableAccountId') : undefined;
    if (q.status !== undefined && !(SUPPLIER_ADVANCE_STATUSES as readonly string[]).includes(q.status)) {
      throw new ValidationError(`status su degerlerden biri olmalidir: ${SUPPLIER_ADVANCE_STATUSES.join(', ')}`, 'status');
    }
    const chosen = (await deps.advances.list(ctx.apartmentId))
      .filter((a) => a.apartmentId === ctx.apartmentId && (!payableAccountId || a.payableAccountId === payableAccountId) && (!q.status || a.status === q.status))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    // Tek tedarikci: yalnizca o avanslarin mahsuplari (kimlikle); tum site listesi: tek sorgu.
    const offsets = payableAccountId ? await offsetsOf(ctx, chosen) : (await deps.advances.listOffsets(ctx.apartmentId)).filter((o) => o.apartmentId === ctx.apartmentId);
    const items = chosen.map((a) => view(a, offsets));
    return { items, totalOpen: toKurus(items.reduce((s, a) => s + a.open, 0)) };
  }

  async function offsetsOf(ctx: SupplierAdvanceContext, advances: readonly SupplierAdvance[]): Promise<SupplierAdvanceOffset[]> {
    const ids = [...new Set(advances.flatMap((a) => a.offsetIds ?? []))];
    return (await Promise.all(ids.map((id) => deps.advances.getOffset(ctx.apartmentId, id)))).filter((o): o is SupplierAdvanceOffset => !!o && o.apartmentId === ctx.apartmentId);
  }

  async function get(ctx: SupplierAdvanceContext, advanceId: string) {
    const a = await requireAdvance(ctx, advanceId);
    return view(a, await offsetsOf(ctx, [a]));
  }

  /** Tedarikci ekstresi + acik kalemler (faturalar ve acik avanslar). */
  async function statement(ctx: SupplierAdvanceContext, payableAccountId: string, q: { from?: string; to?: string } = {}) {
    const payable = await requirePayable(ctx, payableAccountId, 'accountId');
    const from = q.from === undefined || q.from === '' ? undefined : q.from;
    const to = q.to === undefined || q.to === '' ? undefined : q.to;
    for (const [field, v] of [['from', from], ['to', to]] as const) {
      if (v !== undefined && !isIsoDate(v)) throw new ValidationError(`${field} YYYY-MM-DD olmalidir`, field);
    }
    if (from && to && from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');
    const [{ advanceAccountId, entries, txById }, all] = await Promise.all([supplierLedger(ctx, payable.accountId), deps.advances.list(ctx.apartmentId)]);
    // Ekstre mahsup kayitlarini okumaz (defter satirlari yeterli); yalnizca acik avanslar.
    const own = all.filter((a) => a.apartmentId === ctx.apartmentId && a.payableAccountId === payable.accountId).map((a) => ({ ...a, open: openOfAdvance(a) }));
    const advances = { items: own.sort((a, b) => b.date.localeCompare(a.date)), totalOpen: toKurus(own.reduce((s, a) => s + a.open, 0)) };
    const summary = payableSummary(payable.accountId, entries, txById);
    const st = buildSupplierStatement(payable.accountId, advanceAccountId, entries, txById, { ...(from ? { from } : {}), ...(to ? { to } : {}) });
    return {
      accountId: payable.accountId,
      name: payable.name,
      advanceAccountId,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...st,
      summary: {
        billed: toKurus(summary.billed),
        paid: toKurus(summary.paid),
        advanceApplied: toKurus(summary.advanceApplied),
        openBalance: toKurus(summary.openBalance),
        advanceOpen: advances.totalOpen,
        net: toKurus(summary.openBalance - advances.totalOpen),
      },
      openItems: summary.openItems,
      openAdvances: advances.items.filter((a) => a.open > 0).map((a) => ({ advanceId: a.advanceId, date: a.date, description: a.description, amount: a.amount, applied: a.applied, open: a.open })),
    };
  }

  return { create, offsetPreview, offset, reverseOffset, reverseAdvance, list, get, statement };
}

export type SupplierAdvanceService = ReturnType<typeof createSupplierAdvanceService>;
