/**
 * Faz B1 - Banka ekstresi aktarimi: veri modeli.
 *
 * Tum kayitlar apartman bolumundedir (`PK = APT#<apartmentId>`):
 *
 *   SK = BANKSTMT#<statementId>                         ekstre (yukleme + onizleme + aktarim ozeti)
 *   SK = BANKFILE#<sha256>                              ayni dosyanin ikinci kez yuklenmesini engelleyen kilit
 *   SK = BANKTX#<bankAccountId>#<YYYY-MM-DD>#<fp>       banka hareketi (satir); `fp` deterministik parmak izi
 *   SK = BANKFMT#<bankAccountId>                        hesaba ozel sutun esleme sablonu (surum kosullu)
 *
 * Kurallar:
 *  - Tutarlar KURUS cinsinden tam sayidir. Hareket tutari daima pozitiftir; yon `direction` ile verilir
 *    (`in` = hesaba giren / alacak, `out` = hesaptan cikan / borc). Bakiye isaretlidir.
 *  - Duz metin IBAN hicbir kayda yazilmaz: aciklamadaki IBAN maskelenir, eslestirme icin yalnizca
 *    KMS HMAC ozeti (`counterpartyIbanMac`) saklanir.
 *  - Banka satiri defter kaydi DEGILDIR. Ham alanlari (tarih, tutar, aciklama...) yazildiktan sonra
 *    degismez; yalnizca eslestirme durumu (`status`, B2) surum kosuluyla guncellenir.
 *  - Satir kayitlari TTL tasimaz.
 */
import type { AuditFields, IsoDate, IsoDateTime, Kurus, LiableParty, TableKeys } from '../../core/types.js';

// ---------------------------------------------------------------------------
// Sutun esleme (BANKFMT / istek)
// ---------------------------------------------------------------------------

export const BANK_FIELDS = [
  'date',
  'valueDate',
  'description',
  'amount',
  'debit',
  'credit',
  'direction',
  'balance',
  'reference',
  'counterpartyName',
  'counterpartyIban',
] as const;
export type BankField = (typeof BANK_FIELDS)[number];

/**
 * signed           : tek tutar sutunu, isaretli (+ giren, - cikan)
 * debit_credit     : ayri "Borc" (cikan) ve "Alacak" (giren) sutunlari
 * amount_direction : mutlak tutar + yon sutunu ("B"/"A", "Borc"/"Alacak", "+"/"-")
 */
export const AMOUNT_MODES = ['signed', 'debit_credit', 'amount_direction'] as const;
export type AmountMode = (typeof AMOUNT_MODES)[number];

/** Sutunlar BASLIK METNIYLE eslenir (sira degisse de calisir). */
export type BankFormatSpec = {
  templateId?: string;
  /** Baslik satiri (1 tabanli). Verilmezse ilk 40 satir icinde otomatik bulunur. */
  headerRow?: number;
  columns: Partial<Record<BankField, string>>;
  amountMode: AmountMode;
  /** amount_direction: yon degerleri (karsilastirma buyuk/kucuk harf ve Turkce karakter duyarsiz). */
  directionValues?: { in: string[]; out: string[] };
};

/** PK = APT#<apt>, SK = BANKFMT#<bankAccountId> */
export type BankFormat = TableKeys &
  AuditFields & {
    entityType: 'BANK_FORMAT';
    apartmentId: string;
    bankAccountId: string;
    spec: BankFormatSpec;
  };

// ---------------------------------------------------------------------------
// Ekstre
// ---------------------------------------------------------------------------

export type SourceFormat = 'csv' | 'xlsx' | 'html';
export type FormatSource = 'request' | 'saved' | 'detected';
export type StatementStatus = 'previewed' | 'committed';

export type DirectionTotals = { count: number; amount: Kurus };

export type StatementIssues = {
  /** Okunamayan satirlar (aktarilmaz). */
  errors: number;
  /** Ayni dosyada iki kez gecen satir (aktarilmaz). */
  duplicatesInFile: number;
  /** Daha once baska bir ekstreyle aktarilmis satir (tekrar yazilmaz). */
  duplicatesExisting: number;
  /** Onceki satirin bakiyesi + tutar != bu satirin bakiyesi. */
  balanceMismatches: number;
  /** Bakiye ve banka referansi olmayan satir sayisi (parmak izi zayif). */
  weakFingerprints: number;
  /** Bu ekstrenin donemiyle cakisan, daha once aktarilmis ekstreler. */
  overlappingStatements: string[];
  /** Tarih hucresi bos (toplam/devir/bos satir) oldugu icin atlanan satir sayisi. */
  ignoredRows: number;
};

/** PK = APT#<apt>, SK = BANKSTMT#<statementId> (`statementId` = YYYYMMDD-<uuid>, kronolojik) */
export type BankStatement = TableKeys &
  AuditFields & {
    entityType: 'BANK_STATEMENT';
    statementId: string;
    apartmentId: string;
    bankAccountId: string;
    status: StatementStatus;
    fileName: string;
    /** apartments/{apt}/bank-statements/{yyyy}/{mm}/{statementId} */
    fileKey: string;
    fileSha256: string;
    fileBytes: number;
    sourceFormat: SourceFormat;
    format: BankFormatSpec;
    formatSource: FormatSource;
    /** Ekstredeki ilk ve son hareket tarihi. */
    period?: { from: IsoDate; to: IsoDate };
    /** Bakiye sutunu varsa: ilk hareketten onceki ve son hareketten sonraki bakiye (isaretli kurus). */
    openingBalance?: number;
    closingBalance?: number;
    lineCount: number;
    credits: DirectionTotals;
    debits: DirectionTotals;
    issues: StatementIssues;
    committed?: {
      newLines: number;
      existingLines: number;
      committedAt: IsoDateTime;
      committedBy: string;
    };
  };

/** PK = APT#<apt>, SK = BANKFILE#<sha256>. Yalnizca yoksa yazilir. */
export type BankFileLock = TableKeys & {
  entityType: 'BANK_FILE';
  apartmentId: string;
  fileSha256: string;
  statementId: string;
  bankAccountId: string;
  createdAt: IsoDateTime;
  createdBy: string;
};

// ---------------------------------------------------------------------------
// Banka hareketi (satir)
// ---------------------------------------------------------------------------

export type LineDirection = 'in' | 'out';
/** B1'de tum satirlar `unmatched` yazilir; `matched` / `ignored` B2 eslestirme durumlaridir. */
export type LineStatus = 'unmatched' | 'matched' | 'ignored';

export const FINGERPRINT_VERSION = 1;

/** PK = APT#<apt>, SK = BANKTX#<bankAccountId>#<date>#<fp> */
export type BankLine = TableKeys & {
  entityType: 'BANK_LINE';
  /** Istemcide kullanilan kimlik: `<YYYYMMDD>_<fp>` (hesapla birlikte tekildir). */
  lineId: string;
  apartmentId: string;
  bankAccountId: string;
  /** Satiri ilk aktaran ekstre ve dosyadaki sirasi (1 tabanli kaynak satir no). */
  statementId: string;
  sourceRow: number;
  date: IsoDate;
  valueDate?: IsoDate;
  direction: LineDirection;
  amount: Kurus;
  /** Islem sonrasi bakiye (isaretli kurus). */
  balanceAfter?: number;
  /** IBAN'lari maskelenmis aciklama. */
  description: string;
  counterpartyName?: string;
  counterpartyIbanMasked?: string;
  /** `k1:` (KMS) veya `l1:` (yerel) onekli HMAC-SHA256; duz IBAN asla saklanmaz. */
  counterpartyIbanMac?: string;
  bankReference?: string;
  fingerprint: string;
  fingerprintVersion: number;
  /** Bakiye ve banka referansi yok: parmak izi gun ici sira numarasina dayanir. */
  weakFingerprint?: true;
  status: LineStatus;
  /** B2: son karar kaydinin sira numarasi (`BANKMATCH#<lineId>#<n>`); karar yoksa yok. */
  decisionNo?: number;
  /** B2: `matched` iken bagli defter kayitlari (karar kaydiyla ayni). */
  match?: { decisionNo: number; transactionIds: string[]; paymentIds: string[] };
  /** B2: son durum degisikligi (eslestirme / yoksayma / geri alma). */
  updatedAt?: IsoDateTime;
  updatedBy?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  version: number;
};

// ---------------------------------------------------------------------------
// Faz B2: eslestirme kararlari, ogrenilmis gonderen, odeme referans kodu, hesap profili
// ---------------------------------------------------------------------------

/** Tek banka satirinin en fazla bolunebilecegi alt cari sayisi. */
export const MAX_ALLOCATIONS = 10;

export type MatchAllocation = {
  /** Alt cari (ana veya tasinmada acilmis ayrilan cari). */
  accountId: string;
  unitId: string;
  liableParty: LiableParty;
  /** Alt cariye alacak yazilan tahsilat (kurus). */
  amount: Kurus;
  /** Odeme aninda kesinlestirilen gecikme tazminati (kurus, 0 olabilir). */
  lateFee: Kurus;
};

/**
 * match   : satir tahsilata cevrildi (tazminat kesinlestirme + tahsilat + makbuz)
 * unmatch : bagli tahsilatlar ters kayitla iptal edildi, satir yeniden `unmatched`
 * ignore  : ic virman / banka masrafi vb. (defter kaydi yok)
 * restore : yoksayilan satir yeniden `unmatched`
 */
export type DecisionKind = 'match' | 'unmatch' | 'ignore' | 'restore';

/**
 * Eslestirme karari: YALNIZCA EKLENIR (append-only). Geri alma eski kaydi degistirmez; yeni bir
 * `unmatch` karari `reverses` ile eskisini gosterir (`reversedBy` okumada turetilir).
 *   PK = APT#<apt>, SK = BANKMATCH#<lineId>#<nnn>
 */
export type BankDecision = TableKeys & {
  entityType: 'BANK_MATCH';
  apartmentId: string;
  bankAccountId: string;
  lineId: string;
  /** BANKTX satirinin SK'si (denetim ve geri izleme). */
  lineSk: string;
  decisionNo: number;
  kind: DecisionKind;
  /** match: alt cari dagilimi (toplam = satir tutari). */
  allocations?: MatchAllocation[];
  /** match: yazilan islemler (tazminat + tahsilat); unmatch: yazilan ters kayitlar. */
  transactionIds: string[];
  /** match: makbuzlar. */
  paymentIds: string[];
  /** unmatch / restore: geri alinan kararin numarasi. */
  reverses?: number;
  /** unmatch: iptal edilen islemler. */
  reversedTransactionIds?: string[];
  reason?: string;
  /** Oneriden mi, elle mi? (raporlama) */
  source?: 'suggestion' | 'manual';
  confidence?: number;
  createdAt: IsoDateTime;
  createdBy: string;
};

/**
 * Ogrenilmis gonderen (karsi taraf IBAN'inin HMAC ozeti -> alt cariler). Her onaylanan
 * eslestirmede guncellenir (surum kosullu); geri almada sayac azaltilir.
 *   PK = APT#<apt>, SK = PAYER#<ibanMac>
 */
export type BankPayer = TableKeys & {
  entityType: 'BANK_PAYER';
  apartmentId: string;
  ibanMac: string;
  accounts: { accountId: string; unitId: string; liableParty: LiableParty; count: number; lastMatchedAt: IsoDateTime }[];
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
  version: number;
};

/**
 * Alt cari basina deterministik odeme referans kodu (sakin havale aciklamasina yazar).
 *   PK = APT#<apt>, SK = BANKREF#<code>          kod -> alt cari (tekillik)
 *   PK = APT#<apt>, SK = BANKREFOF#<accountId>   alt cari -> kod
 * Ikisi tek atomik yazimla, yalnizca yoksa olusturulur.
 */
export type BankRef = TableKeys & {
  entityType: 'BANK_REF';
  apartmentId: string;
  code: string;
  accountId: string;
  unitId: string;
  liableParty: LiableParty;
  createdAt: IsoDateTime;
  createdBy: string;
};

export type BankRefOf = TableKeys & {
  entityType: 'BANK_REF_OF';
  apartmentId: string;
  accountId: string;
  code: string;
  createdAt: IsoDateTime;
};

/**
 * Banka hesabinin sakinlere gosterilen bilgileri (apartmanin KENDI tahsilat hesabi; kisisel
 * veri degildir, sakin kartinda acikca gosterilir).
 *   PK = APT#<apt>, SK = BANKPROFILE#<bankAccountId>
 */
export type BankAccountProfile = TableKeys &
  AuditFields & {
    entityType: 'BANK_PROFILE';
    apartmentId: string;
    bankAccountId: string;
    iban: string;
    accountHolderName: string;
    bankName?: string;
    /** Sakin "Havale / EFT ile ode" kartinda gosterilecek hesap (apartmanda en fazla bir). */
    residentVisible: boolean;
  };
