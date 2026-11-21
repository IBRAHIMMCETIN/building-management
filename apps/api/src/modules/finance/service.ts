import { createHash, randomUUID } from 'node:crypto';
import { type DomainEvent, type NewEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import {
  type IsoDate,
  type Kurus,
  type LiableParty,
  type MonthlyDuesPlan,
  type Unit,
  toKurus,
} from '../core/types.js';
import {
  type Obj,
  ValidationError,
  asObject,
  assertId,
  isIsoDate,
  optString,
  reqEnum,
  reqInt,
  reqString,
} from '../core/validation.js';
import {
  type FinanceRepository,
  InvalidCursorError,
  LedgerConflictError,
  type ReplaceRecord,
  financeKeys,
  financeRepository,
} from './repository.js';
import {
  cancelledTransactions,
  feeLedgerFor,
  isPeriod,
  nextPeriod,
  periodBounds,
  periodLabel,
  unpostedLateFee,
} from './lateFee.js';
import { buildDueReminders, buildDuesStatus, buildFormerAccounts, buildSummary, toTransactionView } from './reports.js';
import {
  ACCOUNT_TYPES,
  type Account,
  type Expense,
  type ExpenseInvoice,
  type Payment,
  PAYMENT_METHODS,
  type PaymentMethod,
  type Transaction,
  type TransactionLine,
  mainReceivableId,
} from './types.js';
import type { MembershipRepository } from '../memberships/repository.js';
import { type Occupancy, VACANT_SUFFIX, liablePartyFor, occupancyOn } from './occupancy.js';

// ---------------------------------------------------------------------------
// Hatalar ve sabitler
// ---------------------------------------------------------------------------

export type FinanceErrorCode =
  | 'not_found'
  | 'conflict'
  | 'idempotency_conflict'
  | 'insufficient_funds'
  | 'unprocessable';

const HTTP_STATUS = {
  not_found: 404,
  conflict: 409,
  idempotency_conflict: 409,
  insufficient_funds: 422,
  unprocessable: 422,
} as const satisfies Record<FinanceErrorCode, 404 | 409 | 422>;

export class FinanceError extends Error {
  readonly code: FinanceErrorCode;
  readonly httpStatus: 404 | 409 | 422;

  constructor(code: FinanceErrorCode, message: string) {
    super(message);
    this.name = 'FinanceError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** Para tutari ust siniri: 999.999.999,99 TL (kurus). */
export const MAX_AMOUNT = 99_999_999_999;
export const MAX_BULK_UNITS = 500;
const MAX_ATTEMPTS = 4;

export const SYSTEM_ACCOUNTS = {
  cash: 'cash',
  bank: 'bank',
  incomeDues: 'income-dues',
  incomeLateFee: 'income-late-fee',
  payable: 'payable',
  openingBalance: 'opening-balance',
  /**
   * Online (kartla) tahsilatlarin gecis hesabi: saglayici (iyzico) parayi apartmanin IBAN'ina
   * aktarana kadar burada bekler. Banka hesabina aktarim (settlement) mutabakati sonraki fazda.
   */
  onlineCollection: 'online-collection',
  /**
   * Online tahsilat komisyon gideri (Online Odeme v2 · P1): platform payi + tahmini POS maliyeti.
   * Komisyonu apartman yonetimi oder (sakine yansitilmaz); `online-collection` bakiyesi boylece
   * apartmanin IBAN'ina aktarilacak tutara esit kalir.
   */
  onlineCollectionFee: 'exp-online-collection-fee',
  /**
   * Cari devri ara hesabi (tasinmada kapama): kapama ve acilis islemleri bu hesap uzerinden
   * dengelenir; bakiyesi her zaman sifirdir. Ilk kapamada olusturulur.
   */
  transferClearing: 'transfer-clearing',
} as const;

/** KMK m.20 varsayilani: aylik %5. Apartman ayari okunamazsa kullanilir. */
export const DEFAULT_LATE_FEE_BASIS_POINTS = 500;

/** Zamanlanmis gorevlerin defter kayitlarindaki kullanici kimligi. */
export const SYSTEM_ACTOR = 'system-scheduler';

/**
 * Varsayilan gider kalemleri (KMK isletme giderleri). Sistem hesabi DEGILDIR: yonetici
 * yeniden adlandirabilir veya pasife alabilir; yalnizca eksikse olusturulur.
 */
export const DEFAULT_EXPENSE_ACCOUNTS = [
  { accountId: 'exp-cleaning', name: 'Temizlik' },
  { accountId: 'exp-elevator', name: 'Asansör Bakımı' },
  { accountId: 'exp-electricity', name: 'Ortak Elektrik' },
  { accountId: 'exp-water', name: 'Ortak Su' },
  { accountId: 'exp-heating', name: 'Isınma / Doğalgaz' },
  { accountId: 'exp-staff', name: 'Personel / Kapıcı' },
  { accountId: 'exp-security', name: 'Güvenlik' },
  { accountId: 'exp-garden', name: 'Bahçe Bakımı' },
  { accountId: 'exp-repair', name: 'Tamir / Onarım' },
  { accountId: 'exp-management', name: 'Yönetim Giderleri' },
  { accountId: 'exp-other', name: 'Diğer Giderler' },
] as const;

export const MAX_TRANSACTION_PAGE = 200;

export const DUES_DISTRIBUTION_KEYS = ['equal', 'area', 'land_share'] as const;
export type DuesDistributionKey = (typeof DUES_DISTRIBUTION_KEYS)[number];

const LIABLE_PARTIES = ['owner', 'occupant'] as const;
const EDITABLE_ACCOUNT_TYPES = ['cash', 'bank', 'income', 'expense', 'payable'] as const;

export type FinanceContext = { apartmentId: string; userId: string };

/** Online odemede alt cari basina tahsilat. `amount` alt cariye alacak yazilan toplamdir. */
export type OnlinePaymentAllocation = {
  liableParty: LiableParty;
  amount: Kurus;
  /** `amount`'un icindeki, odeme aninda kesinlestirilen gecikme tazminati (0 olabilir). */
  lateFee: Kurus;
};

export type OnlinePaymentInput = {
  intentId: string;
  unitId: string;
  paidAt: IsoDate;
  provider: string;
  providerPaymentId: string;
  payerName?: string;
  allocations: OnlinePaymentAllocation[];
  /**
   * Apartmanin komisyon gideri (platform payi + tahmini POS maliyeti, kurus). 0/yok ise gider
   * kaydi yazilmaz. Tahsilatla ayni atomik yazimda: borc `exp-online-collection-fee` / alacak
   * `online-collection`.
   */
  commission?: Kurus;
  /**
   * Odeme niyetinin sonuclanmis hali (ayni atomik yazimda, surum kosuluyla). Makbuz ve islem
   * kimlikleri burada uretildigi icin fonksiyon olarak verilir.
   */
  intentUpdate: (r: { payments: Payment[]; transactions: Transaction[] }) => ReplaceRecord;
};

export type FinanceServiceDeps = {
  repository: FinanceRepository;
  /** `getSite` gecikme tazminati oranini okumak icin (yoksa varsayilan %5). */
  core: Pick<CoreRepository, 'getUnit' | 'listUnits'> & Partial<Pick<CoreRepository, 'getSite'>>;
  now: () => Date;
  newId: () => string;
  /**
   * Gider faturasi: gecici yuklemeyi dogrulayip kalici yere tasir (documents modulu).
   * Verilmezse fatura ekli gider reddedilir.
   */
  /**
   * Bos daire kurali icin uyelikler (tahakkuk tarihinde dairede kim oturuyor). Verilmezse kural
   * uygulanmaz (testler / eski cagiranlar); uygulama (app.ts) uyelik deposunu verir.
   */
  memberships?: Pick<MembershipRepository, 'list'>;
  attachments?: {
    promote(
      apartmentId: string,
      upload: { uploadId: string; fileName: string },
      target: { expenseId: string; date: IsoDate },
    ): Promise<ExpenseInvoice>;
  };
};

// ---------------------------------------------------------------------------
// Saf hesaplama: dagitim (en buyuk kalan yontemi) - BigInt, kayan nokta yok
// ---------------------------------------------------------------------------

/**
 * `total` kurusu agirliklarla bolustururken toplamin KURUSUNA KADAR korunmasini saglar:
 * once taban pay, kalan kuruslar en buyuk kalana sahip paylara (esitlikte dizin sirasina)
 * birer birer verilir.
 */
export function distributeKurus(total: number, weights: bigint[]): number[] {
  if (!Number.isSafeInteger(total) || total < 0) throw new Error('Gecersiz toplam tutar');
  if (weights.length === 0) throw new Error('En az bir agirlik gerekli');
  const sum = weights.reduce((a, b) => a + b, 0n);
  if (weights.some((w) => w < 0n) || sum <= 0n) throw new Error('Agirliklar pozitif olmali');

  const t = BigInt(total);
  const shares = weights.map((w) => (t * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (t * w) % sum }));
  let leftover = Number(t - shares.reduce((a, b) => a + b, 0n));
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const out = shares.map(Number);
  for (const { i } of remainders) {
    if (leftover <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    leftover--;
  }
  return out;
}

const LAND_SHARE_SCALE = 1_000_000_000_000n;

function unitWeight(unit: Unit, key: DuesDistributionKey): bigint {
  switch (key) {
    case 'equal':
      return 1n;
    case 'area':
      return BigInt(unit.grossAreaTenthsM2);
    case 'land_share': {
      const ls = unit.landShare;
      if (!ls || ls.denominator <= 0 || ls.numerator <= 0) {
        throw new FinanceError('unprocessable', `Bagimsiz bolumun arsa payi tanimli degil: ${unit.unitId}`);
      }
      return (BigInt(ls.numerator) * LAND_SHARE_SCALE) / BigInt(ls.denominator);
    }
  }
}

/**
 * Gider kalemi (muafiyet kategorisi): `elevator`, `playground`, `pool` gibi kucuk harf kod.
 * Bagimsiz bolum muafiyetleri (`Unit.exemptions[].expenseCategory`) ayni kodla eslesir.
 */
const EXPENSE_CATEGORY = /^[a-z0-9_-]{2,50}$/;

function parseExpenseCategory(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!EXPENSE_CATEGORY.test(v)) {
    throw new ValidationError('expenseCategory 2-50 karakter, kucuk harf/rakam/-/_ olmalidir', 'expenseCategory');
  }
  return v;
}

/** Bolumun `date` tarihinde gecerli (validFrom/validTo dahil) `category` muafiyeti. */
function activeExemption(unit: Unit, category: string, date: IsoDate) {
  return (unit.exemptions ?? []).find(
    (e) =>
      e.expenseCategory.trim().toLowerCase() === category &&
      (!e.validFrom || e.validFrom <= date) &&
      (!e.validTo || date <= e.validTo),
  );
}

// ---------------------------------------------------------------------------
// Girdi dogrulama
// ---------------------------------------------------------------------------

function reqKey(o: Obj): string {
  return assertId(o.idempotencyKey, 'idempotencyKey');
}

function reqAmount(o: Obj, key: string): Kurus {
  return toKurus(reqInt(o, key, 1, MAX_AMOUNT));
}

function reqDate(o: Obj, key: string): IsoDate {
  const v = reqString(o, key, 10, 10);
  if (!isIsoDate(v)) throw new ValidationError(`${key} gecerli bir tarih (YYYY-MM-DD) olmali`, key);
  return v;
}

function optDate(o: Obj, key: string): IsoDate | undefined {
  return o[key] === undefined ? undefined : reqDate(o, key);
}

const fingerprint = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const compact = (d: IsoDate) => d.replaceAll('-', '');

/** Ozet olay basina kalem (SNS 256 KB / DynamoDB 400 KB siniri icin genis pay). */
export const BATCH_SUMMARY_CHUNK = 400;

const receivableId = mainReceivableId;

function parseInvoiceUpload(value: unknown): { uploadId: string; fileName: string } | undefined {
  if (value === undefined || value === null) return undefined;
  const o = asObject(value, 'invoiceUpload');
  return { uploadId: assertId(o.uploadId, 'invoiceUpload.uploadId'), fileName: reqString(o, 'fileName', 255) };
}

// ---------------------------------------------------------------------------
// Servis
// ---------------------------------------------------------------------------

export function createFinanceService(overrides: Partial<FinanceServiceDeps> = {}) {
  const deps: FinanceServiceDeps = {
    repository: financeRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
  };
  const repo = deps.repository;
  /**
   * Domain olaylari (DUE_GENERATED, PAYMENT_RECEIVED, LATE_FEE_POSTED) dogrudan yayinlanmaz:
   * defter yazimiyla AYNI atomik islemde outbox'a yazilir (`postBatch({ outbox })`), yayini
   * relay yapar. Tekrar (replay) isteklerinde yazim olmadigi icin yeni olay da olusmaz.
   */
  const toEvent = (e: NewEvent): DomainEvent => buildEvent(e, deps.now) as DomainEvent;
  const ensuredSystem = new Set<string>();

  const stamp = () => deps.now().toISOString();
  const today = (): IsoDate =>
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(deps.now());

  function newAccount(
    ctx: FinanceContext,
    base: Pick<Account, 'accountId' | 'type' | 'name'> & Partial<Account>,
  ): Account {
    const ts = stamp();
    return {
      ...financeKeys.account(ctx.apartmentId, base.accountId),
      entityType: 'ACCOUNT',
      siteId: ctx.apartmentId,
      status: 'active',
      balance: toKurus(0),
      createdAt: ts,
      createdBy: ctx.userId,
      updatedAt: ts,
      updatedBy: ctx.userId,
      version: 1,
      ...base,
    };
  }

  async function ensureSystemAccounts(ctx: FinanceContext): Promise<void> {
    if (ensuredSystem.has(ctx.apartmentId)) return;
    await repo.ensureAccounts([
      newAccount(ctx, { accountId: SYSTEM_ACCOUNTS.cash, type: 'cash', name: 'Kasa', system: true }),
      newAccount(ctx, { accountId: SYSTEM_ACCOUNTS.bank, type: 'bank', name: 'Banka', system: true }),
      newAccount(ctx, {
        accountId: SYSTEM_ACCOUNTS.incomeDues,
        type: 'income',
        name: 'Aidat Gelirleri',
        system: true,
      }),
      newAccount(ctx, {
        accountId: SYSTEM_ACCOUNTS.incomeLateFee,
        type: 'income',
        name: 'Gecikme Tazminati Gelirleri',
        system: true,
      }),
      newAccount(ctx, {
        accountId: SYSTEM_ACCOUNTS.openingBalance,
        type: 'equity',
        name: 'Açılış / Devir Bakiyeleri',
        system: true,
      }),
      newAccount(ctx, {
        accountId: SYSTEM_ACCOUNTS.payable,
        type: 'payable',
        name: 'Tedarikci Borclari',
        system: true,
      }),

      ...DEFAULT_EXPENSE_ACCOUNTS.map((e) => newAccount(ctx, { ...e, type: 'expense' })),
    ]);
    ensuredSystem.add(ctx.apartmentId);
  }

  function receivable(ctx: FinanceContext, unitId: string, party: LiableParty): Account {
    return newAccount(ctx, {
      accountId: receivableId(unitId, party),
      type: 'receivable',
      name: `Daire ${unitId} - ${party === 'owner' ? 'Kat Maliki' : 'Kiraci/Sakin'}`,
      unitId,
      liableParty: party,
    });
  }

  async function requireUnit(ctx: FinanceContext, unitId: string): Promise<Unit> {
    const unit = await deps.core.getUnit(ctx.apartmentId, unitId);
    if (!unit) throw new FinanceError('not_found', 'Bagimsiz bolum bulunamadi');
    return unit;
  }

  function buildTx(
    ctx: FinanceContext,
    p: {
      kind: Transaction['kind'];
      date: IsoDate;
      description: string;
      lines: TransactionLine[];
      dueDate?: IsoDate;
      reference?: string;
      batchId?: string;
      reversalOf?: string;
      reason?: string;
      invoice?: Transaction['invoice'];
      vacant?: true;
    },
  ): Transaction {
    const transactionId = `${compact(p.date)}-${deps.newId()}`;
    const total = p.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0);
    return {
      ...financeKeys.transaction(ctx.apartmentId, transactionId),
      entityType: 'TRANSACTION',
      transactionId,
      siteId: ctx.apartmentId,
      kind: p.kind,
      date: p.date,
      dueDate: p.dueDate,
      description: p.description,
      reference: p.reference,
      batchId: p.batchId,
      reversalOf: p.reversalOf,
      reason: p.reason,
      invoice: p.invoice,
      ...(p.vacant ? { vacant: p.vacant } : {}),
      lines: p.lines,
      totalAmount: toKurus(total),
      createdAt: stamp(),
      createdBy: ctx.userId,
    };
  }

  /**
   * Idempotent yazim: ayni anahtar + ayni icerik -> onceki sonuc (replay); ayni anahtar +
   * farkli icerik -> 409. Yeni yazimda `true` doner.
   */
  async function replayOf(
    ctx: FinanceContext,
    idemId: string,
    fp: string,
  ): Promise<{ transactionId: string; recordId?: string } | undefined> {
    const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
    if (!existing) return undefined;
    if (existing.fingerprint !== fp) {
      throw new FinanceError('idempotency_conflict', 'Bu idempotencyKey farkli bir istekle kullanilmis');
    }
    return { transactionId: existing.transactionId, recordId: existing.recordId };
  }

  // -------------------------------------------------------------------------
  // Hesaplar
  // -------------------------------------------------------------------------

  async function listAccounts(ctx: FinanceContext, type?: string): Promise<Account[]> {
    if (type !== undefined && !(ACCOUNT_TYPES as readonly string[]).includes(type)) {
      throw new ValidationError(`type su degerlerden biri olmalidir: ${ACCOUNT_TYPES.join(', ')}`, 'type');
    }
    await ensureSystemAccounts(ctx);
    const all = await repo.listAccounts(ctx.apartmentId);
    return type ? all.filter((a) => a.type === type) : all;
  }

  async function createAccount(ctx: FinanceContext, body: unknown): Promise<Account> {
    const o = asObject(body);
    const type = reqEnum(o, 'type', EDITABLE_ACCOUNT_TYPES);
    const accountId = o.accountId === undefined ? deps.newId() : assertId(o.accountId, 'accountId');
    const account = newAccount(ctx, { accountId, type, name: reqString(o, 'name', 120) });
    try {
      await repo.createAccount(account);
    } catch (err) {
      if (isConditionalFailure(err)) throw new FinanceError('conflict', 'Bu hesap kimligi zaten var');
      throw err;
    }
    return account;
  }

  async function updateAccount(ctx: FinanceContext, accountId: string, body: unknown): Promise<Account> {
    assertId(accountId, 'accountId');
    const o = asObject(body);
    const existing = await repo.getAccount(ctx.apartmentId, accountId);
    if (!existing) throw new FinanceError('not_found', 'Hesap bulunamadi');
    const name = o.name === undefined ? existing.name : reqString(o, 'name', 120);
    const status = o.status === undefined ? existing.status : reqEnum(o, 'status', ['active', 'inactive'] as const);
    if (existing.system && status === 'inactive') {
      throw new FinanceError('unprocessable', 'Sistem hesabi pasife alinamaz');
    }
    if (status === 'inactive' && existing.balance !== 0) {
      throw new FinanceError('unprocessable', 'Bakiyesi sifir olmayan hesap pasife alinamaz');
    }
    const updated: Account = { ...existing, name, status, updatedAt: stamp(), updatedBy: ctx.userId };
    try {
      await repo.updateAccount(updated, existing.version);
    } catch (err) {
      if (isConditionalFailure(err)) throw new FinanceError('conflict', 'Hesap baska biri tarafindan degistirildi');
      throw err;
    }
    return { ...updated, version: existing.version + 1 };
  }

  // -------------------------------------------------------------------------
  // Aidat tahakkuku (tekil / toplu)
  // -------------------------------------------------------------------------

  /** liableParty: gercekte borclanan taraf; vacant: bos daire kuraliyla malike yazildi. */
  type DuesResult = { transaction: Transaction; replayed: boolean; liableParty: LiableParty; vacant: boolean };

  /**
   * Bos daire kurali: `date` gununde dairelerin doluluk durumu. Uyelik deposu verilmemisse
   * herkes `unknown` (kural kapali).
   */
  async function occupancyResolver(ctx: FinanceContext, unitId?: string): Promise<(unitId: string, date: IsoDate) => Occupancy> {
    if (!deps.memberships) return () => 'unknown';
    const list = await deps.memberships.list(ctx.apartmentId, unitId ? { unitId } : {});
    const mine = list.filter((m) => m.apartmentId === ctx.apartmentId);
    return (id, date) => occupancyOn(mine, id, date);
  }

  /** Islemin borclu satirindaki taraf (replay'de kayittan okunur). */
  const chargedParty = (tx: Transaction, fallback: LiableParty): LiableParty =>
    tx.lines.find((l) => l.side === 'debit' && l.liableParty)?.liableParty ?? fallback;

  async function postDues(
    ctx: FinanceContext,
    p: {
      idemId: string;
      fp: string;
      unitId: string;
      party: LiableParty;
      amount: Kurus;
      date: IsoDate;
      dueDate: IsoDate;
      description: string;
      batchId?: string;
      /** Bos daire kurali: `party` malik, istenen taraf sakin idi. */
      vacant?: boolean;
      /** Yazimla ayni atomik islemde outbox'a yazilacak olay (islem kimligi belli olunca uretilir). */
      event?: (tx: Transaction) => NewEvent;
    },
  ): Promise<DuesResult> {
    const replayed = async (transactionId: string): Promise<DuesResult> => {
      const t = await loadTx(ctx, transactionId);
      return { transaction: t, replayed: true, liableParty: chargedParty(t, p.party), vacant: t.vacant === true };
    };
    const replay = await replayOf(ctx, p.idemId, p.fp);
    if (replay) return replayed(replay.transactionId);

    const recv = receivable(ctx, p.unitId, p.party);
    await repo.ensureAccounts([recv]);
    const tx = buildTx(ctx, {
      kind: 'dues_charge',
      date: p.date,
      dueDate: p.dueDate,
      description: p.vacant ? `${p.description}${VACANT_SUFFIX}` : p.description,
      batchId: p.batchId,
      ...(p.vacant ? { vacant: true as const } : {}),
      lines: [
        { accountId: recv.accountId, side: 'debit', amount: p.amount, unitId: p.unitId, liableParty: p.party },
        { accountId: SYSTEM_ACCOUNTS.incomeDues, side: 'credit', amount: p.amount },
      ],
    });
    try {
      await repo.postTransaction({
        transaction: tx,
        idempotency: { id: p.idemId, fingerprint: p.fp },
        ...(p.event ? { outbox: [toEvent(p.event(tx))] } : {}),
      });
      return { transaction: tx, replayed: false, liableParty: p.party, vacant: p.vacant === true };
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replayOf(ctx, p.idemId, p.fp);
        if (again) return replayed(again.transactionId);
      }
      throw mapConflict(err);
    }
  }

  async function loadTx(ctx: FinanceContext, transactionId: string): Promise<Transaction> {
    const tx = await repo.getTransaction(ctx.apartmentId, transactionId);
    if (!tx) throw new FinanceError('not_found', 'Islem bulunamadi');
    return tx;
  }

  /** Tek bir bagimsiz bolume aidat/borc tahakkuku. */
  async function chargeUnit(ctx: FinanceContext, body: unknown): Promise<DuesResult> {
    const o = asObject(body);
    const key = reqKey(o);
    const unitId = assertId(o.unitId, 'unitId');
    const party = reqEnum(o, 'liableParty', LIABLE_PARTIES);
    const amount = reqAmount(o, 'amount');
    const date = optDate(o, 'date') ?? today();
    const dueDate = reqDate(o, 'dueDate');
    const description = reqString(o, 'description', 200);

    const unit = await requireUnit(ctx, unitId);
    if (unit.status !== 'active') throw new FinanceError('unprocessable', 'Bagimsiz bolum aktif degil');
    await ensureSystemAccounts(ctx);
    const target = party === 'occupant' ? liablePartyFor(party, (await occupancyResolver(ctx, unitId))(unitId, date)) : { party, vacant: false };

    const result = await postDues(ctx, {
      // Parmak izi istenen tarafla hesaplanir: ayni istek, doluluk degisse de ayni istektir.
      idemId: key,
      fp: fingerprint({ op: 'dues', unitId, party, amount, date, dueDate, description }),
      unitId,
      party: target.party,
      vacant: target.vacant,
      amount,
      date,
      dueDate,
      description,
      // Olay defter kaydiyla ayni atomik yazimda outbox'a girer; replay'de yazim (ve olay) yok.
      event: (tx) => ({
        eventId: `DUE_GENERATED:${tx.transactionId}`,
        type: 'DUE_GENERATED',
        apartmentId: ctx.apartmentId,
        actorId: ctx.userId,
        groupKey: unitId,
        payload: {
          mode: 'single',
          date,
          dueDate,
          description,
          liableParty: target.party,
          totalAmount: amount,
          items: [{ unitId, amount, transactionId: tx.transactionId, liableParty: target.party }],
        },
      }),
    });
    return result;
  }

  /**
   * Toplu tahakkuk: toplam tutar dagitim anahtarina gore bolunur; her bagimsiz bolum icin
   * AYRI atomik islem yazilir (idempotency anahtari `<key>_<unitId>`), bu sayede yarim kalan
   * bir istek ayni anahtarla tekrar gonderilerek guvenle tamamlanir.
   */
  /**
   * Toplu tahakkukun plani (yazmaz): kapsam (`blockIds` / `unitIds`, ikisi birlikte verilirse
   * kesisimi), gider kalemi muafiyetleri ve paylar. Gider kalemi (`expenseCategory`, ornegin
   * `elevator`) verilirse, tahakkuk tarihinde o kalemden muaf olan bagimsiz bolumler dagitima
   * girmez; tutar kalanlar arasinda dagitilir (KMK: muaf bolum o giderden pay almaz).
   */
  async function planBulk(ctx: FinanceContext, o: Obj) {
    const party = reqEnum(o, 'liableParty', LIABLE_PARTIES);
    const totalAmount = reqInt(o, 'totalAmount', 1, MAX_AMOUNT);
    const distributionKey = reqEnum(o, 'distributionKey', DUES_DISTRIBUTION_KEYS);
    const date = optDate(o, 'date') ?? today();
    const dueDate = reqDate(o, 'dueDate');
    const description = reqString(o, 'description', 200);
    const unitIds = o.unitIds === undefined ? undefined : parseIdList(o.unitIds, 'unitIds');
    const blockIds = o.blockIds === undefined ? undefined : parseIdList(o.blockIds, 'blockIds');
    const expenseCategory = parseExpenseCategory(o.expenseCategory);

    const active = (await deps.core.listUnits(ctx.apartmentId))
      .filter((u) => u.status === 'active')
      .sort((a, b) => a.unitId.localeCompare(b.unitId));
    if (unitIds) {
      const found = new Set(active.map((u) => u.unitId));
      const missing = unitIds.filter((id) => !found.has(id));
      if (missing.length) throw new FinanceError('not_found', `Aktif bagimsiz bolum bulunamadi: ${missing.join(', ')}`);
    }
    const scoped = active.filter(
      (u) => (!unitIds || unitIds.includes(u.unitId)) && (!blockIds || blockIds.includes(u.blockId)),
    );

    const included: Unit[] = [];
    const exempt: { unitId: string; blockId: string; number: string; reason?: string }[] = [];
    for (const unit of scoped) {
      const exemption = expenseCategory ? activeExemption(unit, expenseCategory, date) : undefined;
      if (exemption) exempt.push({ unitId: unit.unitId, blockId: unit.blockId, number: unit.number, reason: exemption.reason });
      else included.push(unit);
    }
    if (included.length > MAX_BULK_UNITS) {
      throw new ValidationError(`Tek istekte en fazla ${MAX_BULK_UNITS} bagimsiz bolum`, 'unitIds');
    }
    const shares = included.length ? distributeKurus(totalAmount, included.map((u) => unitWeight(u, distributionKey))) : [];

    // Bos daire kurali (yalnizca sakin tarafi): pay dagitimi degismez, yalnizca borclu taraf.
    const occupancy = party === 'occupant' ? await occupancyResolver(ctx) : () => 'occupied' as Occupancy;
    const targets = included.map((u) => liablePartyFor(party, occupancy(u.unitId, date)));
    const brief = (u: Unit) => ({ unitId: u.unitId, blockId: u.blockId, number: u.number });
    const vacant = included.filter((_, i) => targets[i]?.vacant).map(brief);
    const unknownOccupancy = party === 'occupant' ? included.filter((u) => occupancy(u.unitId, date) === 'unknown').map(brief) : [];

    // Kapsam/muafiyet varsa idempotency parmak izine girer: ayni anahtar farkli kapsamla
    // kullanilirsa 409 doner. Kapsamsiz isteklerin parmak izi eskisiyle aynidir.
    const scopeFp = {
      ...(blockIds ? { blockIds: [...blockIds].sort() } : {}),
      ...(expenseCategory ? { expenseCategory } : {}),
    };
    return {
      party,
      totalAmount,
      distributionKey,
      date,
      dueDate,
      description,
      expenseCategory,
      included,
      shares,
      targets,
      vacant,
      unknownOccupancy,
      exempt,
      scopeFp,
    };
  }

  /** Onizleme: toplu tahakkukta kime ne kadar dusecegi ve kimin neden muaf oldugu. Yazmaz. */
  async function previewBulk(ctx: FinanceContext, body: unknown) {
    const plan = await planBulk(ctx, asObject(body));
    const items = plan.included.map((u, i) => ({
      unitId: u.unitId,
      blockId: u.blockId,
      number: u.number,
      amount: toKurus(plan.shares[i] ?? 0),
      liableParty: plan.targets[i]?.party ?? plan.party,
    }));
    return {
      distributionKey: plan.distributionKey,
      expenseCategory: plan.expenseCategory,
      totalAmount: toKurus(plan.totalAmount),
      distributedAmount: toKurus(items.reduce((s, i) => s + i.amount, 0)),
      count: items.length,
      items,
      exempt: plan.exempt,
      /** Bos daire kuraliyla kat malikine yazilacak bolumler. */
      vacant: plan.vacant,
      /** Tahakkuk tarihinde uyelik kaydi olmayan (kural uygulanamayan) bolumler. */
      unknownOccupancy: plan.unknownOccupancy,
    };
  }

  async function chargeBulk(ctx: FinanceContext, body: unknown) {
    const o = asObject(body);
    const key = reqKey(o);
    const plan = await planBulk(ctx, o);
    const { party, totalAmount, distributionKey, date, dueDate, description, shares } = plan;
    const units = plan.included;
    if (units.length === 0) {
      throw new FinanceError(
        'unprocessable',
        plan.exempt.length ? 'Kapsamdaki tum bagimsiz bolumler bu gider kaleminden muaf' : 'Tahakkuk icin aktif bagimsiz bolum yok',
      );
    }
    await ensureSystemAccounts(ctx);

    const batchId = `${compact(date)}-${key}`;
    const results: { unitId: string; amount: Kurus; transactionId: string; replayed: boolean; liableParty: LiableParty; vacant: boolean }[] = [];
    for (const [i, unit] of units.entries()) {
      const amount = shares[i] ?? 0;
      if (amount < 1) continue; // cok kucuk pay: 0 kurus borc yazilmaz
      const liable = plan.targets[i]?.party ?? party;
      const r = await postDues(ctx, {
        idemId: `${key}_${unit.unitId}`,
        fp: fingerprint({ op: 'bulk', unitId: unit.unitId, party, amount, date, dueDate, description, distributionKey, totalAmount, ...plan.scopeFp }),
        unitId: unit.unitId,
        party: liable,
        vacant: plan.targets[i]?.vacant ?? false,
        amount: toKurus(amount),
        date,
        dueDate,
        description,
        batchId,
        // Kalem basina olay, kalemin defter kaydiyla ayni atomik yazimda: istek yarida kesilse
        // de yazilan her kalemin olayi vardir. Bildirim tarafi `batchId` ile kullanici bazinda
        // tek ozet halinde birlestirir.
        event: (tx) => ({
          eventId: `DUE_GENERATED:${tx.transactionId}`,
          type: 'DUE_GENERATED',
          apartmentId: ctx.apartmentId,
          actorId: ctx.userId,
          groupKey: unit.unitId,
          payload: {
            mode: 'bulk',
            batchId,
            date,
            dueDate,
            description,
            liableParty: party,
            totalAmount: toKurus(amount),
            items: [{ unitId: unit.unitId, amount: toKurus(amount), transactionId: tx.transactionId, liableParty: liable }],
          },
        }),
      });
      results.push({
        unitId: unit.unitId,
        amount: toKurus(amount),
        transactionId: r.transaction.transactionId,
        replayed: r.replayed,
        liableParty: r.liableParty,
        vacant: r.vacant,
      });
    }

    // Tek ozet olay (bildirim): tum kalemler yazildiktan SONRA. Istek yarida kesilirse ozet
    // yazilmaz; ayni anahtarla tamamlama (replay dahil) TUM kalemlerle ozeti yazar. Kimlik
    // deterministik oldugundan tekrar eden istek ikinci ozet uretmez.
    if (results.length > 0) {
      const parts = Math.ceil(results.length / BATCH_SUMMARY_CHUNK);
      const events: DomainEvent[] = [];
      for (let part = 1; part <= parts; part++) {
        const chunk = results.slice((part - 1) * BATCH_SUMMARY_CHUNK, part * BATCH_SUMMARY_CHUNK);
        events.push(
          toEvent({
            eventId: parts === 1 ? `DUES_BATCH_SUMMARY:${batchId}` : `DUES_BATCH_SUMMARY:${batchId}:${part}`,
            type: 'DUES_BATCH_SUMMARY',
            apartmentId: ctx.apartmentId,
            actorId: ctx.userId,
            payload: {
              batchId,
              part,
              parts,
              date,
              dueDate,
              description,
              liableParty: party,
              totalAmount: toKurus(chunk.reduce((sum, r) => sum + r.amount, 0)),
              items: chunk.map(({ unitId, amount, transactionId, liableParty }) => ({ unitId, amount, transactionId, liableParty })),
            },
          }),
        );
      }
      await repo.recordEvents(ctx.apartmentId, events);
    }

    return {
      batchId,
      distributionKey,
      totalAmount: toKurus(totalAmount),
      distributedAmount: toKurus(results.reduce((s, r) => s + r.amount, 0)),
      count: results.length,
      replayed: results.length > 0 && results.every((r) => r.replayed),
      items: results,
      ...(plan.expenseCategory ? { expenseCategory: plan.expenseCategory } : {}),
      exempt: plan.exempt,
      vacant: results.filter((r) => r.vacant).map((r) => plan.vacant.find((v) => v.unitId === r.unitId) ?? { unitId: r.unitId }),
    };
  }

  function parseIdList(value: unknown, field: 'unitIds' | 'blockIds'): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_BULK_UNITS) {
      throw new ValidationError(`${field} 1-${MAX_BULK_UNITS} ogeli dizi olmalidir`, field);
    }
    return [...new Set(value.map((v, i) => assertId(v, `${field}[${i}]`)))];
  }

  /** `dues` govdesinde `unitId` varsa tekil, yoksa toplu tahakkuk. */
  async function charge(ctx: FinanceContext, body: unknown) {
    const o = asObject(body);
    if (o.unitId !== undefined) return { mode: 'single' as const, ...(await chargeUnit(ctx, body)) };
    return { mode: 'bulk' as const, ...(await chargeBulk(ctx, body)) };
  }

  // -------------------------------------------------------------------------
  // Tahsilat
  // -------------------------------------------------------------------------

  async function recordPayment(ctx: FinanceContext, body: unknown) {
    const o = asObject(body);
    const key = reqKey(o);
    const unitId = assertId(o.unitId, 'unitId');
    // Ayrilan sakin/malik carisinden tahsilat: `accountId` (taraf hesaptan gelir).
    const accountId = o.accountId === undefined ? undefined : assertId(o.accountId, 'accountId');
    const target = accountId ? await repo.getAccount(ctx.apartmentId, accountId) : undefined;
    if (accountId && (!target || target.type !== 'receivable' || target.unitId !== unitId || !target.liableParty)) {
      throw new ValidationError('accountId bu daireye ait bir cari hesap olmali', 'accountId');
    }
    const party: LiableParty = target?.liableParty ?? reqEnum(o, 'liableParty', LIABLE_PARTIES);
    if (target && o.liableParty !== undefined && o.liableParty !== party) {
      throw new ValidationError('liableParty secilen cari hesapla uyusmuyor', 'liableParty');
    }
    const former = target && target.accountId !== receivableId(unitId, party) ? target : undefined;
    const amount = reqAmount(o, 'amount');
    const method: PaymentMethod = reqEnum(o, 'method', PAYMENT_METHODS);
    const paidAt = optDate(o, 'paidAt') ?? today();
    const payerName = optString(o, 'payerName', 120);
    const note = optString(o, 'note', 300);
    const depositAccountId =
      o.depositAccountId === undefined
        ? method === 'cash'
          ? SYSTEM_ACCOUNTS.cash
          : SYSTEM_ACCOUNTS.bank
        : assertId(o.depositAccountId, 'depositAccountId');

    const fp = fingerprint({
      op: 'payment',
      unitId,
      party,
      amount,
      method,
      paidAt,
      depositAccountId,
      payerName,
      note,
      // Ana cariye tahsilatin parmak izi eskisiyle ayni kalir.
      ...(former ? { accountId: former.accountId } : {}),
    });
    const replay = await replayOf(ctx, key, fp);
    if (replay) return paymentResult(ctx, replay, true);

    const unit = await requireUnit(ctx, unitId);
    if (unit.status !== 'active') throw new FinanceError('unprocessable', 'Bagimsiz bolum aktif degil');
    await ensureSystemAccounts(ctx);

    const deposit = await repo.getAccount(ctx.apartmentId, depositAccountId);
    if (!deposit) throw new FinanceError('not_found', 'Tahsilat hesabi bulunamadi');
    if ((deposit.type !== 'cash' && deposit.type !== 'bank') || deposit.status !== 'active') {
      throw new FinanceError('unprocessable', 'Tahsilat hesabi aktif bir kasa/banka hesabi olmali');
    }
    const recv = former ?? receivable(ctx, unitId, party);
    if (!former) await repo.ensureAccounts([recv]);

    for (let attempt = 1; ; attempt++) {
      const counterValue = await repo.getCounter(ctx.apartmentId, 'receipt');
      const paymentId = deps.newId();
      const tx = buildTx(ctx, {
        kind: 'payment',
        date: paidAt,
        description: former ? `Tahsilat - Daire ${unit.number} (ayrılan ${party === 'owner' ? 'malik' : 'sakin'})` : `Tahsilat - Daire ${unit.number}`,
        lines: [
          { accountId: depositAccountId, side: 'debit', amount },
          { accountId: recv.accountId, side: 'credit', amount, unitId, liableParty: party },
        ],
      });
      const payment: Payment = {
        ...financeKeys.payment(ctx.apartmentId, paymentId),
        entityType: 'PAYMENT',
        paymentId,
        siteId: ctx.apartmentId,
        unitId,
        liableParty: party,
        method,
        amount,
        depositAccountId,
        receiptNumber: `MKB-${String(counterValue + 1).padStart(6, '0')}`,
        transactionId: tx.transactionId,
        paidAt,
        payerName,
        note,
        ...(former ? { receivableAccountId: former.accountId } : {}),
        createdAt: tx.createdAt,
        createdBy: ctx.userId,
      };
      try {
        await repo.postTransaction({
          transaction: tx,
          idempotency: { id: key, fingerprint: fp, recordId: paymentId },
          counter: { name: 'receipt', expected: counterValue },
          record: payment,
          outbox: [
            toEvent({
              eventId: `PAYMENT_RECEIVED:${paymentId}`,
              type: 'PAYMENT_RECEIVED',
              apartmentId: ctx.apartmentId,
              actorId: ctx.userId,
              groupKey: unitId,
              payload: {
                paymentId,
                transactionId: tx.transactionId,
                receiptNumber: payment.receiptNumber,
                unitId,
                liableParty: party,
                amount,
                method,
                paidAt,
                ...(former ? { receivableAccountId: former.accountId } : {}),
              },
            }),
          ],
        });
        return { payment, transaction: tx, replayed: false };
      } catch (err) {
        if (err instanceof LedgerConflictError) {
          if (err.reason === 'duplicate') {
            const again = await replayOf(ctx, key, fp);
            if (again) return paymentResult(ctx, again, true);
          }
          if (err.reason === 'counter' && attempt < MAX_ATTEMPTS) continue;
        }
        throw mapConflict(err);
      }
    }
  }

  async function paymentResult(
    ctx: FinanceContext,
    replay: { transactionId: string; recordId?: string },
    replayed: boolean,
  ) {
    const payment = replay.recordId ? await repo.getPayment(ctx.apartmentId, replay.recordId) : undefined;
    if (!payment) throw new FinanceError('not_found', 'Tahsilat kaydi bulunamadi');
    return { payment, transaction: await loadTx(ctx, replay.transactionId), replayed };
  }

  // -------------------------------------------------------------------------
  // Online tahsilat (odeme saglayicisi onayindan sonra)
  // -------------------------------------------------------------------------

  /**
   * Saglayicinin onayladigi online odemeyi deftere TEK atomik yazimla isler (Adim 8b):
   *  - alt cari basina: varsa odeme aninda kesinlesen gecikme tazminati (`late_fee`) +
   *    tahsilat (`payment`, karsi hesap `online-collection`) + makbuz
   *  - odeme niyetinin sonuc durumu (surum kosullu; callback/webhook/mutabakat yarisinda tek yazim)
   * Idempotency anahtari `pay-<intentId>`: ayni niyet ikinci kez yazilmaz, onceki sonuc doner.
   *
   * Para saglayicida tahsil edilmis oldugu icin daire durumu/uyelik kontrolu YAPILMAZ.
   */
  async function recordOnlinePayment(ctx: FinanceContext, p: OnlinePaymentInput) {
    assertId(p.intentId, 'intentId');
    assertId(p.unitId, 'unitId');
    if (!isIsoDate(p.paidAt)) throw new ValidationError('paidAt YYYY-MM-DD olmali', 'paidAt');
    if (p.allocations.length === 0 || p.allocations.length > LIABLE_PARTIES.length) {
      throw new ValidationError('allocations 1-2 alt cari icermeli', 'allocations');
    }
    const parties = new Set<LiableParty>();
    for (const a of p.allocations) {
      if (!(LIABLE_PARTIES as readonly string[]).includes(a.liableParty) || parties.has(a.liableParty)) {
        throw new ValidationError('allocations alt carileri gecersiz veya tekrarli', 'allocations');
      }
      parties.add(a.liableParty);
      if (!Number.isSafeInteger(a.amount) || a.amount < 1 || a.amount > MAX_AMOUNT) {
        throw new ValidationError('allocations.amount pozitif kurus olmali', 'allocations');
      }
      if (!Number.isSafeInteger(a.lateFee) || a.lateFee < 0 || a.lateFee > a.amount) {
        throw new ValidationError('allocations.lateFee 0 ile amount arasinda olmali', 'allocations');
      }
    }

    const commission = p.commission ?? 0;
    const collected = p.allocations.reduce((s, a) => s + a.amount, 0);
    if (!Number.isSafeInteger(commission) || commission < 0 || commission >= collected) {
      throw new ValidationError('commission 0 ile tahsilat tutari arasinda olmali', 'commission');
    }

    const idemId = `pay-${p.intentId}`;
    const fp = fingerprint({
      op: 'online_payment',
      intentId: p.intentId,
      unitId: p.unitId,
      paidAt: p.paidAt,
      provider: p.provider,
      providerPaymentId: p.providerPaymentId,
      allocations: p.allocations,
      // P1 oncesi niyetlerin parmak izi degismesin: yalnizca komisyon varsa eklenir.
      ...(commission > 0 ? { commission } : {}),
    });
    const replay = async () => {
      const existing = await repo.getIdempotency(ctx.apartmentId, idemId);
      if (!existing) return undefined;
      if (existing.fingerprint !== fp) {
        throw new FinanceError('idempotency_conflict', 'Bu odeme niyeti farkli bir tahsilatla kaydedilmis');
      }
      const payments = (
        await Promise.all((existing.recordIds ?? []).map((id) => repo.getPayment(ctx.apartmentId, id)))
      ).filter((x): x is Payment => !!x);
      const transactions = (
        await Promise.all(
          (existing.transactionIds ?? [existing.transactionId]).map((id) => repo.getTransaction(ctx.apartmentId, id)),
        )
      ).filter((x): x is Transaction => !!x);
      return { payments, transactions, replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;

    const unit = await requireUnit(ctx, p.unitId);
    await ensureSystemAccounts(ctx);
    // Online tahsilat hesabi yalnizca online odeme alan apartmanlarda acilir (kasa/banka
    // listesinde gereksiz bos hesap olmasin).
    await repo.ensureAccounts([
      newAccount(ctx, {
        accountId: SYSTEM_ACCOUNTS.onlineCollection,
        type: 'bank',
        name: 'Online Tahsilat (iyzico)',
        system: true,
      }),
      ...(commission > 0
        ? [
            newAccount(ctx, {
              accountId: SYSTEM_ACCOUNTS.onlineCollectionFee,
              type: 'expense',
              name: 'Online Tahsilat Komisyon Gideri',
              system: true,
            }),
          ]
        : []),
      ...p.allocations.map((a) => receivable(ctx, p.unitId, a.liableParty)),
    ]);

    const ordered = [...p.allocations].sort((a, b) => a.liableParty.localeCompare(b.liableParty));
    for (let attempt = 1; ; attempt++) {
      const counterValue = await repo.getCounter(ctx.apartmentId, 'receipt');
      const transactions: Transaction[] = [];
      const payments: Payment[] = [];
      for (const [i, a] of ordered.entries()) {
        const recvId = receivableId(p.unitId, a.liableParty);
        if (a.lateFee > 0) {
          const fee = buildTx(ctx, {
            kind: 'late_fee',
            date: p.paidAt,
            dueDate: p.paidAt,
            description: 'Gecikme tazminatı (online ödemede kesinleşen)',
            reference: `LATE_FEE:PAY:${p.intentId}`,
            lines: [
              { accountId: recvId, side: 'debit', amount: a.lateFee, unitId: p.unitId, liableParty: a.liableParty },
              { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: a.lateFee },
            ],
          });
          // Ekstrede tazminat, ayni gunun tahsilatindan once gorunsun (kayit sirasi createdAt).
          fee.createdAt = new Date(Date.parse(fee.createdAt) - 1).toISOString();
          transactions.push(fee);
        }
        const tx = buildTx(ctx, {
          kind: 'payment',
          date: p.paidAt,
          description: `Online tahsilat - Daire ${unit.number}`,
          reference: `${p.provider.toUpperCase()}:${p.providerPaymentId}`,
          lines: [
            { accountId: SYSTEM_ACCOUNTS.onlineCollection, side: 'debit', amount: a.amount },
            { accountId: recvId, side: 'credit', amount: a.amount, unitId: p.unitId, liableParty: a.liableParty },
          ],
        });
        transactions.push(tx);
        const paymentId = deps.newId();
        payments.push({
          ...financeKeys.payment(ctx.apartmentId, paymentId),
          entityType: 'PAYMENT',
          paymentId,
          siteId: ctx.apartmentId,
          unitId: p.unitId,
          liableParty: a.liableParty,
          method: 'card',
          amount: a.amount,
          depositAccountId: SYSTEM_ACCOUNTS.onlineCollection,
          receiptNumber: `MKB-${String(counterValue + i + 1).padStart(6, '0')}`,
          transactionId: tx.transactionId,
          paidAt: p.paidAt,
          payerName: p.payerName,
          note: `Online ödeme (${p.provider})`,
          intentId: p.intentId,
          provider: p.provider,
          providerPaymentId: p.providerPaymentId,
          createdAt: tx.createdAt,
          createdBy: ctx.userId,
        });
      }
      if (commission > 0) {
        // Komisyon apartmanin gideri: aktarilacak tutar = tahsilat - komisyon (Karar A).
        const feeTx = buildTx(ctx, {
          kind: 'expense',
          date: p.paidAt,
          description: `Online tahsilat komisyonu (${p.provider}) - Daire ${unit.number}`,
          reference: `ONLINE-FEE:${p.intentId}`,
          lines: [
            { accountId: SYSTEM_ACCOUNTS.onlineCollectionFee, side: 'debit', amount: toKurus(commission) },
            { accountId: SYSTEM_ACCOUNTS.onlineCollection, side: 'credit', amount: toKurus(commission) },
          ],
        });
        // Ekstrede tahsilatlardan sonra gorunsun.
        feeTx.createdAt = new Date(Date.parse(feeTx.createdAt) + 1).toISOString();
        transactions.push(feeTx);
      }

      try {
        await repo.postBatch({
          transactions,
          idempotency: {
            id: idemId,
            fingerprint: fp,
            transactionIds: transactions.map((t) => t.transactionId),
            recordIds: payments.map((x) => x.paymentId),
          },
          counter: { name: 'receipt', expected: counterValue, increment: payments.length },
          records: payments,
          replaceRecords: [p.intentUpdate({ payments, transactions })],
          outbox: payments.map((payment) =>
            toEvent({
              eventId: `PAYMENT_RECEIVED:${payment.paymentId}`,
              type: 'PAYMENT_RECEIVED',
              apartmentId: ctx.apartmentId,
              actorId: ctx.userId,
              groupKey: p.unitId,
              payload: {
                paymentId: payment.paymentId,
                transactionId: payment.transactionId,
                receiptNumber: payment.receiptNumber,
                unitId: p.unitId,
                liableParty: payment.liableParty,
                amount: payment.amount,
                method: payment.method,
                paidAt: payment.paidAt,
              },
            }),
          ),
        });
      } catch (err) {
        if (err instanceof LedgerConflictError) {
          if (err.reason === 'duplicate') {
            const again = await replay();
            if (again) return again;
          }
          if (err.reason === 'counter' && attempt < MAX_ATTEMPTS) continue;
          // precondition: niyet baska bir istekle sonuclanmis; cagiran (odeme servisi) ele alir.
          if (err.reason === 'precondition') throw err;
        }
        throw mapConflict(err);
      }

      return { payments, transactions, replayed: false };
    }
  }

  // -------------------------------------------------------------------------
  // Gider
  // -------------------------------------------------------------------------

  async function recordExpense(ctx: FinanceContext, body: unknown) {
    const o = asObject(body);
    const key = reqKey(o);
    const expenseAccountId = assertId(o.expenseAccountId, 'expenseAccountId');
    const creditAccountId =
      o.creditAccountId === undefined ? SYSTEM_ACCOUNTS.cash : assertId(o.creditAccountId, 'creditAccountId');
    const amount = reqAmount(o, 'amount');
    const date = optDate(o, 'date') ?? today();
    const description = reqString(o, 'description', 200);
    const supplier = optString(o, 'supplier', 120);
    const invoiceNumber = optString(o, 'invoiceNumber', 60);
    const invoiceUpload = parseInvoiceUpload(o.invoiceUpload);

    const fp = fingerprint({
      op: 'expense',
      expenseAccountId,
      creditAccountId,
      amount,
      date,
      description,
      supplier,
      invoiceNumber,
      ...(invoiceUpload ? { invoiceUploadId: invoiceUpload.uploadId } : {}),
    });
    const replay = await replayOf(ctx, key, fp);
    if (replay) return expenseResult(ctx, replay, true);

    await ensureSystemAccounts(ctx);
    const expenseAccount = await repo.getAccount(ctx.apartmentId, expenseAccountId);
    if (!expenseAccount) throw new FinanceError('not_found', 'Gider hesabi bulunamadi');
    if (expenseAccount.type !== 'expense' || expenseAccount.status !== 'active') {
      throw new FinanceError('unprocessable', 'Gider hesabi aktif bir gider hesabi olmali');
    }

    // Fatura, defter yaziminden ONCE kalici yere tasinir: kayit hic var olmayan dosyaya
    // isaret etmez. Defter yazimi basarisiz olursa kopya sahipsiz kalir (zararsiz).
    const expenseId = deps.newId();
    let invoice: ExpenseInvoice | undefined;
    if (invoiceUpload) {
      if (!deps.attachments) throw new FinanceError('unprocessable', 'Belge deposu yapilandirilmamis; fatura eklenemez');
      invoice = await deps.attachments.promote(ctx.apartmentId, invoiceUpload, { expenseId, date });
    }

    for (let attempt = 1; ; attempt++) {
      const credit = await repo.getAccount(ctx.apartmentId, creditAccountId);
      if (!credit) throw new FinanceError('not_found', 'Odeme hesabi bulunamadi');
      if (!['cash', 'bank', 'payable'].includes(credit.type) || credit.status !== 'active') {
        throw new FinanceError('unprocessable', 'Odeme hesabi aktif bir kasa/banka/tedarikci hesabi olmali');
      }
      const isFunds = credit.type === 'cash' || credit.type === 'bank';
      if (isFunds && credit.balance < amount) {
        throw new FinanceError('insufficient_funds', 'Kasa/banka bakiyesi bu gider icin yetersiz');
      }

      const tx = buildTx(ctx, {
        kind: 'expense',
        date,
        description,
        reference: invoiceNumber,
        invoice: invoice ? { expenseId, fileName: invoice.fileName } : undefined,
        lines: [
          { accountId: expenseAccountId, side: 'debit', amount },
          { accountId: creditAccountId, side: 'credit', amount },
        ],
      });
      const expense: Expense = {
        ...financeKeys.expense(ctx.apartmentId, expenseId),
        entityType: 'EXPENSE',
        expenseId,
        siteId: ctx.apartmentId,
        expenseAccountId,
        creditAccountId,
        amount,
        date,
        description,
        supplier,
        invoiceNumber,
        invoice,
        transactionId: tx.transactionId,
        createdAt: tx.createdAt,
        createdBy: ctx.userId,
      };
      try {
        await repo.postTransaction({
          transaction: tx,
          idempotency: { id: key, fingerprint: fp, recordId: expenseId },
          // Kasa/banka yetersiz bakiye kontrolu es zamanli islemlere karsi surumle korunur.
          expectedVersions: isFunds ? { [creditAccountId]: credit.version } : undefined,
          record: expense,
        });
        return { expense, transaction: tx, replayed: false };
      } catch (err) {
        if (err instanceof LedgerConflictError) {
          if (err.reason === 'duplicate') {
            const again = await replayOf(ctx, key, fp);
            if (again) return expenseResult(ctx, again, true);
          }
          if (err.reason === 'version' && attempt < MAX_ATTEMPTS) continue;
        }
        throw mapConflict(err);
      }
    }
  }

  async function expenseResult(
    ctx: FinanceContext,
    replay: { transactionId: string; recordId?: string },
    replayed: boolean,
  ) {
    const expense = replay.recordId ? await repo.getExpense(ctx.apartmentId, replay.recordId) : undefined;
    if (!expense) throw new FinanceError('not_found', 'Gider kaydi bulunamadi');
    return { expense, transaction: await loadTx(ctx, replay.transactionId), replayed };
  }

  // -------------------------------------------------------------------------
  // Ters kayit (duzeltme)
  // -------------------------------------------------------------------------

  async function reverseTransaction(ctx: FinanceContext, transactionId: string, body: unknown) {
    assertId(transactionId, 'transactionId');
    const o = asObject(body);
    const reason = reqString(o, 'reason', 300);
    const date = optDate(o, 'date') ?? today();

    const original = await loadTx(ctx, transactionId);
    if (original.kind === 'reversal') {
      throw new FinanceError('unprocessable', 'Ters kayit tekrar ters cevrilemez');
    }
    if (original.kind === 'transfer') {
      throw new FinanceError('unprocessable', 'Cari devri islemleri yalnizca kapamanin geri alinmasiyla cevrilebilir');
    }
    // Kapatilmis doneme ait kayit: kalemi devredildi; ters kayit kaynakta etkisiz kalir.
    for (const accountId of new Set(original.lines.filter((l) => l.unitId && l.liableParty).map((l) => l.accountId))) {
      const acc = await repo.getAccount(ctx.apartmentId, accountId);
      if (acc?.closedThrough && original.date <= acc.closedThrough) {
        throw new FinanceError(
          'unprocessable',
          `Bu islem tasinma kapamasiyla ${acc.closedThrough} tarihinde kapatilan doneme ait; duzeltmeyi borcun devredildigi caride yapin`,
        );
      }
    }
    const idemId = `REV_${transactionId}`;
    const fp = fingerprint({ op: 'reversal', transactionId, reason, date });
    const replay = await replayOf(ctx, idemId, fp).catch((err) => {
      if (err instanceof FinanceError && err.code === 'idempotency_conflict') {
        throw new FinanceError('conflict', 'Bu islem zaten ters kayitla duzeltilmis');
      }
      throw err;
    });
    if (replay) return { transaction: await loadTx(ctx, replay.transactionId), replayed: true };

    const tx = buildTx(ctx, {
      kind: 'reversal',
      date,
      description: `Ters kayit: ${original.description}`,
      reversalOf: original.transactionId,
      reason,
      lines: original.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
    });
    try {
      await repo.postTransaction({ transaction: tx, idempotency: { id: idemId, fingerprint: fp } });
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replayOf(ctx, idemId, fp).catch(() => undefined);
        if (again) return { transaction: await loadTx(ctx, again.transactionId), replayed: true };
        throw new FinanceError('conflict', 'Bu islem zaten ters kayitla duzeltilmis');
      }
      throw mapConflict(err);
    }
    return { transaction: tx, replayed: false };
  }

  // -------------------------------------------------------------------------
  // Bakiye sorgusu
  // -------------------------------------------------------------------------

  /**
   * Bagimsiz bolumun cari durumu. Bakiye = borc - alacak: pozitif -> borc, negatif -> avans/alacak.
   */
  async function getUnitBalance(ctx: FinanceContext, unitId: string) {
    assertId(unitId, 'unitId');
    await requireUnit(ctx, unitId);
    const accounts = (await repo.listAccounts(ctx.apartmentId)).filter(
      (a) => a.type === 'receivable' && a.unitId === unitId,
    );
    // Daire bakiyesi ana carilerden olusur; ayrilan sakin/malik carileri ayri gosterilir.
    const main = (a: Account) => a.liableParty !== undefined && a.accountId === mainReceivableId(unitId, a.liableParty);
    const of = (party: LiableParty) =>
      accounts.filter((a) => main(a) && a.liableParty === party).reduce((s, a) => s + a.balance, 0);
    const owner = of('owner');
    const occupant = of('occupant');
    const net = owner + occupant;
    const formerAccounts = accounts.filter((a) => !main(a));
    const split = (n: number) => ({
      balance: toKurus(n),
      debt: toKurus(Math.max(n, 0)),
      credit: toKurus(Math.max(-n, 0)),
    });
    return {
      unitId,
      currency: 'TRY' as const,
      owner: split(owner),
      occupant: split(occupant),
      ...split(net),
      ...(formerAccounts.length
        ? {
            former: formerAccounts
              .map((a) => ({ accountId: a.accountId, name: a.name, liableParty: a.liableParty, closureId: a.closureId, ...split(a.balance) }))
              .sort((a, b) => a.accountId.localeCompare(b.accountId)),
          }
        : {}),
    };
  }

  // -------------------------------------------------------------------------
  // Raporlar (salt okunur)
  // -------------------------------------------------------------------------

  async function loadReportData(ctx: FinanceContext) {
    await ensureSystemAccounts(ctx);
    const [accounts, units, txs] = await Promise.all([
      repo.listAccounts(ctx.apartmentId),
      deps.core.listUnits(ctx.apartmentId),
      repo.listTransactions(ctx.apartmentId),
    ]);
    return { accounts, units, transactions: txs.items };
  }

  async function lateFeeRate(apartmentId: string): Promise<number> {
    const site = deps.core.getSite ? await deps.core.getSite(apartmentId) : undefined;
    return site?.settings.lateFeeMonthlyBasisPoints ?? DEFAULT_LATE_FEE_BASIS_POINTS;
  }

  /** Daire bazli aidat durumu (FIFO ile gecikme + islemis kistelyevm tazminati). */
  async function duesStatus(ctx: FinanceContext) {
    const [{ accounts, units, transactions }, rate] = await Promise.all([loadReportData(ctx), lateFeeRate(ctx.apartmentId)]);
    const receivables = new Set(accounts.filter((a) => a.type === 'receivable').map((a) => a.accountId));
    const items = buildDuesStatus(units, transactions, receivables, today(), rate).sort((a, b) =>
      a.unitNumber.localeCompare(b.unitNumber, 'tr', { numeric: true }),
    );
    return { asOf: today(), lateFeeMonthlyBasisPoints: rate, items };
  }

  /** Ayrilan sakin/malik carileri (tasinmada kapama ile acilan), varsayilan: bakiyesi olanlar. */
  async function formerAccounts(ctx: FinanceContext, opts: { all?: string } = {}) {
    const [{ accounts, units, transactions }, rate] = await Promise.all([loadReportData(ctx), lateFeeRate(ctx.apartmentId)]);
    return {
      asOf: today(),
      items: buildFormerAccounts(accounts, units, transactions, today(), rate, opts.all === 'true'),
    };
  }

  /** Kasa/banka bakiyeleri + alacak/gecikme ozeti. */
  async function summary(ctx: FinanceContext) {
    const [{ accounts, units, transactions }, rate] = await Promise.all([loadReportData(ctx), lateFeeRate(ctx.apartmentId)]);
    const receivables = new Set(accounts.filter((a) => a.type === 'receivable').map((a) => a.accountId));
    return { asOf: today(), ...buildSummary(accounts, buildDuesStatus(units, transactions, receivables, today(), rate)) };
  }

  // -------------------------------------------------------------------------
  // Zamanlanmis gorevler (EventBridge Scheduler -> worker). Kullanici istegi degildir:
  // apartman kimligi worker'in site dizininden gelir, aktor SYSTEM_ACTOR'dur.
  // -------------------------------------------------------------------------

  function assertPeriod(period: string): void {
    if (!isPeriod(period)) throw new ValidationError('period YYYY-MM olmali', 'period');
  }

  /**
   * Aylik aidat plani: donemin 1'i tarihli, son odemesi `dueDayOfMonth` olan toplu tahakkuk.
   * Idempotency anahtari donem bazli (`auto-dues-<YYYY-MM>`): gorev tekrar calissa veya yarida
   * kalsa bile ayni ay ikinci kez borclandirilmaz, eksik kalan daireler tamamlanir.
   */
  async function autoChargeDues(
    apartmentId: string,
    p: { period: string; plan: MonthlyDuesPlan | undefined; dueDayOfMonth: number },
  ) {
    assertPeriod(p.period);
    if (!p.plan?.enabled) return { status: 'skipped' as const, reason: 'plan_disabled' as const };
    const ctx: FinanceContext = { apartmentId, userId: SYSTEM_ACTOR };
    const { first } = periodBounds(p.period);
    const result = await chargeBulk(ctx, {
      idempotencyKey: `auto-dues-${p.period}`,
      liableParty: p.plan.liableParty,
      totalAmount: p.plan.totalAmount,
      distributionKey: p.plan.distributionKey,
      date: first,
      dueDate: `${p.period}-${String(p.dueDayOfMonth).padStart(2, '0')}`,
      description: `${periodLabel(p.period)} aidatı`,
    });
    return { status: 'charged' as const, ...result };
  }

  /**
   * Gecikme tazminati kesinlestirmesi (karar 1a): her alt cari icin
   * `toplam tazminat(donem sonu) - deftere yazilmis` tutari, bir sonraki ayin 1'i tarihli tek
   * `late_fee` islemi olarak yazilir. Eksi/sifir fark yazilmaz.
   * Idempotency: `lf-<YYYY-MM>-<unitId>-<o|t>` kaydi varsa hesap atlanir (tutar yeniden
   * hesaplanmaz; boylece ayni donem asla iki kez yazilmaz).
   */
  async function postLateFees(
    apartmentId: string,
    p: { period: string; monthlyBasisPoints: number; dueDayOfMonth: number },
  ) {
    assertPeriod(p.period);
    const ctx: FinanceContext = { apartmentId, userId: SYSTEM_ACTOR };
    const items: { accountId: string; unitId: string; liableParty: LiableParty; amount: Kurus; transactionId: string; replayed: boolean }[] = [];
    if (p.monthlyBasisPoints <= 0) return { period: p.period, count: 0, totalAmount: toKurus(0), items };

    await ensureSystemAccounts(ctx);
    const { last } = periodBounds(p.period);
    const postPeriod = nextPeriod(p.period);
    const postDate = periodBounds(postPeriod).first;
    const dueDate = `${postPeriod}-${String(p.dueDayOfMonth).padStart(2, '0')}`;
    const [accounts, txPage] = await Promise.all([repo.listAccounts(apartmentId), repo.listTransactions(apartmentId)]);
    const transactions = txPage.items;
    const cancelled = cancelledTransactions(transactions);

    const receivables = accounts
      .filter((a) => a.type === 'receivable' && a.unitId && a.liableParty)
      .sort((a, b) => a.accountId.localeCompare(b.accountId));
    for (const account of receivables) {
      const unitId = account.unitId as string;
      const party = account.liableParty as LiableParty;
      // Ana cari anahtari geriye uyumlu; ayrilan sakin carileri hesap kimligiyle ayrisir.
      const idemId =
        account.accountId === mainReceivableId(unitId, party)
          ? `lf-${p.period}-${unitId}-${party === 'owner' ? 'o' : 't'}`
          : `lf-${p.period}-${account.accountId}`;
      // Kapama, kesim tarihine kadarki tazminati zaten kesinlestirdi; o donemin tazminati yazilmaz.
      if (account.closedThrough && postDate <= account.closedThrough) continue;
      const existing = await repo.getIdempotency(apartmentId, idemId);
      if (existing) {
        const tx = await repo.getTransaction(apartmentId, existing.transactionId);
        if (tx) items.push({ accountId: account.accountId, unitId, liableParty: party, amount: tx.totalAmount, transactionId: tx.transactionId, replayed: true });
        continue;
      }
      const amount = unpostedLateFee(feeLedgerFor(account.accountId, transactions, cancelled), p.monthlyBasisPoints, last);
      if (amount < 1) continue;

      const fp = fingerprint({ op: 'late_fee', period: p.period, accountId: account.accountId, amount });
      const tx = buildTx(ctx, {
        kind: 'late_fee',
        date: postDate,
        dueDate,
        description: `Gecikme tazminatı (${periodLabel(p.period)})`,
        reference: `LATE_FEE:${p.period}`,
        lines: [
          { accountId: account.accountId, side: 'debit', amount: toKurus(amount), unitId, liableParty: party },
          { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: toKurus(amount) },
        ],
      });
      try {
        await repo.postTransaction({
          transaction: tx,
          idempotency: { id: idemId, fingerprint: fp },
          // Alt cari basina olay, tazminat kaydiyla ayni atomik yazimda (kimlik deterministik).
          outbox: [
            toEvent({
              eventId: `LATE_FEE_POSTED:${p.period}:${tx.transactionId}`,
              type: 'LATE_FEE_POSTED',
              apartmentId,
              actorId: SYSTEM_ACTOR,
              groupKey: unitId,
              payload: {
                period: p.period,
                items: [{ unitId, liableParty: party, amount: toKurus(amount), transactionId: tx.transactionId }],
              },
            }),
          ],
        });
        items.push({ accountId: account.accountId, unitId, liableParty: party, amount: toKurus(amount), transactionId: tx.transactionId, replayed: false });
      } catch (err) {
        // Es zamanli ayni gorev: diger calisma yazdi; bu hesap tamam sayilir.
        if (err instanceof LedgerConflictError && err.reason === 'duplicate') continue;
        throw mapConflict(err);
      }
    }
    const fresh = items.filter((i) => !i.replayed);
    return {
      period: p.period,
      count: fresh.length,
      totalAmount: toKurus(fresh.reduce((s, i) => s + i.amount, 0)),
      items,
    };
  }

  /** Defter hareketleri (en yeni once), sayfali. */
  async function listTransactions(
    ctx: FinanceContext,
    query: { from?: string; to?: string; limit?: string; cursor?: string } = {},
  ) {
    const q: Obj = { ...query };
    const from = optDate(q, 'from');
    const to = optDate(q, 'to');
    if (from && to && from > to) throw new ValidationError('from, to tarihinden sonra olamaz', 'from');
    const limit = query.limit === undefined ? 50 : Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTION_PAGE) {
      throw new ValidationError(`limit 1-${MAX_TRANSACTION_PAGE} arasinda olmali`, 'limit');
    }
    await ensureSystemAccounts(ctx);
    const [accounts, units] = await Promise.all([repo.listAccounts(ctx.apartmentId), deps.core.listUnits(ctx.apartmentId)]);
    let page: Awaited<ReturnType<FinanceRepository['listTransactions']>>;
    try {
      page = await repo.listTransactions(ctx.apartmentId, { from, to, limit, cursor: query.cursor, newestFirst: true });
    } catch (err) {
      if (err instanceof InvalidCursorError) throw new ValidationError(err.message, 'cursor');
      throw err;
    }
    const accountMap = new Map(accounts.map((a) => [a.accountId, a]));
    const unitNumbers = new Map(units.map((u) => [u.unitId, u.number]));
    return {
      items: page.items.map((tx) => toTransactionView(tx, accountMap, unitNumbers)),
      nextCursor: page.cursor,
    };
  }

  // -------------------------------------------------------------------------
  // Acilis (devir) bakiyeleri - toplu aktarim (imports modulu) kullanir
  // -------------------------------------------------------------------------

  /** Idempotent yazim: anahtar varsa onceki islem doner (icerik ayniysa). */
  async function postIdempotent(ctx: FinanceContext, idemId: string, fp: string, build: () => Transaction) {
    const replay = await replayOf(ctx, idemId, fp);
    if (replay) return { transaction: await loadTx(ctx, replay.transactionId), replayed: true };
    const tx = build();
    try {
      await repo.postTransaction({ transaction: tx, idempotency: { id: idemId, fingerprint: fp } });
      return { transaction: tx, replayed: false };
    } catch (err) {
      if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
        const again = await replayOf(ctx, idemId, fp);
        if (again) return { transaction: await loadTx(ctx, again.transactionId), replayed: true };
      }
      throw mapConflict(err);
    }
  }

  /**
   * Daire alt carisinin devir bakiyesi. `amount` isaretli kurus: pozitif = borc (vadeli
   * tahakkuk gibi davranir; kistelyevm vadeden sonra isler), negatif = avans (tahsilat gibi
   * mahsup edilir). Karsi hesap `opening-balance` (ozkaynak): mizan dengede kalir.
   */
  async function postOpeningBalance(
    ctx: FinanceContext,
    p: { idemId: string; unitId: string; party: LiableParty; amount: number; date: IsoDate; dueDate: IsoDate; description: string; batchId?: string },
  ) {
    if (!Number.isSafeInteger(p.amount) || p.amount === 0 || Math.abs(p.amount) > MAX_AMOUNT) {
      throw new ValidationError('Acilis bakiyesi sifirdan farkli gecerli bir kurus tutari olmalidir', 'amount');
    }
    await ensureSystemAccounts(ctx);
    const recv = receivable(ctx, p.unitId, p.party);
    await repo.ensureAccounts([recv]);
    const abs = toKurus(Math.abs(p.amount));
    const debt = p.amount > 0;
    const fp = fingerprint({ op: 'opening', unitId: p.unitId, party: p.party, amount: p.amount, date: p.date, dueDate: p.dueDate, description: p.description });
    return postIdempotent(ctx, p.idemId, fp, () =>
      buildTx(ctx, {
        kind: 'opening_balance',
        date: p.date,
        dueDate: debt ? p.dueDate : undefined,
        description: p.description,
        batchId: p.batchId,
        lines: [
          { accountId: recv.accountId, side: debt ? 'debit' : 'credit', amount: abs, unitId: p.unitId, liableParty: p.party },
          { accountId: SYSTEM_ACCOUNTS.openingBalance, side: debt ? 'credit' : 'debit', amount: abs },
        ],
      }),
    );
  }

  /** Kasa / banka devir bakiyesi (pozitif kurus). */
  async function postOpeningFunds(
    ctx: FinanceContext,
    p: { idemId: string; account: 'cash' | 'bank'; amount: number; date: IsoDate; batchId?: string },
  ) {
    if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT) {
      throw new ValidationError('Tutar pozitif kurus olmalidir', 'amount');
    }
    await ensureSystemAccounts(ctx);
    const accountId = p.account === 'cash' ? SYSTEM_ACCOUNTS.cash : SYSTEM_ACCOUNTS.bank;
    const amount = toKurus(p.amount);
    const fp = fingerprint({ op: 'opening_funds', accountId, amount, date: p.date });
    return postIdempotent(ctx, p.idemId, fp, () =>
      buildTx(ctx, {
        kind: 'opening_balance',
        date: p.date,
        description: p.account === 'cash' ? 'Kasa devir bakiyesi' : 'Banka devir bakiyesi',
        batchId: p.batchId,
        lines: [
          { accountId, side: 'debit', amount },
          { accountId: SYSTEM_ACCOUNTS.openingBalance, side: 'credit', amount },
        ],
      }),
    );
  }

  /** Hatirlatma gunu `date` (Istanbul) icin gonderilecek borc hatirlatmalari. */
  async function dueReminders(apartmentId: string, date: IsoDate) {
    if (!isIsoDate(date)) throw new ValidationError('date YYYY-MM-DD olmali', 'date');
    const [accounts, txPage] = await Promise.all([repo.listAccounts(apartmentId), repo.listTransactions(apartmentId)]);
    // Yalnizca daire ana carileri: ayrilan sakin carilerinin sahibine portal/bildirim erisimi yok
    // (ilk surum); hatirlatma dairedeki bugunku sakine gitmemeli.
    const receivables = new Set(
      accounts
        .filter((a) => a.type === 'receivable' && a.unitId && a.liableParty && a.accountId === mainReceivableId(a.unitId, a.liableParty))
        .map((a) => a.accountId),
    );
    return buildDueReminders(txPage.items, receivables, date);
  }

  return {
    duesStatus,
    formerAccounts,
    summary,
    autoChargeDues,
    postLateFees,
    dueReminders,
    postOpeningBalance,
    postOpeningFunds,
    listTransactions,
    listAccounts,
    createAccount,
    updateAccount,
    charge,
    chargeUnit,
    chargeBulk,
    previewBulk,
    recordPayment,
    recordOnlinePayment,
    recordExpense,
    reverseTransaction,
    getUnitBalance,
    /** Sistem hesaplari (kasa, banka, gelir...) yoksa olusturur (cari kapama servisi kullanir). */
    ensureSystemAccounts,
  };
}

export type FinanceService = ReturnType<typeof createFinanceService>;

// ---------------------------------------------------------------------------
// Hata esleme
// ---------------------------------------------------------------------------

function isConditionalFailure(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'conflict';
}

/** Repository seviyesindeki cakismalari anlamli HTTP hatalarina cevirir. */
function mapConflict(err: unknown): unknown {
  if (err instanceof LedgerConflictError) {
    switch (err.reason) {
      case 'account_missing':
        return new FinanceError('not_found', 'Hesap bulunamadi');
      case 'duplicate':
        return new FinanceError('conflict', 'Islem zaten kaydedilmis');
      case 'closed':
        return new FinanceError(
          'conflict',
          `Bu cari tasinma kapamasiyla ${err.closedThrough ?? ''} tarihine kadar kapatildi; bu tarih ve oncesine kayit girilemez`.replace('  ', ' '),
        );
      default:
        return new FinanceError('conflict', 'Es zamanli bir islem cakismasi oldu, tekrar deneyin');
    }
  }
  return err;
}
