/**
 * Ortak alan rezervasyonu - kayitlar. Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   RFAC#<facilityId>                          ortak alan (surumlu; silinmez, `status: inactive`)
 *   RBOOK#<bookingId>                          rezervasyon (surumlu)
 *   RSLOT#<facilityId>#<slotStartIso>          zaman dilimi kilidi: alan + 30 dakikalik dilim basina
 *                                              TEK oge. `held` iken ikinci rezervasyon kosullu yazimda
 *                                              reddedilir; iptal / ret `released` yapar (silme yok)
 *   RGUARD#<facilityId>#<unitId>               daire basina surum sayaci: ayni dairenin es zamanli iki
 *                                              rezervasyonu "en fazla aktif rezervasyon" kuralini asamaz
 *   RBFAC#<facilityId>#<startIso>#<bookingId>  takvim indeksi (yalnizca eklenir; baslangic degismez)
 *   RBUNIT#<unitId>#<startIso>#<bookingId>     daire indeksi (sakin "rezervasyonlarim", aktif sayim)
 *   RIDEM#<idempotencyKey>                     olusturma idempotency kaydi (alan ve rezervasyon)
 *   RFEEQ#<bookingId>                          iade kuyrugu: YALNIZCA ters kaydi yapilamayan ucret icin yazilir
 *                                              (`status: open`); yeniden deneme / elle cozum `resolved` yapar
 *                                              (silme yok). Onay bekleyenler ekrani yalnizca acik kayitlari okur
 *
 * Saatler Europe/Istanbul duvar saatiyle girilir (`HH:MM`), kayitlarda UTC ISO tutulur.
 * Ucret (kurus) onay aninda Finans `chargeUnit` ile oturan alt carisine tahakkuk eder; iptalde
 * Finans `reverseTransaction` ile ters kayit yapilir. Bu modul defter satiri yazmaz.
 */
import type { AuditFields, EntityStatus, IsoDate, IsoDateTime, LiableParty, TableKeys } from '../core/types.js';

/** Kilit ve takvim izgarasi: tum dilim uzunluklari ve acilis saatleri bu adimin katidir. */
export const SLOT_STEP_MINUTES = 30;
export const SLOT_LENGTHS = [30, 60, 90, 120, 180, 240] as const;
export type SlotLength = (typeof SLOT_LENGTHS)[number];
/** En uzun rezervasyon (24 kilit ogesi; atomik yazim 100 ogenin cok altinda kalir). */
export const MAX_BOOKING_MINUTES = 720;
export const MAX_ADVANCE_DAYS = 180;
export const MAX_ACTIVE_PER_UNIT = 20;
export const MAX_CANCEL_NOTICE_HOURS = 168;
export const MAX_CAPACITY = 1000;
/** Bir ucretin ust siniri (kurus): 1.000.000 TL. */
export const MAX_FEE_KURUS = 100_000_000;
/** Takvim / liste sorgusunda en fazla gun. */
export const MAX_RANGE_DAYS = 62;

/** ISO hafta gunu: 1 = Pazartesi ... 7 = Pazar. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;
/** Bir gunun acik oldugu tek pencere (`close` en fazla `24:00`). */
export type OpeningWindow = { day: Weekday; open: string; close: string };

export type Facility = TableKeys &
  AuditFields & {
    entityType: 'RESERVATION_FACILITY';
    apartmentId: string;
    facilityId: string;
    name: string;
    description?: string;
    /** Ayni anda alanda bulunabilecek kisi sayisi (rezervasyondaki kisi sayisi ust siniri). */
    capacity: number;
    /** Acik gunler; listede olmayan gun kapalidir. */
    openingHours: OpeningWindow[];
    slotMinutes: SlotLength;
    maxBookingMinutes: number;
    /** Sakin en fazla kac gun sonrasina rezervasyon yapabilir (bugun dahil). */
    advanceDays: number;
    /** Daire basina ayni anda aktif (bekleyen / onayli, bitmemis) rezervasyon sayisi. */
    maxActivePerUnit: number;
    requiresApproval: boolean;
    /** Sakin iptali icin baslangictan once en az kac saat (yonetici iptali serbest, gerekceli). */
    cancelNoticeHours: number;
    /** Verilirse yalnizca bu bloklarin daireleri rezervasyon yapabilir. */
    blockIds?: string[];
    /** Rezervasyon basina ucret (kurus); 0 = ucretsiz. */
    feeKurus: number;
    /** Ucretin gelir hesabi (yoksa aidat gelirleri). */
    incomeAccountId?: string;
    status: EntityStatus;
  };

export const BOOKING_STATUSES = ['pending', 'confirmed', 'rejected', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
/** Dilimleri tutan (aktif) durumlar. */
export const HOLDING_STATUSES: readonly BookingStatus[] = ['pending', 'confirmed'];

/**
 * Ucret durumu: `none` ucretsiz; `pending` onay bekliyor (tahakkuk yok); `charged` tahakkuk edildi;
 * `void` tahakkuk olmadan iptal / ret; `reversal_pending` iptal edildi, ters kayit yapilamadi
 * (yeniden denenir); `reversed` ters kayitla iade edildi; `resolved_manually` Finans engeli nedeniyle
 * yonetici gerekceyle elle cozuldu olarak isaretledi (denetimli).
 */
export type FeeStatus = 'none' | 'pending' | 'charged' | 'void' | 'reversal_pending' | 'reversed' | 'resolved_manually';
export type BookingFee = {
  amount: number;
  status: FeeStatus;
  incomeAccountId?: string;
  transactionId?: string;
  chargedAt?: IsoDateTime;
  reversedAt?: IsoDateTime;
  /** Son tahakkuk / ters kayit hatasi (yoneticiye). */
  error?: string;
  /** Elle cozum gerekcesi (`resolved_manually`). */
  resolvedNote?: string;
  resolvedAt?: IsoDateTime;
  resolvedBy?: string;
};

/**
 * Ucreti odeyecek taraf, rezervasyonu YAPAN kisinin o gunku uyeliginden belirlenir ve saklanir:
 * dairede oturuyorsa oturan (kiraci / oturan malik) carisi, oturmuyorsa malik carisi. Onayda bu
 * taraf tahakkuk edilir (onay gunu dairede kimin oturduguna gore degil).
 */
export type BookingPayer = { liableParty: LiableParty; relation: 'owner' | 'tenant' };

export type Booking = TableKeys &
  AuditFields & {
    entityType: 'RESERVATION_BOOKING';
    apartmentId: string;
    bookingId: string;
    facilityId: string;
    /** Rezervasyon anindaki alan adi (gosterim). */
    facilityName: string;
    unitId: string;
    blockId?: string;
    /** Baslangicin Istanbul takvim gunu. */
    date: IsoDate;
    start: IsoDateTime;
    end: IsoDateTime;
    /** Tutulan kilit dilimleri (baslangic ISO); iptalde ayni dilimler serbest birakilir. */
    slots: IsoDateTime[];
    partySize?: number;
    note?: string;
    status: BookingStatus;
    createdByRole: string;
    /** Ucretin yazilacagi taraf (rezervasyon aninda, yapan kisinin uyeliginden). */
    payer?: BookingPayer;
    /** Onay gerektirmeyen ucretli alan: olusturmadan hemen sonra tahakkukla onaylanir. */
    autoConfirm?: boolean;
    fee: BookingFee;
    decidedAt?: IsoDateTime;
    decidedBy?: string;
    /** Ret gerekcesi veya onay notu. */
    decisionNote?: string;
    cancelledAt?: IsoDateTime;
    cancelledBy?: string;
    cancelKind?: 'resident' | 'manager';
    cancelReason?: string;
  };

export type SlotLock = TableKeys & {
  entityType: 'RESERVATION_SLOT';
  apartmentId: string;
  facilityId: string;
  slotStart: IsoDateTime;
  state: 'held' | 'released';
  bookingId: string;
  unitId: string;
  at: IsoDateTime;
};

export type BookingIndex = TableKeys & {
  entityType: 'RESERVATION_INDEX';
  apartmentId: string;
  bookingId: string;
  facilityId: string;
  unitId: string;
  start: IsoDateTime;
};

export type FeeQueueEntry = TableKeys & {
  entityType: 'RESERVATION_FEE_QUEUE';
  apartmentId: string;
  bookingId: string;
  status: 'open' | 'resolved';
  at: IsoDateTime;
  /** Son hata (open) veya cozum bicimi (resolved). */
  note?: string;
};

export type ReservationIdempotency = TableKeys & {
  entityType: 'RESERVATION_IDEMPOTENCY';
  apartmentId: string;
  kind: 'facility' | 'booking';
  targetId: string;
  fingerprint: string;
  createdAt: IsoDateTime;
};

const pk = (apartmentId: string) => `APT#${apartmentId}`;
export const reservationKeys = {
  facility: (apt: string, facilityId: string): TableKeys => ({ PK: pk(apt), SK: `RFAC#${facilityId}` }),
  facilityPrefix: 'RFAC#',
  booking: (apt: string, bookingId: string): TableKeys => ({ PK: pk(apt), SK: `RBOOK#${bookingId}` }),
  slot: (apt: string, facilityId: string, slotStart: IsoDateTime): TableKeys => ({ PK: pk(apt), SK: `RSLOT#${facilityId}#${slotStart}` }),
  slotPrefix: (facilityId: string) => `RSLOT#${facilityId}#`,
  guard: (apt: string, facilityId: string, unitId: string): TableKeys => ({ PK: pk(apt), SK: `RGUARD#${facilityId}#${unitId}` }),
  facilityIndex: (apt: string, facilityId: string, start: IsoDateTime, bookingId: string): TableKeys => ({ PK: pk(apt), SK: `RBFAC#${facilityId}#${start}#${bookingId}` }),
  facilityIndexPrefix: (facilityId: string) => `RBFAC#${facilityId}#`,
  unitIndex: (apt: string, unitId: string, start: IsoDateTime, bookingId: string): TableKeys => ({ PK: pk(apt), SK: `RBUNIT#${unitId}#${start}#${bookingId}` }),
  unitIndexPrefix: (unitId: string) => `RBUNIT#${unitId}#`,
  idempotency: (apt: string, key: string): TableKeys => ({ PK: pk(apt), SK: `RIDEM#${key}` }),
  feeQueue: (apt: string, bookingId: string): TableKeys => ({ PK: pk(apt), SK: `RFEEQ#${bookingId}` }),
  feeQueuePrefix: 'RFEEQ#',
};
