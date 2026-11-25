/**
 * Faz 2 - Finans ve defter modeli (cift tarafli kayit).
 *
 * Kurallar:
 *  - Tum tutarlar KURUS cinsinden pozitif tam sayidir (`Kurus`); yon `side` ile belirtilir.
 *  - Defter append-only: Transaction ve LedgerEntry kayitlari yazildiktan sonra degismez,
 *    hata duzeltmesi ters kayit (`kind: 'reversal'`) ile yapilir.
 *  - Hesap bakiyesi = toplam borc - toplam alacak (isaretli). Pozitif/negatif anlami hesap
 *    turune gore degisir (bkz. NORMAL_SIDE). Sakin carisinde pozitif = borc, negatif = avans.
 *  - Tek bir Transaction'in borc ve alacak toplami her zaman esittir.
 */
import { createHash } from 'node:crypto';
import type {
  AuditFields,
  EntityStatus,
  IsoDate,
  IsoDateTime,
  Kurus,
  LiableParty,
  TableKeys,
} from '../core/types.js';

/** equity: acilis/devir bakiyelerinin karsi hesabi (sisteme gecis aninda). */
export const ACCOUNT_TYPES = ['cash', 'bank', 'receivable', 'payable', 'income', 'expense', 'equity'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export type EntrySide = 'debit' | 'credit';

/** Hesabin normal (artti) tarafi: kasa/banka/alacak/gider borc, borc/gelir alacak. */
export const NORMAL_SIDE: Record<AccountType, EntrySide> = {
  cash: 'debit',
  bank: 'debit',
  receivable: 'debit',
  expense: 'debit',
  payable: 'credit',
  income: 'credit',
  equity: 'credit',
};

/**
 *   PK = `APT#<siteId>`, SK = `ACCT#<accountId>`
 * Sakin carileri (`receivable`) daire + sorumlu taraf bazinda tutulur (alt cari):
 * `recv-<unitId>-<owner|occupant>`.
 */
export type Account = TableKeys &
  AuditFields & {
    entityType: 'ACCOUNT';
    accountId: string;
    siteId: string;
    type: AccountType;
    name: string;
    status: EntityStatus;
    /** Sistem hesaplari pasife alinamaz. */
    system?: boolean;
    /** Finans 2.4: hesap plani kodu (ornegin "600.01"); apartman icinde benzersiz, istege bagli. */
    code?: string;
    /** Borc - alacak (kurus, negatif olabilir). Her defter yazimiyla atomik guncellenir. */
    balance: Kurus;
    unitId?: string;
    liableParty?: LiableParty;
    /**
     * Cari kapama (tasinma) kesim tarihi: bu tarih ve oncesine ait hareketler kapatilip devredildi.
     * Hesaba bu tarihe kadar (dahil) tarihli yeni kayit yazilamaz; ters kayit yapilamaz.
     */
    closedThrough?: IsoDate;
    /** Ayrilan sakin/malik carisi: hangi kapamayla acildi ve kime ait. */
    closureId?: string;
    holder?: { userIds: string[]; periodStart?: IsoDate; periodEnd: IsoDate };
    /**
     * Finans 2.1: hisseli mulkiyette `split` faturalamada paydasin kendi malik alt carisi
     * (`recv-<unit>-owner-h<etiket>`). Tahakkuk sicil paylariyla bolunur.
     */
    coOwner?: { userId: string };
  };

/** Daire + taraf ana alt carisi (tahakkuklarin hedefi). Ayrilan carileri `-c<kapamaId>` ekini tasir. */
export const mainReceivableId = (unitId: string, party: LiableParty) => `recv-${unitId}-${party}`;

/** Paydas etiketi: kullanici kimliginin kisa ozeti (hesap kimligi 64 karakteri asmasin; deterministik). */
export const coOwnerTag = (userId: string) => createHash('sha256').update(userId).digest('hex').slice(0, 10);

/** Finans 2.1: `split` faturalamada paydasin malik alt carisi. */
export const coOwnerReceivableId = (unitId: string, userId: string) => `recv-${unitId}-owner-h${coOwnerTag(userId)}`;

/** Paydas alt carisi mi? (ayrilan carileri `-c<kapama>` ekini tasir; paydas alt carisi `-h<etiket>`.) */
export const isCoOwnerReceivableId = (accountId: string, unitId: string) =>
  accountId.startsWith(`recv-${unitId}-owner-h`) && !accountId.includes('-c', `recv-${unitId}-owner-h`.length);

/**
 * Dairenin "guncel" alt carisi mi: ana cari (`recv-<unit>-<taraf>`) veya paydas alt carisi.
 * Ayrilan sakin/malik carileri (kapama ile acilan) haric.
 */
export const isPrimaryReceivableId = (accountId: string, unitId: string, party: LiableParty) =>
  accountId === mainReceivableId(unitId, party) || (party === 'owner' && isCoOwnerReceivableId(accountId, unitId));

/**
 * late_fee: kistelyevm gecikme tazminati kesinlestirmesi (ayin 1'inde, alt cari basina tek
 * kayit). `reference` = `LATE_FEE:<YYYY-MM>` (kesinlestirilen donem).
 * opening_balance: sisteme gecis (toplu aktarim) devir bakiyesi; karsi hesap `opening-balance`.
 */
export type TransactionKind =
  | 'dues_charge'
  | 'payment'
  | 'expense'
  | 'reversal'
  | 'late_fee'
  | 'opening_balance'
  | 'transfer'
  | 'refund'
  /** Faz B3.5: tedarikci borcunun odenmesi (borc: tedarikci/payable, alacak: kasa/banka). */
  | 'payable_payment'
  /** Finans 2.2: avans mahsubu (borc: kaynak alt cari, alacak: hedef alt cari). */
  | 'offset'
  /**
   * Finans 2.2: borc yapilandirma. Ayni alt caride hedefli kapama (alacak, `settles`) + taksit /
   * birlestirilmis kalem acilisi (borc, `plan.items`); islem kendi icinde dengelidir.
   */
  | 'restructure';

/**
 * Cari devri kalemi (yalnizca `transfer` + `role: 'open'`): hedef caride orijinal vadesiyle
 * acik borc olarak gorunur. Anaparanin tazminati hedefte devir tarihinden itibaren isler
 * (oncesi kaynakta kesinlestirildi); tazminat kalemleri tazminat dogurmaz.
 */
export type TransferItem = {
  /** Kaynak caride kalemin kimligi (islem kimligi veya devredilmis kalem kimligi). */
  sourceChargeId: string;
  category: 'principal' | 'late_fee';
  description: string;
  date: IsoDate;
  dueDate: IsoDate;
  amount: Kurus;
};

/**
 * Cari devri (tasinmada kapama). Iki islem tek atomik yazimda, ara hesap (`transfer-clearing`)
 * uzerinden:
 *   close: kaynak alt cari `cutoff` tarihine kadarki net bakiyesiyle kapatilir (bu tarih ve
 *          oncesi hesap genelindeki hesaplamalarda artik dikkate alinmaz).
 *   open : hedef cariye (ayrilan sakin carisi / malik carisi / yeni malik) kalemleriyle acilir.
 */
export type TransferInfo = {
  closureId: string;
  role: 'close' | 'open';
  /** role=close: kesim tarihi (cikis tarihi). */
  cutoff?: IsoDate;
  /** role=open: devredilen borc kalemleri (toplam = borc satiri). Avans devri kalemsizdir. */
  items?: TransferItem[];
};

/**
 * Finans 2.2: hedefli mahsup. Alacak satirinin bu kismi havuza (FIFO) girmez; dogrudan gosterilen
 * kalemleri kapatir. Kalem kimligi alt cari okuyucusundaki `SubCharge.id`dir. Toplam <= satir.
 */
export type ChargeSettlement = { chargeId: string; amount: Kurus };

export type TransactionLine = {
  accountId: string;
  side: EntrySide;
  amount: Kurus;
  unitId?: string;
  liableParty?: LiableParty;
  /** Yalnizca alacak satirinda (Finans 2.2). */
  settles?: ChargeSettlement[];
};

/**
 * Finans 2.2: yapilandirma kalemi (taksit veya birlestirilmis kalem). Alt caride
 * `<islem>_<sira>` kimlikli, kendi vadesiyle acik borc olarak gorunur. Gecikme tazminati
 * yalnizca `feeBase` (anapara payi) uzerinden ve vadeden itibaren isler; odemeler once anapara
 * payini kapatir.
 */
export type PlanItem = {
  /** Taksit sirasi (1..n); birlestirilmis kalemde 0. */
  no: number;
  description: string;
  dueDate: IsoDate;
  amount: Kurus;
  feeBase: Kurus;
};

/**
 * Finans 2.2: yapilandirma islemi ayrintisi.
 *   open        : secilen kalemler hedefli kapatilir, taksitler acilir (plan olusturma)
 *   accelerate  : muacceliyet - kalan taksitler hedefli kapatilir, tek kalem (vadesi bugun) acilir
 *   pull_forward: erken kapama - ayni islem, cezasiz (borclu talebi)
 */
export type PlanInfo = {
  planId: string;
  role: 'open' | 'accelerate' | 'pull_forward';
  items: PlanItem[];
};

/**
 * Defter islemi (basligi). `lines` borc/alacak satirlarinin tek kaynagidir; LedgerEntry
 * kayitlari bunlardan turetilir.
 *   PK = `APT#<siteId>`, SK = `TX#<transactionId>`
 * `transactionId` = `<YYYYMMDD>-<uuid>` (kronolojik siralanir).
 */
export type Transaction = TableKeys & {
  entityType: 'TRANSACTION';
  transactionId: string;
  siteId: string;
  kind: TransactionKind;
  /** Muhasebe tarihi. */
  date: IsoDate;
  dueDate?: IsoDate;
  description: string;
  reference?: string;
  batchId?: string;
  reversalOf?: string;
  reason?: string;
  lines: TransactionLine[];
  totalAmount: Kurus;
  createdAt: IsoDateTime;
  createdBy: string;
  /** Gider islemine bagli fatura (kayit aninda yazilir; sonradan degismez). */
  invoice?: { expenseId: string; fileName: string };
  /** Cari devri ayrintisi (`kind: 'transfer'`). */
  transfer?: TransferInfo;
  /** Yapilandirma ayrintisi (`kind: 'restructure'`, Finans 2.2). */
  plan?: PlanInfo;
  /** Avans mahsubu kaydi (`kind: 'offset'`, Finans 2.2). */
  offsetId?: string;
  /** Bos daire kurali: sakin gideri tahakkuk tarihinde dairede oturan olmadigi icin malike yazildi. */
  vacant?: true;
};

/**
 * Hesap ekstresi icin satir bazli, degismez kayit.
 *   PK = `APT#<siteId>`, SK = `LE#<accountId>#<transactionId>#<lineNo>`
 */
export type LedgerEntry = TableKeys & {
  entityType: 'LEDGER_ENTRY';
  entryId: string;
  transactionId: string;
  siteId: string;
  accountId: string;
  side: EntrySide;
  amount: Kurus;
  date: IsoDate;
  lineNo: number;
  unitId?: string;
  liableParty?: LiableParty;
  createdAt: IsoDateTime;
  createdBy: string;
};

export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Tahsilat makbuzu. SK = `PAY#<paymentId>` */
export type Payment = TableKeys & {
  entityType: 'PAYMENT';
  paymentId: string;
  siteId: string;
  unitId: string;
  liableParty: LiableParty;
  method: PaymentMethod;
  amount: Kurus;
  depositAccountId: string;
  /** Apartman bazinda ardisik makbuz no, ornegin "MKB-000012". */
  receiptNumber: string;
  transactionId: string;
  paidAt: IsoDate;
  payerName?: string;
  note?: string;
  /**
   * Tahsilatin alacak yazildigi alt cari; yalnizca ana cari DISINDA (tasinmada acilan ayrilan
   * sakin/malik carisi) doldurulur. Bu makbuzlar dairenin bugunku sakinine gosterilmez.
   */
  receivableAccountId?: string;
  /** Online odeme: odeme niyeti ve saglayici islem numarasi (makbuz/mutabakat icin). */
  intentId?: string;
  provider?: string;
  providerPaymentId?: string;
  createdAt: IsoDateTime;
  createdBy: string;
};

export type ExpenseInvoice = { key: string; fileName: string; contentType: string; size: number };

/** Gider kaydi. SK = `EXP#<expenseId>` */
export type Expense = TableKeys & {
  entityType: 'EXPENSE';
  expenseId: string;
  siteId: string;
  expenseAccountId: string;
  /** Odemenin cikti hesap: kasa/banka (pesin) veya tedarikci borcu (vadeli). */
  creditAccountId: string;
  amount: Kurus;
  date: IsoDate;
  description: string;
  supplier?: string;
  invoiceNumber?: string;
  /** Fatura dosyasi (private S3: apartments/{apt}/invoices/...). */
  invoice?: ExpenseInvoice;
  transactionId: string;
  createdAt: IsoDateTime;
  createdBy: string;
};

export type IdempotencyRecord = {
  transactionId: string;
  recordId?: string;
  /** Toplu yazim (postBatch): tum islem ve belge kimlikleri. */
  transactionIds?: string[];
  recordIds?: string[];
  /** Istek icerigi ozeti: ayni anahtarin farkli istekle kullanilmasini yakalar. */
  fingerprint: string;
};
