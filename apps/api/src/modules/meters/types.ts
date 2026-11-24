/**
 * Finans 2.3 - Sayac / endeks dagitimi kayitlari (ayni tablo, PK = APT#<apartmentId>).
 *
 *   METER#<meterId>                          sayac sicili
 *   METEREVT#<meterId>#<zaman>#<eventId>     sayac olay gecmisi (yalnizca eklenir)
 *   METERSWAP#<swapId>                       sayac degisimi / sifirlama (kural 3)
 *   METERTPL#<templateId>                    dagitim sablonu (kural 1)
 *   MPERIOD#<periodId>                       dagitim donemi
 *   MREAD#<periodId>#<meterId>               donem okumasi
 *   MDLINE#<periodId>#<unitId>               dagitim satiri (onayda dondurulur; tahakkuk izi)
 *   METERIDEM#<key>                          idempotency (sayac degisimi)
 *   EXPDIST#<expenseId>                      fatura cift dagitim kilidi (2.3-5a)
 */
import type { IsoDate, IsoDateTime, LiableParty, TableKeys } from '../core/types.js';
import type { CommonKey, MeterKind, Rational } from './engine/types.js';

type Audit = { createdAt: IsoDateTime; createdBy: string; updatedAt: IsoDateTime; updatedBy: string; version: number };

export const METER_STATUSES = ['active', 'replaced', 'retired', 'cancelled'] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];

/** Son onayli okuma (donem yazilirken guncellenir, geri almada eski degerine doner - 2.3-3). */
export type MeterCursor = { index: number; date: IsoDate; periodId: string };
export type RecentConsumption = { delta: number; days: number; periodId: string };

export type Meter = TableKeys &
  Audit & {
    entityType: 'METER';
    meterId: string;
    apartmentId: string;
    unitId: string;
    kind: MeterKind;
    label: string;
    serialNo?: string;
    /** Endeks ondalik basamagi: endeks = gercek x 10^scale. */
    scale: number;
    factor: Rational;
    maxIndex?: number;
    openingIndex: number;
    installedAt: IsoDate;
    status: MeterStatus;
    retiredAt?: IsoDate;
    closingIndex?: number;
    retireReason?: string;
    predecessorMeterId?: string;
    successorMeterId?: string;
    swapInId?: string;
    swapOutId?: string;
    lastReading?: MeterCursor;
    /** Son en fazla 3 onayli donemin tuketimi (yeniden eskiye): sicrama uyarisi ve tahmin. */
    recentConsumption?: RecentConsumption[];
  };

export const METER_EVENT_TYPES = ['install', 'update', 'retire', 'swap_out', 'swap_in', 'swap_reverse', 'cancel'] as const;
export type MeterEventType = (typeof METER_EVENT_TYPES)[number];

export type MeterEvent = TableKeys & {
  entityType: 'METER_EVENT';
  eventId: string;
  apartmentId: string;
  meterId: string;
  type: MeterEventType;
  at: IsoDateTime;
  by: string;
  date?: IsoDate;
  details?: Record<string, unknown>;
};

export const SWAP_KINDS = ['replacement', 'reset'] as const;
export type SwapKind = (typeof SWAP_KINDS)[number];

export type MeterSwap = TableKeys &
  Audit & {
    entityType: 'METER_SWAP';
    swapId: string;
    apartmentId: string;
    unitId: string;
    kind: SwapKind;
    oldMeterId: string;
    newMeterId: string;
    swapDate: IsoDate;
    oldClosingIndex: number;
    newOpeningIndex: number;
    photoKey?: string;
    reason: string;
    status: 'active' | 'reversed';
    reversedAt?: IsoDateTime;
    reversedBy?: string;
    reverseReason?: string;
  };

export const TEMPLATE_CATEGORIES = ['heating', 'hot_water', 'cold_water'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const LEGAL_PROFILES = ['central_heating', 'district_heating', 'none'] as const;
export type LegalProfile = (typeof LEGAL_PROFILES)[number];

export type TemplateScope = { blockIds?: string[]; exemptionCategory?: string };

export type MeterTemplate = TableKeys &
  Audit & {
    entityType: 'METER_TEMPLATE';
    templateId: string;
    apartmentId: string;
    name: string;
    meterKind: MeterKind;
    category: TemplateCategory;
    commonShareBps: number;
    commonKey: CommonKey;
    liableParty: LiableParty;
    scope: TemplateScope;
    legalProfile: LegalProfile;
    decisionRef?: string;
    reason?: string;
    isDefault: boolean;
    status: 'active' | 'archived';
  };

/** Donemde dondurulan sablon (sonraki sablon degisiklikleri gecmisi etkilemez). */
export type TemplateSnapshot = Pick<
  MeterTemplate,
  'templateId' | 'name' | 'meterKind' | 'category' | 'commonShareBps' | 'commonKey' | 'liableParty' | 'scope' | 'legalProfile' | 'decisionRef' | 'reason' | 'version'
>;

export const PERIOD_STATUSES = ['draft', 'calculated', 'posting', 'posted', 'reversing', 'reversed', 'cancelled'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
/** Okuma girilebilen durumlar. */
export const OPEN_PERIOD_STATUSES: readonly PeriodStatus[] = ['draft', 'calculated'];

export type MeterPeriod = TableKeys &
  Audit & {
    entityType: 'METER_PERIOD';
    periodId: string;
    apartmentId: string;
    name: string;
    templateId: string;
    template: TemplateSnapshot;
    meterKind: MeterKind;
    startDate: IsoDate;
    endDate: IsoDate;
    accrualDate: IsoDate;
    dueDate: IsoDate;
    totalAmount?: number;
    expenseIds: string[];
    status: PeriodStatus;
    /** Son onizleme / onayda dondurulan hesap ozeti (2.3-3). */
    calc?: PeriodCalc;
    /** Toplu tahakkuk kimligi: `mdp-<periodId>` (onayda atanir). */
    batchId?: string;
    approvedAt?: IsoDateTime;
    approvedBy?: string;
    postedAt?: IsoDateTime;
    chargeCount?: number;
    /** Toplu geri alma (2.3-4): ayni `key` ile yarida kalan geri alma devam eder. */
    reversal?: PeriodReversal;
    supersedesPeriodId?: string;
    supersededByPeriodId?: string;
  };

export const READING_SOURCES = ['manual', 'staff', 'import', 'estimate'] as const;
export type ReadingSource = (typeof READING_SOURCES)[number];
export type ReadingFlag = 'spike' | 'rollover' | 'estimated';

export type MeterReading = TableKeys & {
  entityType: 'METER_READING';
  apartmentId: string;
  periodId: string;
  meterId: string;
  unitId: string;
  endIndex: number;
  estimated: boolean;
  rolloverConfirmed: boolean;
  source: ReadingSource;
  photoKey?: string;
  note?: string;
  flags: ReadingFlag[];
  /** Duzeltilmis donemde geri alinan donemden kopyalanan okuma. */
  copiedFromPeriodId?: string;
  enteredBy: string;
  enteredAt: IsoDateTime;
  rev: number;
  version: number;
};

export type MeterIdempotency = TableKeys & {
  entityType: 'METER_IDEMPOTENCY';
  key: string;
  fingerprint: string;
  swapId: string;
  createdAt: IsoDateTime;
};

export type PeriodCalc = {
  /** Onizleme-onay kilidi: girdi (okumalar, sablon, tutar, tarihler) + sonuc + borclu ozeti. */
  hash: string;
  calculatedAt: IsoDateTime;
  calculatedBy: string;
  totalAmount: number;
  commonPool: number;
  consumptionPool: number;
  fallbackToCommon: boolean;
  totalConsumption: string;
  unitCount: number;
  chargeCount: number;
  warningCodes: string[];
};

export type LiableKind = 'main' | 'former' | 'split' | 'none';

/** Satirin borclusu (onizlemede hesaplanir, onayda dondurulur). */
export type LineLiability = {
  party: LiableParty;
  vacant: boolean;
  kind: LiableKind;
  /** main / former: yazilacak alt cari; split: paydas carileri tahakkukta belirlenir. */
  accountId?: string;
  former?: { closureId: string; sourceAccountId: string; userIds: string[]; periodEnd: IsoDate };
};

/** Sayac imleci degisimi (onayda yazilir; 2.3-4 geri almada `prev*` geri yuklenir). */
export type LineMeterCursor = {
  meterId: string;
  endIndex: number;
  endDate: IsoDate;
  delta: number;
  days: number;
  prevLastReading?: MeterCursor;
  prevRecentConsumption?: RecentConsumption[];
};

export type MeterLine = TableKeys & {
  entityType: 'METER_LINE';
  apartmentId: string;
  periodId: string;
  unitId: string;
  unitNumber?: string;
  hasMeter: boolean;
  estimated: boolean;
  /** Gosterim (olcekli ondalik). */
  consumption: string;
  /** BigInt agirliklar metin olarak. */
  consumptionWeight: string;
  commonWeight: string;
  commonAmount: number;
  consumptionAmount: number;
  amount: number;
  liability: LineLiability;
  meters: LineMeterCursor[];
  /** Satiri ureten hesap (`MeterPeriod.calc.hash`); eski denemelerin satirlari ayiklanir. */
  calcHash: string;
  status: 'pending' | 'posted' | 'skipped' | 'reversed';
  transactionId?: string;
  /** Geri almada yazilan ters kayit. */
  reversalTransactionId?: string;
  accountIds?: string[];
  coOwnerParts?: { userId: string; amount: number }[];
  postedAt?: IsoDateTime;
  version: number;
};

export type PeriodReversal = {
  key: string;
  reason: string;
  /** Ters kayit tarihi (baslangicta sabitlenir; devamda ayni tarih -> idempotent). */
  date: IsoDate;
  notify: boolean;
  batchId: string;
  startedAt: IsoDateTime;
  startedBy: string;
  completedAt?: IsoDateTime;
  reversedCount?: number;
};

/**
 * Fatura cift dagitim kilidi: bir gider (tedarikci faturasi) ayni anda yalnizca bir sayac donemine
 * bagli olabilir. Donemle ayni atomik yazimda alinir / birakilir (iptal, bag kaldirma, geri alma);
 * duzeltilmis donem kilidi yeniden alir.
 */
export type MeterExpenseLock = TableKeys & {
  entityType: 'METER_EXPENSE_LOCK';
  apartmentId: string;
  expenseId: string;
  periodId: string;
  status: 'active' | 'released';
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};
