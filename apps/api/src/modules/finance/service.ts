import { createHash, randomUUID } from 'node:crypto';
import { type DomainEvent, type NewEvent, buildEvent } from '../../events/publisher.js';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import {
  type IsoDate,
  type Kurus,
  type LiableParty,
  type MonthlyDuesPlan,
  type TableKeys,
  type Unit,
  toKurus,
} from '../core/types.js';
import type { AuditDraft } from '../audit/log.js';
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
  ledgerAuditDraft,
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
  type ExpenseWorkLink,
  type Payment,
  PAYMENT_METHODS,
  type PaymentMethod,
  type Transaction,
  type TransactionLine,
  coOwnerReceivableId,
  isCoOwnerReceivableId,
  isPrimaryReceivableId,
  mainReceivableId,
} from './types.js';
import type { MembershipRepository } from '../memberships/repository.js';
import type { OwnershipReader } from '../ownership/reader.js';
import { splitAmountByShares } from '../ownership/shares.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import { type PayableSummary, payableSummary } from './payables.js';
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

/** Senkron toplu tahakkuk icin kapsam fazla buyuk: rota bunu arka plan isine cevirir. */
export class BulkTooLargeError extends FinanceError {
  readonly unitCount: number;
  constructor(unitCount: number, message: string) {
    super('unprocessable', message);
    this.name = 'BulkTooLargeError';
    this.unitCount = unitCount;
  }
}

/** Para tutari ust siniri: 999.999.999,99 TL (kurus). */
export const MAX_AMOUNT = 99_999_999_999;
/**
 * Toplu tahakkuk kapsam ust siniri (asenkron is dahil). 2.500+ bolumlu siteler icin genis tutulur;
 * istek suresi siniri `SYNC_BULK_UNITS` ile ayrica korunur.
 */
export const MAX_BULK_UNITS = 5000;
/**
 * Bu sayidan fazla bagimsiz bolume yazan toplu tahakkuk HTTP isteginde calismaz: arka plan isi
 * (`bulkjobs`, SQS) olarak acilir. Kucuk sitelerde (ve testlerde) senkron yol aynen korunur.
 */
export const SYNC_BULK_UNITS = 60;

/** Asenkron toplu tahakkukun dondurulmus parametreleri (is kaydinda saklanir). */
export type BulkDuesSpec = {
  idempotencyKey: string;
  batchId: string;
  liableParty: LiableParty;
  totalAmount: number;
  distributionKey: DuesDistributionKey;
  date: IsoDate;
  dueDate: IsoDate;
  description: string;
  incomeAccountId: string;
  /** Idempotency parmak izine giren kapsam (blok, gider kalemi, gelir hesabi). */
  scopeFp: Record<string, unknown>;
  expenseCategory?: string;
};

/** Dondurulmus dagitim satiri: pay ve borclu taraf is acilirken bir kez hesaplanir. */
export type BulkDuesLine = { unitId: string; unitNumber: string; amount: number; party: LiableParty; vacant: boolean };

export type BulkDuesLineResult = {
  unitId: string;
  amount: Kurus;
  transactionId: string;
  replayed: boolean;
  liableParty: LiableParty;
  vacant: boolean;
  coOwnerParts?: { userId: string; amount: Kurus }[];
};

/** Daire alt carisinin adi (Faz 1: UUID yerine daire numarasi). */
export function receivableName(unitNumber: string, party: LiableParty): string {
  return `Daire ${unitNumber} - ${party === 'owner' ? 'Kat Maliki' : 'Kiracı/Sakin'}`;
}

/** Finans 2.1 paydas alt carisinin adi. */
export function coOwnerReceivableName(unitNumber: string): string {
  return `Daire ${unitNumber} - Kat Maliki (paydaş)`;
}
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
  { accountId: 'exp-repair', name: 'Bakım / Onarım' },
  { accountId: 'exp-management', name: 'Yönetim Giderleri' },
  { accountId: 'exp-other', name: 'Diğer Giderler' },
] as const;

/**
 * Finans 2.4: hazir gelir hesaplari (aidat ve gecikme sistem hesaplarina ek). Tahakkukta
 * `incomeAccountId` ile secilir; demirbas (yatirim) ve isinma/yakit dagitimlari bütçe–gerceklesen
 * raporunda ayri kalem olarak izlenir. Var olan apartmanlarda ilk finans isleminde acilir.
 */
export const DEFAULT_INCOME_ACCOUNTS = [
  { accountId: 'income-fixtures', name: 'Demirbaş Gelirleri' },
  { accountId: 'income-heating', name: 'Isınma / Yakıt Gelirleri' },
  /** O1-4: sakin kusurlu daire ici onarim masrafinin daireye yansitilmasi. */
  { accountId: 'income-repair-recharge', name: 'Onarım Yansıtma Gelirleri' },
] as const;

/** O1-4: onarim yansitma gelir hesabi. */
export const REPAIR_RECHARGE_INCOME = 'income-repair-recharge';

/**
 * O1-4: is (ariza talebi / bakim gorevi) baglantisi. Defter yazimiyla AYNI atomik islemde
 * yazilacak surumlu belgeler (talep / gorev ozeti) ve yeni belgeler (EXPLINK kilidi, olay).
 * `build` her denemede yeniden cagrilir: es zamanli degisiklikte guncel surumle kurulur.
 */
export type WorkLinkWrite = {
  replaceRecords?: ReplaceRecord[];
  newDocs?: (TableKeys & { entityType: string })[];
  /** Denetim kaydina eklenecek ayrintilar (is baglantisi). */
  auditDetails?: Record<string, unknown>;
};
export type WorkLinkHook = {
  /** Idempotency parmak izine eklenir (ayni anahtar baska ise kullanilamaz). */
  fp: Record<string, unknown>;
  /** Gider belgesine yazilacak is baglantisi. */
  expenseLink?: ExpenseWorkLink;
  /** Islem referansi (tahakkuk): ornegin `TICKET:T-000123`. */
  reference?: string;
  build(r: { transaction: Transaction; expense?: Expense }): Promise<WorkLinkWrite>;
};

function withAuditDetails(draft: AuditDraft, extra?: Record<string, unknown>): AuditDraft {
  return extra ? { ...draft, details: { ...(draft.details ?? {}), ...extra } } : draft;
}

/** Hesap plani kodu: harf, rakam, nokta, tire (1-20). */
export const ACCOUNT_CODE_RE = /^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$/;

export const MAX_TRANSACTION_PAGE = 200;

export const DUES_DISTRIBUTION_KEYS = ['equal', 'area', 'land_share'] as const;
export type DuesDistributionKey = (typeof DUES_DISTRIBUTION_KEYS)[number];

const LIABLE_PARTIES = ['owner', 'occupant'] as const;
const EDITABLE_ACCOUNT_TYPES = ['cash', 'bank', 'income', 'expense', 'payable'] as const;

export type FinanceContext = { apartmentId: string; userId: string };

/** Online odemede alt cari basina tahsilat. `amount` alt cariye alacak yazilan toplamdir. */
export type OnlinePaymentAllocation = {
  liableParty: LiableParty;
  /**
   * Finans 2.1: tahsilatin yazilacagi alt cari (ornegin `split` dairede paydasin alt carisi).
   * Verilmezse tarafin ana carisi. Ayni taraf bir niyette bir kez gecer.
   */
  accountId?: string;
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

/**
 * Faz B2: banka satirinin alt cariye tahsilati. `accountId` ana veya ayrilan (tasinmada acilmis)
 * alt caridir; daire ve taraf HESAPTAN okunur (istemciye guvenilmez).
 */
export type BankPaymentAllocation = {
  accountId: string;
  amount: Kurus;
  /** Odeme aninda kesinlestirilecek gecikme tazminati (0 olabilir). */
  lateFee: Kurus;
};

export type ResolvedBankAllocation = BankPaymentAllocation & { unitId: string; liableParty: LiableParty };

/** Ayni atomik yazima eklenecek belgeler ve denetim kaydi (banka modulu uretir). */
export type BankLedgerDocuments = {
  newDocs?: (TableKeys & { entityType: string })[];
  replaceRecords?: ReplaceRecord[];
  audit?: AuditDraft;
};

export type BankPaymentInput = {
  /** Idempotency kimligi (ornek `bankmatch-<lineId>-<n>`): ayni karar iki kez yazilmaz. */
  idempotencyId: string;
  /** Tahsilatin girdigi banka hesabi (ekstrenin hesabi). */
  depositAccountId: string;
  /** Banka valoru. */
  paidAt: IsoDate;
  /** Islem referansi (`BANK:<dekont no | lineId>`). */
  reference: string;
  payerName?: string;
  note?: string;
  allocations: BankPaymentAllocation[];
  documents: (r: { payments: Payment[]; transactions: Transaction[]; allocations: ResolvedBankAllocation[] }) => BankLedgerDocuments;
};

/**
 * Faz B3: bankadan cikan satirin gidere cevrilmesi (gider hesabi borc / banka hesabi alacak).
 * Gider kaydi (EXPENSE), islem, banka modulunun belgeleri ve denetim TEK atomik yazimdir.
 */
export type BankExpenseInput = {
  /** Idempotency kimligi (ornek `bankexpense-<lineId>-<n>`). */
  idempotencyId: string;
  /** Odemenin ciktigi banka hesabi (ekstrenin hesabi). */
  bankAccountId: string;
  expenseAccountId: string;
  amount: Kurus;
  /** Banka valoru. */
  date: IsoDate;
  description: string;
  supplier?: string;
  invoiceNumber?: string;
  /** Islem referansi (`BANK:<dekont no | lineId>`). */
  reference: string;
  documents: (r: { expense: Expense; transaction: Transaction }) => BankLedgerDocuments;
};

/**
 * Faz B3.5: bankadan cikan satirla tedarikci borcunun kapatilmasi (borc: tedarikci, alacak:
 * ekstrenin banka hesabi). Islem, banka modulunun belgeleri ve denetim TEK atomik yazimdir.
 */
export type BankPayablePaymentInput = {
  /** Idempotency kimligi (ornek `bankpayable-<lineId>-<n>`). */
  idempotencyId: string;
  bankAccountId: string;
  payableAccountId: string;
  amount: Kurus;
  /** Banka valoru. */
  date: IsoDate;
  description: string;
  /** `BANK:<dekont no | lineId>` */
  reference: string;
  documents: (r: { transaction: Transaction; payable: Account }) => BankLedgerDocuments;
};

export type BankReversalInput = {
  idempotencyId: string;
  /** Ters cevrilecek islemler (banka eslestirmesinin tazminat + tahsilat veya gider kayitlari). */
  transactionIds: string[];
  reason: string;
  documents: (r: { reversals: Transaction[] }) => BankLedgerDocuments;
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
  /**
   * Finans 2.1: hisseli mulkiyet. `split` faturalamali dairede malik tarafina yazilan tahakkuk
   * tahakkuk tarihindeki sicil paylariyla paydas alt carilerine bolunur. Verilmezse (testler /
   * eski cagiranlar) malik tahakkuku daima ortak malik carisine yazilir.
   */
  ownership?: Pick<OwnershipReader, 'ownerSplitOn'>;
  /** Faz B3.5: tedarikci acik kalemleri icin hesap hareketleri (varsayilan portal deposu). */
  ledger: Pick<PortalRepository, 'listLedgerEntries' | 'getTransactions'>;
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
    ledger: portalRepository,
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
      ...DEFAULT_INCOME_ACCOUNTS.map((e) => newAccount(ctx, { ...e, type: 'income' })),
    ]);
    ensuredSystem.add(ctx.apartmentId);
  }

  /**
   * Faz 1: hesap adi ham daire kimligi yerine daire numarasini tasir (`Daire 5 - Kat Maliki`).
   * Ad yalnizca hesap ilk kez acilirken yazilir (`ensureAccounts` var olani ezmez); eski
   * kayitlar `scripts/fix-receivable-names.ts` ile duzeltilir.
   */
  function receivable(ctx: FinanceContext, unitId: string, party: LiableParty, unitNumber: string): Account {
    return newAccount(ctx, {
      accountId: receivableId(unitId, party),
      type: 'receivable',
      name: receivableName(unitNumber, party),
      unitId,
      liableParty: party,
    });
  }

  /** Finans 2.1: `split` dairede paydasin malik alt carisi. */
  function coOwnerReceivable(ctx: FinanceContext, unitId: string, userId: string, unitNumber: string): Account {
    return newAccount(ctx, {
      accountId: coOwnerReceivableId(unitId, userId),
      type: 'receivable',
      name: coOwnerReceivableName(unitNumber),
      unitId,
      liableParty: 'owner',
      coOwner: { userId },
    });
  }

  /** Hesap adi icin daire numarasi (bilinmiyorsa tek okuma; daire yoksa kimlik). */
  async function unitNumberOf(ctx: FinanceContext, unitId: string, known?: string): Promise<string> {
    if (known) return known;
    return (await deps.core.getUnit(ctx.apartmentId, unitId))?.number ?? unitId;
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

  /** Finans 2.4: hesap kodu dogrulamasi + apartman icinde benzersizlik. `null`/bos: kod yok. */
  async function parseAccountCode(ctx: FinanceContext, o: Obj, exceptAccountId?: string): Promise<string | undefined> {
    if (o.code === undefined || o.code === null || o.code === '') return undefined;
    if (typeof o.code !== 'string' || !ACCOUNT_CODE_RE.test(o.code.trim())) {
      throw new ValidationError('code 1-20 karakter; harf, rakam, nokta ve tire olabilir', 'code');
    }
    const code = o.code.trim();
    const clash = (await repo.listAccounts(ctx.apartmentId)).find((a) => a.code === code && a.accountId !== exceptAccountId);
    if (clash) throw new FinanceError('conflict', `Bu hesap kodu "${clash.name}" hesabinda kullaniliyor`);
    return code;
  }

  /**
   * Finans 2.4: tahakkukun alacak yazilacagi gelir hesabi. Verilmezse `income-dues`. Gecikme
   * tazminati hesabi yalnizca kesinlestirme icindir; secilemez.
   */
  async function resolveIncomeAccount(ctx: FinanceContext, value: unknown, field = 'incomeAccountId'): Promise<string> {
    if (value === undefined || value === null || value === '' || value === SYSTEM_ACCOUNTS.incomeDues) return SYSTEM_ACCOUNTS.incomeDues;
    const id = assertId(value, field);
    if (id === SYSTEM_ACCOUNTS.incomeLateFee) throw new ValidationError('Gecikme tazminati gelir hesabi tahakkukta secilemez', field);
    await ensureSystemAccounts(ctx);
    const acc = await repo.getAccount(ctx.apartmentId, id);
    if (!acc || acc.type !== 'income') throw new ValidationError(`${field} aktif bir gelir hesabi olmalidir`, field);
    if (acc.status !== 'active') throw new ValidationError(`${field} pasif bir gelir hesabi`, field);
    return id;
  }

  async function createAccount(ctx: FinanceContext, body: unknown): Promise<Account> {
    const o = asObject(body);
    const type = reqEnum(o, 'type', EDITABLE_ACCOUNT_TYPES);
    const accountId = o.accountId === undefined ? deps.newId() : assertId(o.accountId, 'accountId');
    const code = await parseAccountCode(ctx, o);
    const account = newAccount(ctx, { accountId, type, name: reqString(o, 'name', 120), ...(code ? { code } : {}) });
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
    const code = o.code === undefined ? existing.code : await parseAccountCode(ctx, o, accountId);
    const { code: _old, ...rest } = existing;
    const updated: Account = { ...rest, name, status, ...(code ? { code } : {}), updatedAt: stamp(), updatedBy: ctx.userId };
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
  /** coOwnerParts: `split` bolumde paydas basina tutar (Finans 2.1; bildirim kalemleri). */
  type DuesResult = {
    transaction: Transaction;
    replayed: boolean;
    liableParty: LiableParty;
    vacant: boolean;
    coOwnerParts?: { userId: string; amount: Kurus }[];
  };

  /** Bolunmus tahakkukun paydas kalemleri (islem satirlarindan; replay'de de ayni sonuc). */
  async function coOwnerPartsOf(ctx: FinanceContext, tx: Transaction): Promise<{ userId: string; amount: Kurus }[] | undefined> {
    const lines = tx.lines.filter((l) => l.side === 'debit' && l.unitId && isCoOwnerReceivableId(l.accountId, l.unitId));
    if (lines.length === 0) return undefined;
    const parts: { userId: string; amount: Kurus }[] = [];
    for (const l of lines) {
      const acc = await repo.getAccount(ctx.apartmentId, l.accountId);
      if (acc?.coOwner) parts.push({ userId: acc.coOwner.userId, amount: l.amount });
    }
    return parts.length ? parts : undefined;
  }

  /** DUE_GENERATED olayinda bolunmus kalemi paydas kalemlerine acar (her paydas kendi payini gorur). */
  function withCoOwnerItems(ev: NewEvent, unitId: string, parts: { userId: string; amount: Kurus }[] | undefined): NewEvent {
    if (!parts || ev.type !== 'DUE_GENERATED') return ev;
    return {
      ...ev,
      payload: {
        ...ev.payload,
        items: ev.payload.items.flatMap((it) =>
          it.unitId === unitId ? parts.map((x) => ({ ...it, amount: x.amount, userId: x.userId })) : [it],
        ),
      },
    };
  }

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
      /** Islem referansi (ornegin sayac donemi `METER_PERIOD:<periodId>`). */
      reference?: string;
      /**
       * Finans 2.3: hedef alt cari (ornegin ayrilan sakin carisi `recv-<unit>-<taraf>-c<kapama>`).
       * Verilirse paydas bolmesi yapilmaz; hesap yoksa bu kayitla olusturulur.
       */
      target?: Account;
      /** Bos daire kurali: `party` malik, istenen taraf sakin idi. */
      vacant?: boolean;
      /** Daire numarasi (hesap adi icin); verilmezse okunur. */
      unitNumber?: string;
      /** Finans 2.4: alacak yazilacak gelir hesabi (dogrulanmis); verilmezse `income-dues`. */
      incomeAccountId?: string;
      /** Yazimla ayni atomik islemde outbox'a yazilacak olay (islem kimligi belli olunca uretilir). */
      event?: (tx: Transaction) => NewEvent;
      /** O1-4: ayni atomik yazimda is belgeleri (onarim yansitma). */
      link?: WorkLinkHook;
    },
  ): Promise<DuesResult> {
    const replayed = async (transactionId: string): Promise<DuesResult> => {
      const t = await loadTx(ctx, transactionId);
      const parts = await coOwnerPartsOf(ctx, t);
      return { transaction: t, replayed: true, liableParty: chargedParty(t, p.party), vacant: t.vacant === true, ...(parts ? { coOwnerParts: parts } : {}) };
    };
    const replay = await replayOf(ctx, p.idemId, p.fp);
    if (replay) return replayed(replay.transactionId);

    // Finans 2.1: `split` dairede malik tahakkuku sicil paylariyla paydas alt carilerine bolunur
    // (en buyuk kalan; kurus kaybi yok). Tek islem, paydas basina bir borc satiri.
    const owners = !p.target && p.party === 'owner' && deps.ownership ? await deps.ownership.ownerSplitOn(ctx.apartmentId, p.unitId, p.date) : undefined;
    let debitLines: TransactionLine[];
    let coOwnerParts: { userId: string; amount: Kurus }[] | undefined;
    if (owners && owners.length > 0) {
      const parts = splitAmountByShares(p.amount, owners).filter((x) => x.amount > 0);
      coOwnerParts = parts.map((x) => ({ userId: x.userId, amount: toKurus(x.amount) }));
      const unitNo = await unitNumberOf(ctx, p.unitId, p.unitNumber);
      await repo.ensureAccounts(parts.map((x) => coOwnerReceivable(ctx, p.unitId, x.userId, unitNo)));
      debitLines = parts.map((x) => ({
        accountId: coOwnerReceivableId(p.unitId, x.userId),
        side: 'debit' as const,
        amount: toKurus(x.amount),
        unitId: p.unitId,
        liableParty: 'owner' as const,
      }));
    } else {
      const recv = p.target ?? receivable(ctx, p.unitId, p.party, await unitNumberOf(ctx, p.unitId, p.unitNumber));
      if (recv.type !== 'receivable' || recv.unitId !== p.unitId || recv.liableParty !== p.party) {
        throw new FinanceError('unprocessable', 'Hedef cari bu bolum / tarafla uyusmuyor');
      }
      await repo.ensureAccounts([recv]);
      debitLines = [{ accountId: recv.accountId, side: 'debit', amount: p.amount, unitId: p.unitId, liableParty: p.party }];
    }
    const tx = buildTx(ctx, {
      kind: 'dues_charge',
      date: p.date,
      dueDate: p.dueDate,
      description: p.vacant ? `${p.description}${VACANT_SUFFIX}` : p.description,
      batchId: p.batchId,
      ...(p.reference ? { reference: p.reference } : {}),
      ...(p.vacant ? { vacant: true as const } : {}),
      lines: [...debitLines, { accountId: p.incomeAccountId ?? SYSTEM_ACCOUNTS.incomeDues, side: 'credit', amount: p.amount }],
    });
    const outbox = p.event ? [toEvent(withCoOwnerItems(p.event(tx), p.unitId, coOwnerParts))] : undefined;
    for (let attempt = 1; ; attempt++) {
      try {
        if (p.link) {
          const extra = await p.link.build({ transaction: tx });
          const input = {
            transactions: [tx],
            idempotency: { id: p.idemId, fingerprint: p.fp },
            ...(outbox ? { outbox } : {}),
            ...(extra.replaceRecords?.length ? { replaceRecords: extra.replaceRecords } : {}),
            ...(extra.newDocs?.length ? { newDocs: extra.newDocs } : {}),
          };
          await repo.postBatch({ ...input, audit: withAuditDetails(ledgerAuditDraft(input, ctx.apartmentId), extra.auditDetails) });
        } else {
          await repo.postTransaction({ transaction: tx, idempotency: { id: p.idemId, fingerprint: p.fp }, ...(outbox ? { outbox } : {}) });
        }
        return { transaction: tx, replayed: false, liableParty: p.party, vacant: p.vacant === true, ...(coOwnerParts ? { coOwnerParts } : {}) };
      } catch (err) {
        if (err instanceof LedgerConflictError && err.reason === 'duplicate') {
          const again = await replayOf(ctx, p.idemId, p.fp);
          if (again) return replayed(again.transactionId);
        }
        if (err instanceof LedgerConflictError && err.reason === 'precondition' && p.link && attempt < MAX_ATTEMPTS) continue;
        throw mapConflict(err);
      }
    }
  }

  /**
   * O1-4: deftere yazim olmadan yalnizca is belgeleri (var olan masrafi baglama / bagi kaldirma).
   * Idempotent: ayni anahtar + ayni icerik -> `replayed`. Es zamanli belge degisikliginde
   * `build` guncel surumle yeniden cagrilir.
   */
  async function postWorkDocuments(
    ctx: FinanceContext,
    p: { idempotencyKey: string; fp: Record<string, unknown>; action: string; target: { type: string; id: string }; reason?: string; build: () => Promise<WorkLinkWrite> },
  ): Promise<{ replayed: boolean }> {
    assertId(p.idempotencyKey, 'idempotencyKey');
    const fp = fingerprint(p.fp);
    for (let attempt = 1; ; attempt++) {
      if (await replayOf(ctx, p.idempotencyKey, fp)) return { replayed: true };
      const w = await p.build();
      if (!w.replaceRecords?.length && !w.newDocs?.length) throw new Error('Yazilacak belge yok');
      try {
        await repo.postBatch({
          transactions: [],
          idempotency: { id: p.idempotencyKey, fingerprint: fp },
          ...(w.replaceRecords?.length ? { replaceRecords: w.replaceRecords } : {}),
          ...(w.newDocs?.length ? { newDocs: w.newDocs } : {}),
          audit: { apartmentId: ctx.apartmentId, action: p.action, target: p.target, actorId: ctx.userId, ...(p.reason ? { reason: p.reason } : {}), ...(w.auditDetails ? { details: w.auditDetails } : {}) },
        });
        return { replayed: false };
      } catch (err) {
        if (err instanceof LedgerConflictError && (err.reason === 'duplicate' || err.reason === 'precondition') && attempt < MAX_ATTEMPTS) continue;
        throw mapConflict(err);
      }
    }
  }

  /** O1-4: gider kaydi, islemi ve ters kayitla iptal edilip edilmedigi (REV_ isareti). */
  async function expenseInfo(ctx: FinanceContext, expenseId: string) {
    assertId(expenseId, 'expenseId');
    const expense = await repo.getExpense(ctx.apartmentId, expenseId);
    if (!expense) throw new FinanceError('not_found', 'Gider kaydi bulunamadi');
    const transaction = await loadTx(ctx, expense.transactionId);
    return { expense, transaction, reversed: await isReversed(ctx, expense.transactionId) };
  }

  /** Islem ters kayitla iptal edildi mi (elle ve banka geri almasi `REV_<islem>` isaretini yazar). */
  async function isReversed(ctx: FinanceContext, transactionId: string): Promise<boolean> {
    return !!(await repo.getIdempotency(ctx.apartmentId, `REV_${transactionId}`));
  }

  async function loadTx(ctx: FinanceContext, transactionId: string): Promise<Transaction> {
    const tx = await repo.getTransaction(ctx.apartmentId, transactionId);
    if (!tx) throw new FinanceError('not_found', 'Islem bulunamadi');
    return tx;
  }

  /** Tek bir bagimsiz bolume aidat/borc tahakkuku. */
  async function chargeUnit(ctx: FinanceContext, body: unknown, link?: WorkLinkHook): Promise<DuesResult> {
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
    const incomeAccountId = await resolveIncomeAccount(ctx, o.incomeAccountId);
    // Varsayilan gelir hesabi parmak izine girmez (eski isteklerle ayni kalir).
    const incomeFp = incomeAccountId === SYSTEM_ACCOUNTS.incomeDues ? {} : { incomeAccountId };
    const target = party === 'occupant' ? liablePartyFor(party, (await occupancyResolver(ctx, unitId))(unitId, date)) : { party, vacant: false };

    const result = await postDues(ctx, {
      // Parmak izi istenen tarafla hesaplanir: ayni istek, doluluk degisse de ayni istektir.
      idemId: key,
      fp: fingerprint({ op: 'dues', unitId, party, amount, date, dueDate, description, ...incomeFp, ...(link ? { link: link.fp } : {}) }),
      unitId,
      unitNumber: unit.number,
      ...(link ? { link, ...(link.reference ? { reference: link.reference } : {}) } : {}),
      incomeAccountId,
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
    const incomeAccountId = await resolveIncomeAccount(ctx, o.incomeAccountId);

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
      ...(incomeAccountId !== SYSTEM_ACCOUNTS.incomeDues ? { incomeAccountId } : {}),
    };
    return {
      incomeAccountId,
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
      incomeAccountId: plan.incomeAccountId,
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

  /**
   * Toplu tahakkuk ozet olayi (DUES_BATCH_SUMMARY): kullanici basina tek bildirim. Kimlikler
   * `batchId`'den deterministik: tekrar cagrilmasi ikinci olay uretmez (outbox kosullu yazim).
   */
  async function recordDuesBatchSummary(
    ctx: FinanceContext,
    p: {
      batchId: string;
      date: IsoDate;
      dueDate: IsoDate;
      description: string;
      liableParty: LiableParty;
      results: readonly { unitId: string; amount: Kurus; transactionId: string; liableParty: LiableParty; coOwnerParts?: { userId: string; amount: Kurus }[] }[];
    },
  ): Promise<number> {
    const { batchId, results } = p;
    if (results.length === 0) return 0;
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
            date: p.date,
            dueDate: p.dueDate,
            description: p.description,
            liableParty: p.liableParty,
            totalAmount: toKurus(chunk.reduce((sum, r) => sum + r.amount, 0)),
            // Finans 2.1: bolunmus kalem paydas basina (her paydas ozetinde kendi payini gorur).
            items: chunk.flatMap(({ unitId, amount, transactionId, liableParty, coOwnerParts }) =>
              coOwnerParts?.length
                ? coOwnerParts.map((x) => ({ unitId, amount: x.amount, transactionId, liableParty, userId: x.userId }))
                : [{ unitId, amount, transactionId, liableParty }],
            ),
          },
        }),
      );
    }
    return repo.recordEvents(ctx.apartmentId, events);
  }

  /**
   * Finans 2.3: sayac / endeks donemi kalemi. Mevcut tahakkuk yolu (`postDues`): bos daire kurali,
   * `split` paydas bolmesi ve outbox olayi ayni atomik yazimda. `former` verilirse kalem, donem
   * sonundaki sorumlunun kapama ile acilan ayrilan carisine yazilir (yeni sakine degil).
   * `idemId` (MDP_<periodId>_<unitId>) ile tekrar guvenli: yazilmis kalem yeniden yazilmaz.
   */
  async function chargeMeterLine(
    ctx: FinanceContext,
    p: {
      idemId: string;
      unitId: string;
      party: LiableParty;
      vacant: boolean;
      amount: number;
      date: IsoDate;
      dueDate: IsoDate;
      description: string;
      batchId: string;
      reference: string;
      former?: { closureId: string; sourceAccountId: string; userIds: string[]; periodStart?: IsoDate; periodEnd: IsoDate; unitNumber: string };
      /** Finans 2.4: sablonda secilen gelir hesabi (ornegin `income-heating`). */
      incomeAccountId?: string;
    },
  ) {
    if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT) throw new ValidationError('Tutar gecersiz', 'amount');
    await ensureSystemAccounts(ctx);
    const incomeAccountId = await resolveIncomeAccount(ctx, p.incomeAccountId);
    const target = p.former
      ? newAccount(ctx, {
          accountId: `${p.former.sourceAccountId}-c${p.former.closureId}`,
          type: 'receivable',
          name: `Daire ${p.former.unitNumber} - Ayrılan ${p.party === 'owner' ? 'malik' : 'sakin'} (${p.former.periodEnd.split('-').reverse().join('.')})`,
          unitId: p.unitId,
          liableParty: p.party,
          closureId: p.former.closureId,
          holder: { userIds: p.former.userIds, ...(p.former.periodStart ? { periodStart: p.former.periodStart } : {}), periodEnd: p.former.periodEnd },
        })
      : undefined;
    const amount = toKurus(p.amount);
    const r = await postDues(ctx, {
      idemId: p.idemId,
      fp: fingerprint({ op: 'meter', unitId: p.unitId, party: p.party, amount, date: p.date, dueDate: p.dueDate, description: p.description, batchId: p.batchId, reference: p.reference, target: target?.accountId ?? null, ...(incomeAccountId !== SYSTEM_ACCOUNTS.incomeDues ? { incomeAccountId } : {}) }),
      unitId: p.unitId,
      incomeAccountId,
      party: p.party,
      vacant: p.vacant,
      amount,
      date: p.date,
      dueDate: p.dueDate,
      description: p.description,
      batchId: p.batchId,
      reference: p.reference,
      ...(target ? { target } : {}),
      event: (tx) => ({
        eventId: `DUE_GENERATED:${tx.transactionId}`,
        type: 'DUE_GENERATED',
        apartmentId: ctx.apartmentId,
        actorId: ctx.userId,
        groupKey: p.unitId,
        payload: {
          mode: 'bulk',
          batchId: p.batchId,
          date: p.date,
          dueDate: p.dueDate,
          description: p.description,
          liableParty: p.party,
          totalAmount: amount,
          items: [{ unitId: p.unitId, amount, transactionId: tx.transactionId, liableParty: p.party }],
        },
      }),
    });
    return {
      transactionId: r.transaction.transactionId,
      replayed: r.replayed,
      liableParty: r.liableParty,
      vacant: r.vacant,
      accountIds: r.transaction.lines.filter((l) => l.side === 'debit').map((l) => l.accountId),
      ...(r.coOwnerParts ? { coOwnerParts: r.coOwnerParts } : {}),
    };
  }

  /**
   * Toplu tahakkukun dondurulmus plani (yazmaz): asenkron is bu satirlari saklar ve parca parca
   * `postBulkLine` ile yazar. Senkron `chargeBulk` ayni plani ve ayni satir yazimini kullanir;
   * bu yuzden ayni `idempotencyKey` iki yol arasinda guvenle paylasilir (kalem anahtari
   * `<key>_<unitId>`, parmak izi ayni).
   */
  async function planBulkJob(ctx: FinanceContext, body: unknown) {
    const o = asObject(body);
    const key = reqKey(o);
    const plan = await planBulk(ctx, o);
    if (plan.included.length === 0) {
      throw new FinanceError(
        'unprocessable',
        plan.exempt.length ? 'Kapsamdaki tum bagimsiz bolumler bu gider kaleminden muaf' : 'Tahakkuk icin aktif bagimsiz bolum yok',
      );
    }
    const spec: BulkDuesSpec = {
      idempotencyKey: key,
      batchId: `${compact(plan.date)}-${key}`,
      liableParty: plan.party,
      totalAmount: plan.totalAmount,
      distributionKey: plan.distributionKey,
      date: plan.date,
      dueDate: plan.dueDate,
      description: plan.description,
      incomeAccountId: plan.incomeAccountId,
      scopeFp: plan.scopeFp,
      ...(plan.expenseCategory ? { expenseCategory: plan.expenseCategory } : {}),
    };
    const lines: BulkDuesLine[] = [];
    plan.included.forEach((unit, i) => {
      const amount = plan.shares[i] ?? 0;
      if (amount < 1) return; // cok kucuk pay: 0 kurus borc yazilmaz
      lines.push({ unitId: unit.unitId, unitNumber: unit.number, amount, party: plan.targets[i]?.party ?? plan.party, vacant: plan.targets[i]?.vacant ?? false });
    });
    return { spec, lines, exempt: plan.exempt, vacant: plan.vacant, unitCount: plan.included.length };
  }

  /** Toplu tahakkukun tek kalemi (idempotent). Senkron ve asenkron yol ayni fonksiyonu kullanir. */
  async function postBulkLine(ctx: FinanceContext, spec: BulkDuesSpec, line: BulkDuesLine): Promise<BulkDuesLineResult> {
    const amount = toKurus(line.amount);
    const { idempotencyKey: key, batchId, liableParty: party, totalAmount, distributionKey, date, dueDate, description } = spec;
    const r = await postDues(ctx, {
      idemId: `${key}_${line.unitId}`,
      fp: fingerprint({ op: 'bulk', unitId: line.unitId, party, amount, date, dueDate, description, distributionKey, totalAmount, ...spec.scopeFp }),
      unitId: line.unitId,
      unitNumber: line.unitNumber,
      incomeAccountId: spec.incomeAccountId,
      party: line.party,
      vacant: line.vacant,
      amount,
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
        groupKey: line.unitId,
        payload: {
          mode: 'bulk',
          batchId,
          date,
          dueDate,
          description,
          liableParty: party,
          totalAmount: amount,
          items: [{ unitId: line.unitId, amount, transactionId: tx.transactionId, liableParty: line.party }],
        },
      }),
    });
    return {
      unitId: line.unitId,
      amount,
      transactionId: r.transaction.transactionId,
      replayed: r.replayed,
      liableParty: r.liableParty,
      vacant: r.vacant,
      ...(r.coOwnerParts ? { coOwnerParts: r.coOwnerParts } : {}),
    };
  }

  /** Is basinda bir kez: sistem hesaplari (gelir hesabi dahil) hazir olsun. */
  async function prepareBulkPosting(ctx: FinanceContext): Promise<void> {
    await ensureSystemAccounts(ctx);
  }

  /**
   * Senkron toplu tahakkuk (kucuk kapsam). `SYNC_BULK_UNITS` ustu kapsam HTTP isteginde
   * calistirilmaz (`bulk_too_large`); arka plan isi (`POST /api/finance/dues/jobs`) kullanilir.
   * `allowLarge`: zamanlanmis gorev worker'i gibi istek suresi siniri olmayan cagiranlar.
   */
  async function chargeBulk(ctx: FinanceContext, body: unknown, opts: { allowLarge?: boolean } = {}) {
    const { spec, lines, exempt, vacant, unitCount } = await planBulkJob(ctx, body);
    if (!opts.allowLarge && unitCount > SYNC_BULK_UNITS) {
      throw new BulkTooLargeError(
        unitCount,
        `${unitCount} bagimsiz bolumlu toplu tahakkuk arka planda calisir (en fazla ${SYNC_BULK_UNITS} bolum aninda yazilir); POST /api/finance/dues/jobs kullanin`,
      );
    }
    await prepareBulkPosting(ctx);
    const results: BulkDuesLineResult[] = [];
    for (const line of lines) results.push(await postBulkLine(ctx, spec, line));

    // Tek ozet olay (bildirim): tum kalemler yazildiktan SONRA. Istek yarida kesilirse ozet
    // yazilmaz; ayni anahtarla tamamlama (replay dahil) TUM kalemlerle ozeti yazar. Kimlik
    // deterministik oldugundan tekrar eden istek ikinci ozet uretmez.
    await recordDuesBatchSummary(ctx, { batchId: spec.batchId, date: spec.date, dueDate: spec.dueDate, description: spec.description, liableParty: spec.liableParty, results });

    return {
      batchId: spec.batchId,
      distributionKey: spec.distributionKey,
      totalAmount: toKurus(spec.totalAmount),
      distributedAmount: toKurus(results.reduce((s, r) => s + r.amount, 0)),
      count: results.length,
      replayed: results.length > 0 && results.every((r) => r.replayed),
      items: results,
      ...(spec.expenseCategory ? { expenseCategory: spec.expenseCategory } : {}),
      exempt,
      vacant: results.filter((r) => r.vacant).map((r) => vacant.find((v) => v.unitId === r.unitId) ?? { unitId: r.unitId }),
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
    const recv = former ?? receivable(ctx, unitId, party, unit.number);
    if (!former) await repo.ensureAccounts([recv]);

    for (let attempt = 1; ; attempt++) {
      const counterValue = await repo.getCounter(ctx.apartmentId, 'receipt');
      const paymentId = deps.newId();
      const tx = buildTx(ctx, {
        kind: 'payment',
        date: paidAt,
        description: former
          ? former.coOwner
            ? `Tahsilat - Daire ${unit.number} (paydaş)`
            : `Tahsilat - Daire ${unit.number} (ayrılan ${party === 'owner' ? 'malik' : 'sakin'})`
          : `Tahsilat - Daire ${unit.number}`,
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
      // Finans 2.1: hedef alt cari yalnizca dairenin guncel (ana veya paydas) carisi olabilir.
      if (a.accountId !== undefined) {
        assertId(a.accountId, 'allocations.accountId');
        if (!isPrimaryReceivableId(a.accountId, p.unitId, a.liableParty)) {
          throw new ValidationError('allocations.accountId bu dairenin guncel alt carisi olmali', 'allocations');
        }
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
      // Paydas alt carisi tahakkukla acilmistir; yalnizca ana cariler burada garanti edilir.
      ...p.allocations.filter((a) => !a.accountId || a.accountId === receivableId(p.unitId, a.liableParty)).map((a) => receivable(ctx, p.unitId, a.liableParty, unit.number)),
    ]);

    const ordered = [...p.allocations].sort((a, b) => a.liableParty.localeCompare(b.liableParty));
    for (let attempt = 1; ; attempt++) {
      const counterValue = await repo.getCounter(ctx.apartmentId, 'receipt');
      const transactions: Transaction[] = [];
      const payments: Payment[] = [];
      for (const [i, a] of ordered.entries()) {
        const recvId = a.accountId ?? receivableId(p.unitId, a.liableParty);
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
          ...(recvId !== receivableId(p.unitId, a.liableParty) ? { receivableAccountId: recvId } : {}),
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

  async function recordExpense(ctx: FinanceContext, body: unknown, link?: WorkLinkHook) {
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
      ...(link ? { link: link.fp } : {}),
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
        ...financeKeys.expenseIndex(ctx.apartmentId, date, expenseId),
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
        ...(link?.expenseLink ? { link: link.expenseLink } : {}),
        createdAt: tx.createdAt,
        createdBy: ctx.userId,
      };
      try {
        // Kasa/banka yetersiz bakiye kontrolu es zamanli islemlere karsi surumle korunur.
        const expectedVersions = isFunds ? { [creditAccountId]: credit.version } : undefined;
        if (link) {
          // O1-4: gider + is ozeti + EXPLINK kilidi + olay TEK atomik yazim.
          const extra = await link.build({ transaction: tx, expense });
          const input = {
            transactions: [tx],
            idempotency: { id: key, fingerprint: fp, recordId: expenseId },
            expectedVersions,
            records: [expense],
            ...(extra.replaceRecords?.length ? { replaceRecords: extra.replaceRecords } : {}),
            ...(extra.newDocs?.length ? { newDocs: extra.newDocs } : {}),
          };
          await repo.postBatch({ ...input, audit: withAuditDetails(ledgerAuditDraft(input, ctx.apartmentId), extra.auditDetails) });
        } else {
          await repo.postTransaction({
            transaction: tx,
            idempotency: { id: key, fingerprint: fp, recordId: expenseId },
            expectedVersions,
            record: expense,
          });
        }
        return { expense, transaction: tx, replayed: false };
      } catch (err) {
        if (err instanceof LedgerConflictError) {
          if (err.reason === 'duplicate') {
            const again = await replayOf(ctx, key, fp);
            if (again) return expenseResult(ctx, again, true);
          }
          if (err.reason === 'version' && attempt < MAX_ATTEMPTS) continue;
          // Is belgesi (talep / gorev) es zamanli degisti: guncel surumle yeniden kur.
          if (err.reason === 'precondition' && link && attempt < MAX_ATTEMPTS) continue;
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

  /**
   * Ters kayit engeli (yoksa undefined). `reverseTransaction` ve toplu geri alma onizlemesi ayni
   * kurallari kullanir: ters kayit / devir / mahsup / yapilandirma islemi; hedefli mahsupla (plan,
   * avans mahsubu) kapatilmis kalem; tasinma kapamasiyla kapatilmis doneme ait kayit.
   */
  async function reversalBlockOf(
    ctx: FinanceContext,
    original: Transaction,
    preloaded?: { all: Transaction[]; cancelled: Set<string> },
  ): Promise<{ code: string; message: string } | undefined> {
    if (original.kind === 'reversal') return { code: 'is_reversal', message: 'Ters kayit tekrar ters cevrilemez' };
    if (original.kind === 'transfer') return { code: 'transfer', message: 'Cari devri islemleri yalnizca kapamanin geri alinmasiyla cevrilebilir' };
    if (original.kind === 'offset') return { code: 'offset', message: 'Avans mahsubu yalnizca mahsup kaydindan geri alinabilir' };
    if (original.kind === 'restructure') return { code: 'restructure', message: 'Yapilandirma islemleri yalnizca planin iptaliyle cevrilebilir' };
    // Finans 2.2: hedefli mahsupla (yapilandirma / mahsup) kapatilmis bir kalemin islemi ters
    // cevrilemez; once ilgili plan veya mahsup geri alinmali.
    if (original.lines.some((l) => l.side === 'debit' && l.unitId && l.liableParty)) {
      const all = preloaded?.all ?? (await repo.listTransactions(ctx.apartmentId)).items;
      const cancelledIds = preloaded?.cancelled ?? cancelledTransactions(all);
      const prefix = original.transactionId;
      const settled = all.some(
        (t) =>
          !cancelledIds.has(t.transactionId) &&
          t.lines.some((l) => l.settles?.some((x) => x.chargeId === prefix || x.chargeId.startsWith(`${prefix}_`))),
      );
      if (settled) {
        return { code: 'settled', message: 'Bu kalem bir yapılandırma planına veya avans mahsubuna bağlı; önce plan/mahsup geri alınmalı' };
      }
    }
    // Kapatilmis doneme ait kayit: kalemi devredildi; ters kayit kaynakta etkisiz kalir.
    for (const accountId of new Set(original.lines.filter((l) => l.unitId && l.liableParty).map((l) => l.accountId))) {
      const acc = await repo.getAccount(ctx.apartmentId, accountId);
      if (acc?.closedThrough && original.date <= acc.closedThrough) {
        return {
          code: 'closed_period',
          message: `Bu islem tasinma kapamasiyla ${acc.closedThrough} tarihinde kapatilan doneme ait; duzeltmeyi borcun devredildigi caride yapin`,
        };
      }
    }
    return undefined;
  }

  /**
   * Finans 2.3: toplu geri alma onizlemesi. Zaten ters kaydedilmis islemler `reversed` doner
   * (yarida kalan geri almanin devami); diger islemler icin engel varsa nedeniyle.
   */
  async function reversalStatus(ctx: FinanceContext, transactionIds: readonly string[]) {
    const all = (await repo.listTransactions(ctx.apartmentId)).items;
    const cancelled = cancelledTransactions(all);
    const byId = new Map(all.map((t) => [t.transactionId, t]));
    const out: { transactionId: string; state: 'reversible' | 'reversed' | 'blocked' | 'missing'; code?: string; message?: string; lateFeeAfter?: string[] }[] = [];
    for (const id of transactionIds) {
      const t = byId.get(id);
      if (!t) {
        out.push({ transactionId: id, state: 'missing', message: 'Islem bulunamadi' });
        continue;
      }
      if (cancelled.has(id)) {
        out.push({ transactionId: id, state: 'reversed' });
        continue;
      }
      const block = await reversalBlockOf(ctx, t, { all, cancelled });
      // Karar 4: kalemin vadesinden sonra ayni caride kesinlesmis gecikme tazminati (uyari).
      const accounts = new Set(t.lines.filter((l) => l.side === 'debit' && l.unitId).map((l) => l.accountId));
      const lateFeeAfter = all
        .filter(
          (x) =>
            x.kind === 'late_fee' &&
            !cancelled.has(x.transactionId) &&
            !!t.dueDate &&
            x.date > t.dueDate &&
            x.lines.some((l) => l.side === 'debit' && accounts.has(l.accountId)),
        )
        .map((x) => x.transactionId);
      out.push({
        transactionId: id,
        state: block ? 'blocked' : 'reversible',
        ...(block ? { code: block.code, message: block.message } : {}),
        ...(lateFeeAfter.length ? { lateFeeAfter } : {}),
      });
    }
    return out;
  }

  async function reverseTransaction(ctx: FinanceContext, transactionId: string, body: unknown) {
    assertId(transactionId, 'transactionId');
    const o = asObject(body);
    const reason = reqString(o, 'reason', 300);
    const date = optDate(o, 'date') ?? today();

    const original = await loadTx(ctx, transactionId);
    const blocked = await reversalBlockOf(ctx, original);
    if (blocked) throw new FinanceError('unprocessable', blocked.message);
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
    // Daire bakiyesi guncel carilerden (ana + `split` dairede paydas alt carileri) olusur; ayrilan
    // sakin/malik carileri ayri gosterilir.
    const main = (a: Account) => a.liableParty !== undefined && isPrimaryReceivableId(a.accountId, unitId, a.liableParty);
    const of = (party: LiableParty) =>
      accounts.filter((a) => main(a) && a.liableParty === party).reduce((s, a) => s + a.balance, 0);
    const owner = of('owner');
    const occupant = of('occupant');
    const net = owner + occupant;
    const formerAccounts = accounts.filter((a) => !main(a));
    const coOwnerAccounts = accounts.filter((a) => main(a) && a.coOwner);
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
      ...(coOwnerAccounts.length
        ? {
            coOwners: coOwnerAccounts
              .map((a) => ({ accountId: a.accountId, userId: a.coOwner?.userId as string, name: a.name, ...split(a.balance) }))
              .sort((a, b) => a.userId.localeCompare(b.userId)),
          }
        : {}),
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
    // Worker'da istek suresi siniri yok (300 sn); cok buyuk siteler icin zamanlayici bu istegi
    // `autoDuesRequest` ile arka plan isine cevirir (bulkjobs).
    const result = await chargeBulk(ctx, autoDuesBody(p.period, p.plan, p.dueDayOfMonth), { allowLarge: true });
    return { status: 'charged' as const, ...result };
  }

  /** Aylik aidat planinin toplu tahakkuk govdesi (senkron ve asenkron yol ayni anahtarla). */
  function autoDuesBody(period: string, plan: MonthlyDuesPlan, dueDayOfMonth: number) {
    const { first } = periodBounds(period);
    return {
      idempotencyKey: `auto-dues-${period}`,
      liableParty: plan.liableParty,
      totalAmount: plan.totalAmount,
      distributionKey: plan.distributionKey,
      date: first,
      dueDate: `${period}-${String(dueDayOfMonth).padStart(2, '0')}`,
      description: `${periodLabel(period)} aidatı`,
      ...(plan.incomeAccountId ? { incomeAccountId: plan.incomeAccountId } : {}),
    };
  }

  /** Zamanlayici icin: plan kapaliysa `undefined`, aciksa toplu tahakkuk govdesi. */
  function autoDuesRequest(p: { period: string; plan: MonthlyDuesPlan | undefined; dueDayOfMonth: number }) {
    assertPeriod(p.period);
    if (!p.plan?.enabled) return undefined;
    return autoDuesBody(p.period, p.plan, p.dueDayOfMonth);
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
                items: [
                  {
                    unitId,
                    liableParty: party,
                    amount: toKurus(amount),
                    transactionId: tx.transactionId,
                    ...(account.coOwner ? { userId: account.coOwner.userId } : {}),
                  },
                ],
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
    const recv = receivable(ctx, p.unitId, p.party, await unitNumberOf(ctx, p.unitId));
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
    // Daire guncel carileri: ana cariler ve (Finans 2.1) paydas alt carileri. Ayrilan sakin
    // carilerinin sahibine portal/bildirim erisimi yok; hatirlatma bugunku sakine gitmemeli.
    const current = accounts.filter(
      (a) => a.type === 'receivable' && a.unitId && a.liableParty && isPrimaryReceivableId(a.accountId, a.unitId, a.liableParty),
    );
    const receivables = new Set(current.map((a) => a.accountId));
    // Paydas alt carisinin hatirlatmasi yalnizca o paydasa.
    const holders = new Map(current.filter((a) => a.coOwner).map((a) => [a.accountId, (a.coOwner as { userId: string }).userId]));
    return buildDueReminders(txPage.items, receivables, date, holders);
  }

  // -------------------------------------------------------------------------
  // Faz B2: banka satiri eslestirme (tahsilat) ve geri alma (ters kayit)
  // -------------------------------------------------------------------------

  /**
   * Banka satirini TEK atomik yazimla tahsilata cevirir (online odemeyle ayni kalip):
   *  - alt cari basina tahsilat (`payment`, borc: banka hesabi) + makbuz + PAYMENT_RECEIVED olayi
   *  - tazminati olan alt cariler icin odeme aninda kesinlesen tazminat TEK `late_fee` islemiyle
   *  - banka modulunun belgeleri (BANKMATCH, BANKTX durum gecisi, PAYER) ve denetim kaydi
   * Kapali (closedThrough) cariye yazim `LedgerConflictError('closed')` olarak OLDUGU GIBI firlatilir:
   * cagiran (banka modulu) ayrilan cariyi onerebilsin.
   */
  async function recordBankPayment(ctx: FinanceContext, p: BankPaymentInput) {
    assertId(p.idempotencyId, 'idempotencyId');
    assertId(p.depositAccountId, 'depositAccountId');
    if (!isIsoDate(p.paidAt)) throw new ValidationError('paidAt YYYY-MM-DD olmali', 'paidAt');
    if (p.allocations.length < 1 || p.allocations.length > 10) throw new ValidationError('allocations 1-10 alt cari icermeli', 'allocations');
    const seen = new Set<string>();
    for (const a of p.allocations) {
      assertId(a.accountId, 'allocations.accountId');
      if (seen.has(a.accountId)) throw new ValidationError('Ayni alt cari birden fazla kez secilemez', 'allocations');
      seen.add(a.accountId);
      if (!Number.isSafeInteger(a.amount) || a.amount < 1 || a.amount > MAX_AMOUNT) throw new ValidationError('allocations.amount pozitif kurus olmali', 'allocations');
      if (!Number.isSafeInteger(a.lateFee) || a.lateFee < 0 || a.lateFee > MAX_AMOUNT) throw new ValidationError('allocations.lateFee gecersiz', 'allocations');
    }
    const fp = fingerprint({ op: 'bank_payment', depositAccountId: p.depositAccountId, paidAt: p.paidAt, reference: p.reference, allocations: p.allocations });
    const replay = async () => {
      const existing = await repo.getIdempotency(ctx.apartmentId, p.idempotencyId);
      if (!existing) return undefined;
      if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu eslestirme farkli bir dagilimla kaydedilmis');
      const payments = (await Promise.all((existing.recordIds ?? []).map((id) => repo.getPayment(ctx.apartmentId, id)))).filter((x): x is Payment => !!x);
      const transactions = (
        await Promise.all((existing.transactionIds ?? [existing.transactionId]).map((id) => repo.getTransaction(ctx.apartmentId, id)))
      ).filter((x): x is Transaction => !!x);
      return { payments, transactions, allocations: [] as ResolvedBankAllocation[], replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;

    await ensureSystemAccounts(ctx);
    const deposit = await repo.getAccount(ctx.apartmentId, p.depositAccountId);
    if (!deposit || deposit.type !== 'bank' || deposit.status !== 'active') {
      throw new FinanceError('unprocessable', 'Tahsilat hesabi aktif bir banka hesabi olmali');
    }
    const resolved: (ResolvedBankAllocation & { unitNumber: string; former: boolean })[] = [];
    for (const a of p.allocations) {
      const acc = await repo.getAccount(ctx.apartmentId, a.accountId);
      if (!acc || acc.type !== 'receivable' || !acc.unitId || !acc.liableParty) {
        throw new FinanceError('unprocessable', `Alt cari bulunamadi: ${a.accountId}`);
      }
      const unit = await deps.core.getUnit(ctx.apartmentId, acc.unitId);
      resolved.push({
        ...a,
        unitId: acc.unitId,
        liableParty: acc.liableParty,
        unitNumber: unit?.number ?? acc.unitId,
        former: acc.accountId !== receivableId(acc.unitId, acc.liableParty),
      });
    }

    for (let attempt = 1; ; attempt++) {
      const counterValue = await repo.getCounter(ctx.apartmentId, 'receipt');
      const transactions: Transaction[] = [];
      const payments: Payment[] = [];
      const fees = resolved.filter((a) => a.lateFee > 0);
      if (fees.length > 0) {
        const total = fees.reduce((s, a) => s + a.lateFee, 0);
        const fee = buildTx(ctx, {
          kind: 'late_fee',
          date: p.paidAt,
          dueDate: p.paidAt,
          description: 'Gecikme tazminatı (banka tahsilatında kesinleşen)',
          reference: `LATE_FEE:BANK:${p.idempotencyId}`,
          lines: [
            ...fees.map((a) => ({ accountId: a.accountId, side: 'debit' as const, amount: a.lateFee, unitId: a.unitId, liableParty: a.liableParty })),
            { accountId: SYSTEM_ACCOUNTS.incomeLateFee, side: 'credit', amount: toKurus(total) },
          ],
        });
        // Ekstrede tazminat, ayni gunun tahsilatindan once gorunsun.
        fee.createdAt = new Date(Date.parse(fee.createdAt) - 1).toISOString();
        transactions.push(fee);
      }
      for (const [i, a] of resolved.entries()) {
        const tx = buildTx(ctx, {
          kind: 'payment',
          date: p.paidAt,
          description: a.former
            ? isCoOwnerReceivableId(a.accountId, a.unitId)
              ? `Banka tahsilatı - Daire ${a.unitNumber} (paydaş)`
              : `Banka tahsilatı - Daire ${a.unitNumber} (ayrılan ${a.liableParty === 'owner' ? 'malik' : 'sakin'})`
            : `Banka tahsilatı - Daire ${a.unitNumber}`,
          reference: p.reference,
          lines: [
            { accountId: p.depositAccountId, side: 'debit', amount: a.amount },
            { accountId: a.accountId, side: 'credit', amount: a.amount, unitId: a.unitId, liableParty: a.liableParty },
          ],
        });
        transactions.push(tx);
        const paymentId = deps.newId();
        payments.push({
          ...financeKeys.payment(ctx.apartmentId, paymentId),
          entityType: 'PAYMENT',
          paymentId,
          siteId: ctx.apartmentId,
          unitId: a.unitId,
          liableParty: a.liableParty,
          method: 'bank_transfer',
          amount: a.amount,
          depositAccountId: p.depositAccountId,
          receiptNumber: `MKB-${String(counterValue + i + 1).padStart(6, '0')}`,
          transactionId: tx.transactionId,
          paidAt: p.paidAt,
          payerName: p.payerName,
          note: p.note,
          ...(a.former ? { receivableAccountId: a.accountId } : {}),
          createdAt: tx.createdAt,
          createdBy: ctx.userId,
        });
      }

      const allocations: ResolvedBankAllocation[] = resolved.map(({ unitNumber: _n, former: _f, ...a }) => a);
      const docs = p.documents({ payments, transactions, allocations });
      try {
        await repo.postBatch({
          transactions,
          idempotency: {
            id: p.idempotencyId,
            fingerprint: fp,
            transactionIds: transactions.map((t) => t.transactionId),
            recordIds: payments.map((x) => x.paymentId),
          },
          counter: { name: 'receipt', expected: counterValue, increment: payments.length },
          records: payments,
          ...(docs.newDocs?.length ? { newDocs: docs.newDocs } : {}),
          ...(docs.replaceRecords?.length ? { replaceRecords: docs.replaceRecords } : {}),
          ...(docs.audit ? { audit: docs.audit } : {}),
          outbox: payments.map((payment) =>
            toEvent({
              eventId: `PAYMENT_RECEIVED:${payment.paymentId}`,
              type: 'PAYMENT_RECEIVED',
              apartmentId: ctx.apartmentId,
              actorId: ctx.userId,
              groupKey: payment.unitId,
              payload: {
                paymentId: payment.paymentId,
                transactionId: payment.transactionId,
                receiptNumber: payment.receiptNumber,
                unitId: payment.unitId,
                liableParty: payment.liableParty,
                amount: payment.amount,
                method: payment.method,
                paidAt: payment.paidAt,
                ...(payment.receivableAccountId ? { receivableAccountId: payment.receivableAccountId } : {}),
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
          // closed: kapali cari; precondition: banka satiri baska istekle degismis. Cagiran ele alir.
          if (err.reason === 'closed' || err.reason === 'precondition') throw err;
        }
        throw mapConflict(err);
      }
      return { payments, transactions, allocations, replayed: false };
    }
  }

  /**
   * Faz B3: bankadan cikan satiri gider olarak deftere isler (gider hesabi borc, banka alacak).
   * Banka ekstresi gerceklesmis odemenin kaydidir: kasa/banka "yetersiz bakiye" kontrolu
   * UYGULANMAZ (defterde henuz eslestirilmemis tahsilatlar olabilir). Kapali donem kilidi ve
   * banka satirinin surum kosulu (`precondition`) cagirana oldugu gibi iletilir.
   */
  // -------------------------------------------------------------------------
  // Faz B3.5: tedarikci (payable) borcu
  // -------------------------------------------------------------------------

  /** Acik tedarikci borcu (alacak-normal hesap; depoda borc - alacak tutulur). */
  const openOf = (a: Pick<Account, 'balance'>) => Math.max(0, -a.balance);

  async function summaryOf(apartmentId: string, accountId: string): Promise<PayableSummary> {
    const entries = (await deps.ledger.listLedgerEntries(apartmentId, accountId)).filter((e) => e.siteId === apartmentId && e.accountId === accountId);
    const ids = [...new Set(entries.map((e) => e.transactionId))];
    const txs = ids.length ? await deps.ledger.getTransactions(apartmentId, ids) : [];
    return payableSummary(accountId, entries, new Map(txs.map((t) => [t.transactionId, t])));
  }

  /**
   * Tedarikci hesaplari: acik borc (hesap bakiyesi), fatura/odeme toplamlari ve acik faturalar
   * (FIFO). Pasif hesaplar yalnizca borcu varsa listelenir.
   */
  async function listPayables(ctx: FinanceContext, q: { includeItems?: boolean } = {}) {
    await ensureSystemAccounts(ctx);
    const accounts = (await repo.listAccounts(ctx.apartmentId)).filter((a) => a.type === 'payable' && (a.status === 'active' || a.balance !== 0));
    const items = await Promise.all(
      accounts.map(async (a) => {
        const sum = q.includeItems === false ? undefined : await summaryOf(ctx.apartmentId, a.accountId);
        return {
          accountId: a.accountId,
          name: a.name,
          status: a.status,
          openBalance: openOf(a),
          version: a.version,
          ...(sum
            ? {
                billed: sum.billed,
                paid: sum.paid,
                openItems: sum.openItems.slice(0, 50),
                openItemCount: sum.openItems.length,
                ...(sum.lastPaymentDate ? { lastPaymentDate: sum.lastPaymentDate } : {}),
              }
            : {}),
        };
      }),
    );
    items.sort((a, b) => b.openBalance - a.openBalance || a.name.localeCompare(b.name, 'tr'));
    return { items, totalOpen: items.reduce((s, i) => s + i.openBalance, 0) };
  }

  /**
   * Tedarikci odemesi (ortak yol). Acik borctan fazla odeme reddedilir (avans mahsubu Finans
   * asamasinda); kontrol tedarikci hesabinin surumuyle kosullanir (es zamanli iki odeme ayni
   * borcu iki kez kapatamaz). `checkFunds`: elle odemede kasa/banka bakiyesi yetmeli; banka
   * ekstresinden gelen odeme gerceklesmis harekettir, bakiye kontrolu yapilmaz.
   */
  async function postPayablePayment(
    ctx: FinanceContext,
    p: {
      idempotencyId: string;
      fp: string;
      payableAccountId: string;
      fundsAccountId: string;
      amount: Kurus;
      date: IsoDate;
      description: string;
      reference?: string;
      checkFunds: boolean;
      documents?: (r: { transaction: Transaction; payable: Account }) => BankLedgerDocuments;
    },
  ): Promise<{ transaction: Transaction; payable: Account; replayed: boolean }> {
    const replay = async () => {
      const prev = await replayOf(ctx, p.idempotencyId, p.fp);
      if (!prev) return undefined;
      const payable = await repo.getAccount(ctx.apartmentId, p.payableAccountId);
      return { transaction: await loadTx(ctx, prev.transactionId), payable: payable as Account, replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;
    await ensureSystemAccounts(ctx);

    for (let attempt = 1; ; attempt++) {
      const payable = await repo.getAccount(ctx.apartmentId, p.payableAccountId);
      if (!payable) throw new FinanceError('not_found', 'Tedarikci hesabi bulunamadi');
      if (payable.type !== 'payable') throw new FinanceError('unprocessable', 'Hesap bir tedarikci (borc) hesabi olmali');
      const funds = await repo.getAccount(ctx.apartmentId, p.fundsAccountId);
      if (!funds || (funds.type !== 'cash' && funds.type !== 'bank') || funds.status !== 'active') {
        throw new FinanceError('unprocessable', 'Odeme hesabi aktif bir kasa/banka hesabi olmali');
      }
      const open = openOf(payable);
      if (p.amount > open) {
        throw new FinanceError('unprocessable', `Odeme tutari tedarikcinin acik borcunu asiyor (acik borc: ${open} kurus); avans mahsubu henuz desteklenmiyor`);
      }
      if (p.checkFunds && funds.balance < p.amount) throw new FinanceError('insufficient_funds', 'Kasa/banka bakiyesi bu odeme icin yetersiz');

      const transaction = buildTx(ctx, {
        kind: 'payable_payment',
        date: p.date,
        description: p.description,
        reference: p.reference,
        lines: [
          { accountId: p.payableAccountId, side: 'debit', amount: p.amount },
          { accountId: p.fundsAccountId, side: 'credit', amount: p.amount },
        ],
      });
      const docs: BankLedgerDocuments = p.documents?.({ transaction, payable }) ?? {};
      try {
        await repo.postBatch({
          transactions: [transaction],
          idempotency: { id: p.idempotencyId, fingerprint: p.fp },
          expectedVersions: {
            [p.payableAccountId]: payable.version,
            ...(p.checkFunds ? { [p.fundsAccountId]: funds.version } : {}),
          },
          ...(docs.newDocs?.length ? { newDocs: docs.newDocs } : {}),
          ...(docs.replaceRecords?.length ? { replaceRecords: docs.replaceRecords } : {}),
          ...(docs.audit ? { audit: docs.audit } : {}),
        });
        return { transaction, payable, replayed: false };
      } catch (err) {
        if (err instanceof LedgerConflictError) {
          if (err.reason === 'duplicate') {
            const again = await replay();
            if (again) return again;
          }
          if (err.reason === 'version' && attempt < MAX_ATTEMPTS) continue;
          if (err.reason === 'closed' || err.reason === 'precondition') throw err;
        }
        throw mapConflict(err);
      }
    }
  }

  /** Elle tedarikci odemesi: `POST /api/finance/payables/:accountId/payments`. */
  async function recordPayablePayment(ctx: FinanceContext, payableAccountId: string, body: unknown) {
    assertId(payableAccountId, 'accountId');
    const o = asObject(body);
    const key = reqKey(o);
    const fundsAccountId = o.fundsAccountId === undefined ? SYSTEM_ACCOUNTS.bank : assertId(o.fundsAccountId, 'fundsAccountId');
    const amount = reqAmount(o, 'amount');
    const date = optDate(o, 'date') ?? today();
    const reference = optString(o, 'reference', 60);
    const description = optString(o, 'description', 200) ?? 'Tedarikçi ödemesi';
    const fp = fingerprint({ op: 'payable_payment', payableAccountId, fundsAccountId, amount, date, description, reference });
    const r = await postPayablePayment(ctx, {
      idempotencyId: key,
      fp,
      payableAccountId,
      fundsAccountId,
      amount,
      date,
      description,
      ...(reference ? { reference } : {}),
      checkFunds: true,
    });
    const after = await repo.getAccount(ctx.apartmentId, payableAccountId);
    return { transaction: r.transaction, replayed: r.replayed, openBalance: after ? openOf(after) : 0 };
  }

  /** Banka ekstresinden tedarikci odemesi (banka modulu; belgeler ayni yazimda). */
  async function recordBankPayablePayment(ctx: FinanceContext, p: BankPayablePaymentInput) {
    assertId(p.idempotencyId, 'idempotencyId');
    assertId(p.bankAccountId, 'bankAccountId');
    assertId(p.payableAccountId, 'payableAccountId');
    if (!isIsoDate(p.date)) throw new ValidationError('date YYYY-MM-DD olmali', 'date');
    if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT) throw new ValidationError('amount pozitif kurus olmali', 'amount');
    const description = p.description.replace(/\s+/g, ' ').trim().slice(0, 200) || 'Tedarikçi ödemesi';
    const fp = fingerprint({
      op: 'bank_payable_payment',
      bankAccountId: p.bankAccountId,
      payableAccountId: p.payableAccountId,
      amount: p.amount,
      date: p.date,
      reference: p.reference,
    });
    return postPayablePayment(ctx, {
      idempotencyId: p.idempotencyId,
      fp,
      payableAccountId: p.payableAccountId,
      fundsAccountId: p.bankAccountId,
      amount: p.amount,
      date: p.date,
      description,
      reference: p.reference,
      checkFunds: false,
      documents: p.documents,
    });
  }

  async function recordBankExpense(ctx: FinanceContext, p: BankExpenseInput) {
    assertId(p.idempotencyId, 'idempotencyId');
    assertId(p.bankAccountId, 'bankAccountId');
    assertId(p.expenseAccountId, 'expenseAccountId');
    if (!isIsoDate(p.date)) throw new ValidationError('date YYYY-MM-DD olmali', 'date');
    if (!Number.isSafeInteger(p.amount) || p.amount < 1 || p.amount > MAX_AMOUNT) throw new ValidationError('amount pozitif kurus olmali', 'amount');
    const description = p.description.replace(/\s+/g, ' ').trim();
    if (description.length < 2 || description.length > 200) throw new ValidationError('description 2-200 karakter olmali', 'description');
    const supplier = p.supplier?.trim() ? p.supplier.trim().slice(0, 120) : undefined;
    const invoiceNumber = p.invoiceNumber?.trim() ? p.invoiceNumber.trim().slice(0, 60) : undefined;
    const fp = fingerprint({
      op: 'bank_expense',
      bankAccountId: p.bankAccountId,
      expenseAccountId: p.expenseAccountId,
      amount: p.amount,
      date: p.date,
      description,
      supplier,
      invoiceNumber,
      reference: p.reference,
    });
    const replay = async () => {
      const existing = await repo.getIdempotency(ctx.apartmentId, p.idempotencyId);
      if (!existing) return undefined;
      if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu satir farkli bir gider bilgisiyle kaydedilmis');
      const expense = existing.recordId ? await repo.getExpense(ctx.apartmentId, existing.recordId) : undefined;
      const transaction = await repo.getTransaction(ctx.apartmentId, existing.transactionId);
      if (!expense || !transaction) throw new FinanceError('not_found', 'Gider kaydi bulunamadi');
      return { expense, transaction, replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;

    await ensureSystemAccounts(ctx);
    const bank = await repo.getAccount(ctx.apartmentId, p.bankAccountId);
    if (!bank || bank.type !== 'bank' || bank.status !== 'active') throw new FinanceError('unprocessable', 'Odeme hesabi aktif bir banka hesabi olmali');
    const expenseAccount = await repo.getAccount(ctx.apartmentId, p.expenseAccountId);
    if (!expenseAccount) throw new FinanceError('not_found', 'Gider hesabi bulunamadi');
    if (expenseAccount.type !== 'expense' || expenseAccount.status !== 'active') {
      throw new FinanceError('unprocessable', 'Gider hesabi aktif bir gider hesabi olmali');
    }

    const expenseId = deps.newId();
    const transaction = buildTx(ctx, {
      kind: 'expense',
      date: p.date,
      description,
      reference: p.reference,
      lines: [
        { accountId: p.expenseAccountId, side: 'debit', amount: p.amount },
        { accountId: p.bankAccountId, side: 'credit', amount: p.amount },
      ],
    });
    const expense: Expense = {
      ...financeKeys.expense(ctx.apartmentId, expenseId),
      ...financeKeys.expenseIndex(ctx.apartmentId, p.date, expenseId),
      entityType: 'EXPENSE',
      expenseId,
      siteId: ctx.apartmentId,
      expenseAccountId: p.expenseAccountId,
      creditAccountId: p.bankAccountId,
      amount: p.amount,
      date: p.date,
      description,
      ...(supplier ? { supplier } : {}),
      ...(invoiceNumber ? { invoiceNumber } : {}),
      transactionId: transaction.transactionId,
      createdAt: transaction.createdAt,
      createdBy: ctx.userId,
    };
    const docs = p.documents({ expense, transaction });
    try {
      await repo.postBatch({
        transactions: [transaction],
        idempotency: { id: p.idempotencyId, fingerprint: fp, recordId: expenseId },
        records: [expense],
        ...(docs.newDocs?.length ? { newDocs: docs.newDocs } : {}),
        ...(docs.replaceRecords?.length ? { replaceRecords: docs.replaceRecords } : {}),
        ...(docs.audit ? { audit: docs.audit } : {}),
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate') {
          const again = await replay();
          if (again) return again;
        }
        if (err.reason === 'closed' || err.reason === 'precondition') throw err;
      }
      throw mapConflict(err);
    }
    return { expense, transaction, replayed: false };
  }

  /**
   * Banka eslestirmesinin islemlerini TEK atomik yazimla ters kayitla iptal eder. Her islem icin
   * `REV_<islem>` idempotency kaydi da yazilir: makbuz "iptal" olarak uretilir ve ayni islem elle
   * ikinci kez ters cevrilemez.
   */
  async function reverseBankPayments(ctx: FinanceContext, p: BankReversalInput) {
    assertId(p.idempotencyId, 'idempotencyId');
    const reason = p.reason.trim();
    if (reason.length < 3 || reason.length > 300) throw new ValidationError('reason 3-300 karakter olmali', 'reason');
    if (p.transactionIds.length < 1 || p.transactionIds.length > 11) throw new ValidationError('transactionIds 1-11 islem icermeli', 'transactionIds');
    const date = today();
    const fp = fingerprint({ op: 'bank_reversal', transactionIds: p.transactionIds, reason });
    const replay = async () => {
      const existing = await repo.getIdempotency(ctx.apartmentId, p.idempotencyId);
      if (!existing) return undefined;
      if (existing.fingerprint !== fp) throw new FinanceError('idempotency_conflict', 'Bu geri alma farkli bir istekle kaydedilmis');
      const reversals = (
        await Promise.all((existing.transactionIds ?? [existing.transactionId]).map((id) => repo.getTransaction(ctx.apartmentId, id)))
      ).filter((x): x is Transaction => !!x);
      return { reversals, replayed: true };
    };
    const previous = await replay();
    if (previous) return previous;

    const originals = await Promise.all(p.transactionIds.map((id) => loadTx(ctx, id)));
    for (const original of originals) {
      // B3: bankadan cikan satirdan olusturulan gider de ayni yolla geri alinir.
      // B3.5: tedarikci odemesi (payable_payment) de ayni yolla geri alinir.
      if (!['payment', 'late_fee', 'expense', 'payable_payment'].includes(original.kind)) {
        throw new FinanceError('unprocessable', `Yalnizca tahsilat, tazminat, banka gideri ve tedarikci odemesi geri alinabilir: ${original.transactionId}`);
      }
      if (await repo.getIdempotency(ctx.apartmentId, `REV_${original.transactionId}`)) {
        throw new FinanceError('conflict', `Bu islem zaten ters kayitla duzeltilmis: ${original.transactionId}`);
      }
      for (const accountId of new Set(original.lines.filter((l) => l.unitId && l.liableParty).map((l) => l.accountId))) {
        const acc = await repo.getAccount(ctx.apartmentId, accountId);
        if (acc?.closedThrough && original.date <= acc.closedThrough) {
          throw new FinanceError(
            'unprocessable',
            `Bu tahsilat tasinma kapamasiyla ${acc.closedThrough} tarihinde kapatilan doneme ait; duzeltmeyi borcun devredildigi caride yapin`,
          );
        }
      }
    }
    const reversals = originals.map((original) =>
      buildTx(ctx, {
        kind: 'reversal',
        date,
        description: `Ters kayit: ${original.description}`,
        reversalOf: original.transactionId,
        reason,
        lines: original.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })),
      }),
    );
    const revMarkers = originals.map((original, i) => ({
      ...financeKeys.idempotency(ctx.apartmentId, `REV_${original.transactionId}`),
      entityType: 'IDEMPOTENCY',
      transactionId: (reversals[i] as Transaction).transactionId,
      fingerprint: fingerprint({ op: 'reversal', transactionId: original.transactionId, reason, date }),
      createdAt: stamp(),
    }));
    const docs = p.documents({ reversals });
    try {
      await repo.postBatch({
        transactions: reversals,
        idempotency: { id: p.idempotencyId, fingerprint: fp, transactionIds: reversals.map((t) => t.transactionId) },
        newDocs: [...revMarkers, ...(docs.newDocs ?? [])],
        ...(docs.replaceRecords?.length ? { replaceRecords: docs.replaceRecords } : {}),
        ...(docs.audit ? { audit: docs.audit } : {}),
      });
    } catch (err) {
      if (err instanceof LedgerConflictError) {
        if (err.reason === 'duplicate') {
          const again = await replay();
          if (again) return again;
        }
        if (err.reason === 'closed' || err.reason === 'precondition') throw err;
      }
      throw mapConflict(err);
    }
    return { reversals, replayed: false };
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
    planBulkJob,
    postBulkLine,
    prepareBulkPosting,
    autoDuesRequest,
    previewBulk,
    /** Finans 2.3: sayac donemi kalemi (hedef cari destekli) ve toplu ozet olayi. */
    chargeMeterLine,
    recordDuesBatchSummary,
    recordPayment,
    recordOnlinePayment,
    /** Faz B2: banka satiri eslestirme ve geri alma. */
    recordBankPayment,
    reverseBankPayments,
    /** Faz B3: bankadan cikan satirdan gider. */
    recordBankExpense,
    /** Faz B3.5: tedarikci borcu. */
    listPayables,
    recordPayablePayment,
    recordBankPayablePayment,
    recordExpense,
    /** O1-4: is masraf baglantisi. */
    postWorkDocuments,
    expenseInfo,
    isReversed,
    reverseTransaction,
    /** Finans 2.3: toplu geri alma onizlemesi (ayni engel kurallari). */
    reversalStatus,
    getUnitBalance,
    /** Sistem hesaplari (kasa, banka, gelir...) yoksa olusturur (cari kapama servisi kullanir). */
    ensureSystemAccounts,
    /** Finans 2.4: tahakkukta kullanilabilir aktif gelir hesabi dogrulamasi (bos -> income-dues). */
    resolveIncomeAccount,
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
