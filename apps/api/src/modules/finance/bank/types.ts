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
import type { AuditFields, IsoDate, IsoDateTime, Kurus, TableKeys } from '../../core/types.js';

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
  createdAt: IsoDateTime;
  createdBy: string;
  version: number;
};
