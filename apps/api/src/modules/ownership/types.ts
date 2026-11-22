/**
 * Finans 2.1 - Hisseli mulkiyet ve mulk/hisse devri veri modeli.
 *
 * Mulkiyet sicili (append-only):
 *   PK = `APT#<apartmentId>`, SK = `OWNERSHIP#<unitId>#<validFrom>#<seq>`
 *   Her kayit o tarihten itibaren gecerli TAM pay tablosudur (toplam tam 1). Bir tarihte gecerli
 *   tablo = `validFrom <= tarih` olan en buyuk (validFrom, seq) kayit. Kayit silinmez/degismez.
 *
 * Sicil basi (dairenin guncel durumu, surumlu):
 *   PK = `APT#<apartmentId>`, SK = `OWNERHEAD#<unitId>`
 *   Son sicil sirasi, faturalama modu (`joint` | `split`) ve paydas temsilcisi. Her sicil yazimi
 *   basin surumunu artirir: ayni dairede es zamanli iki devir/duzeltme birbirini ezemez.
 *
 * Devir kaydi:
 *   PK = `APT#<apartmentId>`, SK = `OWNXFER#<transferId>`
 */
import type { IsoDate, IsoDateTime, TableKeys } from '../core/types.js';
import type { UnitMembership } from '../portal/types.js';
import type { OwnerShare, Share } from './shares.js';

export const OWNER_BILLING_MODES = ['joint', 'split'] as const;
/** joint: tek ortak malik carisi (paydaslar birlikte sorumlu); split: paydas basina alt cari. */
export type OwnerBilling = (typeof OWNER_BILLING_MODES)[number];

export type OwnershipHead = TableKeys & {
  entityType: 'OWNERSHIP_HEAD';
  apartmentId: string;
  unitId: string;
  /** Son sicil kaydinin sirasi. */
  seq: number;
  /** Son sicil kaydinin gecerlilik baslangici (yeni kayit bundan once olamaz). */
  currentValidFrom: IsoDate;
  billing: OwnerBilling;
  /** Paydaslarin sectigi temsilci (kat malikleri kurulu); yoksa oy listesinde uyari. */
  representativeUserId?: string;
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export const RECORD_SOURCES = ['backfill', 'manual', 'transfer', 'reversal'] as const;
export type RecordSource = (typeof RECORD_SOURCES)[number];

export type OwnershipRecord = TableKeys & {
  entityType: 'OWNERSHIP_RECORD';
  apartmentId: string;
  unitId: string;
  seq: number;
  validFrom: IsoDate;
  /** Kanonik sirali (userId), sadelestirilmis paylar; toplam tam 1. */
  owners: OwnerShare[];
  source: RecordSource;
  transferId?: string;
  reason: string;
  createdAt: IsoDateTime;
  createdBy: string;
};

export const TRANSFER_KINDS = ['sale_full', 'share_partial', 'inheritance'] as const;
export type TransferKind = (typeof TRANSFER_KINDS)[number];

/** Bir paydastan digerine devredilen pay (dairenin TAMAMINA gore kesir). */
export type ShareMove = { fromUserId: string; toUserId: string; share: Share };

export const TRANSFER_DEBT_TARGETS = ['former', 'new_owner'] as const;
/** Cikan malikin borcu: ayrilan malik carisi (varsayilan) veya yeni malike. */
export type TransferDebtTarget = (typeof TRANSFER_DEBT_TARGETS)[number];

/** Devrin uyelik degisikligi (geri almada eski haline donulur). */
export type OwnershipMembershipChange = {
  userId: string;
  change: 'created' | 'reactivated' | 'share' | 'ended';
  previousShare?: Share;
  previousEndDate?: IsoDate;
  previousStatus?: UnitMembership['status'];
  previousStartDate?: IsoDate;
  previousResidesInUnit?: boolean;
};

/** Devirle yazilan cari kapama (ayni atomik yazimda; `CARI_CLOSURE` kaydi da yazilir). */
export type TransferClosure = {
  closureId: string;
  /** Carisi kapanan malik(lar). */
  userIds: string[];
  sourceAccountId: string;
  targetAccountId?: string;
  debtTo: TransferDebtTarget;
  debt: number;
  advance: number;
  lateFee: number;
};

export type OwnershipTransfer = TableKeys & {
  entityType: 'OWNERSHIP_TRANSFER';
  transferId: string;
  apartmentId: string;
  unitId: string;
  kind: TransferKind;
  /** Yeni mulkiyetin ilk gunu (devralan bu gunden itibaren malik; devreden bir onceki gune kadar). */
  effectiveDate: IsoDate;
  moves: ShareMove[];
  before: OwnerShare[];
  after: OwnerShare[];
  /** Devir anindaki faturalama modu (cari kurallari buna gore uygulandi). */
  billing: OwnerBilling;
  /** Devrin yazdigi sicil kayitlari (ilk sicil ayni yazimda olustuysa `initialSeq`). */
  recordSeq: number;
  initialSeq?: number;
  previousRepresentativeUserId?: string;
  debtTo: TransferDebtTarget;
  closures: TransferClosure[];
  membershipChanges: OwnershipMembershipChange[];
  status: 'completed' | 'reversed';
  reason: string;
  reversal?: { at: IsoDateTime; by: string; reason: string; transactionIds: string[]; recordSeq: number };
  createdAt: IsoDateTime;
  createdBy: string;
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};
