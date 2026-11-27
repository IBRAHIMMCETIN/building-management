/**
 * Y1 - Anket / oylama veri modeli.
 *
 * Anahtarlar (tek tablo, apartman partition'i):
 *   Oylama  : PK = `APT#<apartmentId>`, SK = `POLL#<pollId>`
 *   Oy      : PK = `APT#<apartmentId>`, SK = `POLLVOTE#<pollId>#<unitId>`  (bagimsiz bolum basina TEK kayit)
 *
 * Bolum basina tek oy anahtarla saglanir: ilk oy `attribute_not_exists`, ayni bolumun sonraki oyu
 * (hisseli mulkiyette baska paydas veya ayni kisinin degisikligi) surum kosullu ustune yazimdir.
 * Her oy yazimi oylamanin hala acik oldugunu ayni `TransactWriteItems` icinde `ConditionCheck` ile
 * dogrular; erken kapatma ile yarisan oy reddedilir. Silme yok: taslak `cancelled` olur.
 */
import type { AuditFields, IsoDate, IsoDateTime, LandShare, TableKeys } from '../core/types.js';

/** Saklanan durum. `published` oylamanin evresi (planli / acik / bitti) zamana gore hesaplanir. */
export const POLL_STATUSES = ['draft', 'published', 'closed', 'cancelled'] as const;
export type PollStatus = (typeof POLL_STATUSES)[number];

/** Ekranda ve filtrede kullanilan evre. */
export const POLL_PHASES = ['draft', 'scheduled', 'open', 'closed', 'cancelled'] as const;
export type PollPhase = (typeof POLL_PHASES)[number];

/** `owners`: kat malikleri (mulkiyet sicili / oy listesi). `residents`: tum aktif uyeler (kiraci dahil). */
export const POLL_AUDIENCES = ['owners', 'residents'] as const;
export type PollAudience = (typeof POLL_AUDIENCES)[number];

/** `per_unit`: her bagimsiz bolum bir oy. `land_share`: oy arsa payi ile agirliklandirilir. */
export const POLL_WEIGHTINGS = ['per_unit', 'land_share'] as const;
export type PollWeighting = (typeof POLL_WEIGHTINGS)[number];

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 10;

export type PollOption = { optionId: string; label: string };

export type Poll = TableKeys &
  AuditFields & {
    entityType: 'POLL';
    pollId: string;
    apartmentId: string;
    title: string;
    description?: string;
    options: PollOption[];
    audience: PollAudience;
    weighting: PollWeighting;
    /** Gizli oylama (varsayilan): yonetim kimin neyi sectigini hicbir zaman gormez; ara sonuc yok. */
    secret: boolean;
    /** Acik oylamada oy verenler sonuclari kapanistan once gorebilir. Gizli oylamada daima false. */
    resultsVisibleBeforeClose: boolean;
    opensAt: IsoDateTime;
    closesAt: IsoDateTime;
    /**
     * Oy listesi tarihi (Europe/Istanbul, `opensAt` gunu). Kimin oy kullanabilecegi ve agirligi
     * mulkiyet modulunun oy listesiyle (`buildVotingRoll`) bu gun icin hesaplanir; yayinda sabitlenir.
     */
    rollDate: IsoDate;
    status: PollStatus;
    publishedAt?: IsoDateTime;
    publishedBy?: string;
    closedAt?: IsoDateTime;
    closedBy?: string;
    closeReason?: string;
    /** Bitis zamanindan once yonetici tarafindan kapatildi. */
    closedEarly?: boolean;
    cancelledAt?: IsoDateTime;
    cancelledBy?: string;
  };

/** Oyu kullananin oylama gunundeki iliskisi (gosterim; agirligi etkilemez). */
export type VoterRelation = 'owner' | 'tenant';

export type PollVote = TableKeys & {
  entityType: 'POLL_VOTE';
  apartmentId: string;
  pollId: string;
  unitId: string;
  optionId: string;
  /** Bolumun oyunu en son kullanan kisi (oy verenin kendi secimini gorebilmesi icin). */
  voterUserId: string;
  voterRelation: VoterRelation;
  castAt: IsoDateTime;
  createdAt: IsoDateTime;
  /** 1: ilk oy; her degisiklikte 1 artar (surum kosullu yazim). */
  version: number;
};

/** Sonuc kesri: tum payda ortak (bolumlerin arsa payi paydalarinin EKOK'u). */
export type Fraction = { numerator: number; denominator: number };

export type OptionTally = {
  optionId: string;
  label: string;
  units: number;
  /** Kullanilan oylar icindeki pay (baz puan, 10.000 = %100). */
  unitsBps: number;
  landShare: Fraction | null;
  landShareBps: number | null;
};

export type PollResults = {
  pollId: string;
  phase: PollPhase;
  /** Oylama bitti: sonuc kesin. */
  final: boolean;
  weighting: PollWeighting;
  rollDate: IsoDate;
  eligible: { units: number; landShare: Fraction | null };
  participation: { units: number; unitsBps: number; landShare: Fraction | null; landShareBps: number | null };
  /** Gizli oylama surerken secenek dagilimi kimseye gosterilmez (yalnizca katilim). */
  tallyHidden: boolean;
  options?: OptionTally[];
  /**
   * Secilen agirliga gore kullanilan oylarin salt cogunlugunu (yarisindan fazlasini) alan secenek.
   * Esitlik veya yari asilmazsa `null`. Gizli ve suren oylamada verilmez.
   */
  winnerOptionId?: string | null;
  warnings: string[];
};

export type PollUnitRow = {
  unitId: string;
  blockId: string;
  number: string;
  landShare?: LandShare;
  voted: boolean;
  /** Yalnizca acik (gizli olmayan) oylamada. */
  optionId?: string;
  castAt?: IsoDateTime;
  voterRelation?: VoterRelation;
  /** Oy listesi uyarilari (malik kaydi yok, hisse eksik...). */
  warnings: string[];
};
