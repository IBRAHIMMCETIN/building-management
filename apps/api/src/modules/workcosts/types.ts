/**
 * Faz 3 (O1-4) - Is masraflari: ariza talebi ve bakim gorevinin Finans baglantisi.
 *
 * Tek tablo, `PK = APT#<apartmentId>`:
 *
 *   EXPLINK#<expenseId>    masraf kilidi (surumlu): bir masraf yalnizca BIR ise baglanabilir.
 *                          Baglanti kaldirilinca `status: unlinked` olur (silme yok); yeniden
 *                          baglama ayni kaydi surumle gunceller.
 *
 * Ozet (`costSummary`) talep / gorev kaydinin icindedir ve masraf, kilit, (talepte) olay ile
 * AYNI `TransactWriteItems` icinde yazilir. Ters kayitla iptal edilen masraf ve yansitma okuma
 * aninda `reversed` sayilir ve canli toplamdan duser (defter append-only).
 */
import type { IsoDate, IsoDateTime, LiableParty, TableKeys } from '../core/types.js';

export const WORK_KINDS = ['ticket', 'maintenance'] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

/** `expense`: bu isten yeni gider kaydi; `link`: Finans'ta var olan gider baglandi. */
export type CostMode = 'expense' | 'link';

export type CostItem = {
  expenseId: string;
  transactionId: string;
  /** Kurus. */
  amount: number;
  mode: CostMode;
  date: IsoDate;
  description: string;
  linkedAt: IsoDateTime;
  linkedBy: string;
};

/** Daireye yansitma (yalnizca daire ici talep; yonetici acik onayi). */
export type CostRecharge = {
  transactionId: string;
  amount: number;
  unitId: string;
  /** Borcun yazildigi taraf (bos dairede sakin istense de malik). */
  liableParty: LiableParty;
  /** Yoneticinin sectigi taraf. */
  requestedParty: LiableParty;
  dueDate: IsoDate;
  description: string;
  at: IsoDateTime;
  by: string;
};

export type CostSummary = {
  /** Bagli masraflarin yazim anindaki toplami (iptaller okuma aninda duser). */
  total: number;
  expenseIds: string[];
  items?: CostItem[];
  recharges?: CostRecharge[];
};

export type ExpenseLinkRecord = TableKeys & {
  entityType: 'EXPENSE_LINK';
  apartmentId: string;
  expenseId: string;
  transactionId: string;
  amount: number;
  target: { type: WorkKind; id: string; label: string };
  mode: CostMode;
  status: 'active' | 'unlinked';
  linkedAt: IsoDateTime;
  linkedBy: string;
  unlinkedAt?: IsoDateTime;
  unlinkedBy?: string;
  unlinkReason?: string;
  version: number;
};

export const EXPLINK_PREFIX = 'EXPLINK#';
export const workCostKeys = {
  link: (apartmentId: string, expenseId: string): TableKeys => ({ PK: `APT#${apartmentId}`, SK: `${EXPLINK_PREFIX}${expenseId}` }),
};

/** Kategoriden onerilen gider hesabi (hazir hesaplar; yonetici degistirebilir). */
export const CATEGORY_EXPENSE_ACCOUNT: Record<string, string> = {
  elevator: 'exp-elevator',
  heating: 'exp-heating',
  garden: 'exp-garden',
  cleaning: 'exp-cleaning',
  security: 'exp-security',
};
export const DEFAULT_REPAIR_ACCOUNT = 'exp-repair';
export const expenseAccountFor = (category: string) => CATEGORY_EXPENSE_ACCOUNT[category] ?? DEFAULT_REPAIR_ACCOUNT;
