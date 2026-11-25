/**
 * Finans 2.4-2 - Mali donem kilidi ve aylik anlik goruntu (saf kisim: tipler, anahtarlar, hesap).
 * Plan: claude/finans-2-4-donem-kapanisi-butce-plani.md
 *
 *   FINLOCK          PK = APT#<apt>, SK = FINLOCK          apartman geneli kilit (tek kayit)
 *   FPERIOD#<ay>     PK = APT#<apt>, SK = FPERIOD#YYYY-MM  kapanan ayin anlik goruntusu (mizan)
 *
 * Kilit: `lockedThrough` (dahil) ve oncesine tarihli hicbir defter islemi yazilamaz; kontrol
 * `postBatch` icinde ayni TransactWriteItems'ta `ConditionCheck` olarak yapilir (atomik).
 * Kapanis iki fazlidir: once kilit (`closing`) konur, sonra anlik goruntu alinir; boylece
 * goruntu alinirken o aya yeni kayit giremez. Yarida kalan kapanis ayni ayla yeniden cagrilinca
 * devam eder.
 */
import { createHash } from 'node:crypto';
import { tenantPk } from '../../config/dynamodb.js';
import type { IsoDate, IsoDateTime, Kurus, TableKeys } from '../core/types.js';
import { periodBounds } from './lateFee.js';
import type { Account, AccountType, Transaction } from './types.js';

export const periodKeys = {
  lock: (apartmentId: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: 'FINLOCK' }),
  period: (apartmentId: string, period: string): TableKeys => ({ PK: tenantPk(apartmentId), SK: `FPERIOD#${period}` }),
};
export const FISCAL_PERIOD_PREFIX = 'FPERIOD#';

export type FinanceLock = TableKeys & {
  entityType: 'FINANCE_LOCK';
  apartmentId: string;
  /** Bu tarih (dahil) ve oncesine kayit yazilamaz. */
  lockedThrough?: IsoDate;
  /** Son tamamlanan kapanis (YYYY-MM). */
  lastClosedPeriod?: string;
  /** Kilidi konmus ama anlik goruntusu henuz yazilmamis kapanis (yarida kalabilir). */
  closing?: { period: string; previousLockedThrough?: IsoDate; previousLastClosed?: string; startedAt: IsoDateTime; startedBy: string };
  updatedAt: IsoDateTime;
  updatedBy: string;
  version: number;
};

export type SnapshotRow = {
  accountId: string;
  type: AccountType;
  name: string;
  code?: string;
  unitId?: string;
  /** Isaretli kurus: borc - alacak (Account.balance ile ayni anlam). */
  opening: number;
  debit: Kurus;
  credit: Kurus;
  closing: number;
};

export type PeriodSnapshot = {
  rows: SnapshotRow[];
  totals: { debit: number; credit: number; opening: number; closing: number; transactions: number };
  hash: string;
};

export type ChecklistItem = { code: string; message: string; count?: number; amount?: number };

export type FiscalPeriod = TableKeys & {
  entityType: 'FISCAL_PERIOD';
  apartmentId: string;
  period: string;
  periodStart: IsoDate;
  periodEnd: IsoDate;
  status: 'closed' | 'reopened';
  closedAt: IsoDateTime;
  closedBy: string;
  /** Kapanista onaylanarak gecilen uyarilar. */
  acknowledgedWarnings: ChecklistItem[];
  /** Geri acilista kilidin donecegi durum. */
  previousLockedThrough?: IsoDate;
  previousLastClosed?: string;
  snapshot: PeriodSnapshot;
  /** Kacinci kapanis (yeniden acip kapatma sayaci). */
  revision: number;
  reopenHistory: { at: IsoDateTime; by: string; reason: string; revision: number }[];
  version: number;
};

/** Kilitli doneme yazim denemesi (409). Tum defter yazimlari `postBatch`'ten gectigi icin tek kaynak. */
export class PeriodClosedError extends Error {
  readonly code = 'period_closed';
  readonly httpStatus = 409;
  readonly lockedThrough?: IsoDate;

  constructor(lockedThrough?: IsoDate) {
    super(
      lockedThrough
        ? `${formatPeriodTr(lockedThrough.slice(0, 7))} dönemi kapalı (${trDate(lockedThrough)} dahil öncesine kayıt yazılamaz); kaydı açık bir döneme tarihleyin`
        : 'Mali dönem kapalı; kaydı açık bir döneme tarihleyin',
    );
    this.name = 'PeriodClosedError';
    this.lockedThrough = lockedThrough;
  }
}

/** Kapanisi engelleyen veya onay isteyen durumlar (422). */
export class ClosingBlockedError extends Error {
  readonly code = 'closing_blocked';
  readonly httpStatus = 422;
  constructor(
    message: string,
    readonly blockers: ChecklistItem[],
    readonly warnings: ChecklistItem[] = [],
  ) {
    super(message);
    this.name = 'ClosingBlockedError';
  }
}

export class PeriodError extends Error {
  readonly httpStatus: 400 | 404 | 409 | 422;
  constructor(
    readonly code: 'not_found' | 'conflict' | 'unprocessable',
    message: string,
  ) {
    super(message);
    this.name = 'PeriodError';
    this.httpStatus = code === 'not_found' ? 404 : code === 'conflict' ? 409 : 422;
  }
}

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];
export const formatPeriodTr = (period: string) => `${MONTHS[Number(period.slice(5, 7)) - 1] ?? period} ${period.slice(0, 4)}`;
const trDate = (d: IsoDate) => d.split('-').reverse().join('.');

/** Islem gruplarinin en erken tarihi (kilit kosulu icin); islem yoksa undefined. */
export function earliestDate(transactions: readonly Pick<Transaction, 'date'>[]): IsoDate | undefined {
  let min: IsoDate | undefined;
  for (const t of transactions) if (!min || t.date < min) min = t.date;
  return min;
}

/**
 * Aylik anlik goruntu. `opening`: onceki kapanisin kapanis bakiyeleri (yoksa `priorTransactions`
 * toplami); `periodTransactions`: [ay basi, ay sonu] araligindaki islemler. Tum hesaplar listelenir
 * (hareketsizler dahil) ki mizan eksiksiz olsun.
 */
export function buildSnapshot(input: {
  accounts: readonly Account[];
  opening: ReadonlyMap<string, number>;
  periodTransactions: readonly Transaction[];
}): PeriodSnapshot {
  const debit = new Map<string, number>();
  const credit = new Map<string, number>();
  for (const tx of input.periodTransactions) {
    for (const l of tx.lines) {
      const m = l.side === 'debit' ? debit : credit;
      m.set(l.accountId, (m.get(l.accountId) ?? 0) + l.amount);
    }
  }
  const ids = new Set<string>([...input.accounts.map((a) => a.accountId), ...input.opening.keys(), ...debit.keys(), ...credit.keys()]);
  const byId = new Map(input.accounts.map((a) => [a.accountId, a]));
  const rows: SnapshotRow[] = [...ids]
    .map((accountId) => {
      const a = byId.get(accountId);
      const opening = input.opening.get(accountId) ?? 0;
      const d = debit.get(accountId) ?? 0;
      const c = credit.get(accountId) ?? 0;
      return {
        accountId,
        type: a?.type ?? 'equity',
        name: a?.name ?? accountId,
        ...(a?.code ? { code: a.code } : {}),
        ...(a?.unitId ? { unitId: a.unitId } : {}),
        opening,
        debit: d as Kurus,
        credit: c as Kurus,
        closing: opening + d - c,
      };
    })
    // Hareketsiz ve sifir bakiyeli pasif hesaplar mizani kalabaliklastirmaz.
    .filter((r) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0 || byId.get(r.accountId)?.status === 'active')
    .sort((a, b) => TYPE_ORDER[a.type] - TYPE_ORDER[b.type] || (a.code ?? '').localeCompare(b.code ?? '') || a.accountId.localeCompare(b.accountId));
  const totals = {
    debit: rows.reduce((s, r) => s + r.debit, 0),
    credit: rows.reduce((s, r) => s + r.credit, 0),
    opening: rows.reduce((s, r) => s + r.opening, 0),
    closing: rows.reduce((s, r) => s + r.closing, 0),
    transactions: input.periodTransactions.length,
  };
  return { rows, totals, hash: snapshotHash(rows) };
}

const TYPE_ORDER: Record<AccountType, number> = { cash: 0, bank: 1, receivable: 2, payable: 3, income: 4, expense: 5, equity: 6 };

export function snapshotHash(rows: readonly SnapshotRow[]): string {
  const canonical = rows.map((r) => [r.accountId, r.opening, r.debit, r.credit, r.closing].join('|')).join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Islemlerden hesap bazli net (borc - alacak). */
export function netByAccount(transactions: readonly Transaction[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const tx of transactions) {
    for (const l of tx.lines) out.set(l.accountId, (out.get(l.accountId) ?? 0) + (l.side === 'debit' ? l.amount : -l.amount));
  }
  return out;
}

/**
 * Mizan dengesi ve canli bakiye tutarliligi. Cift tarafli defterde donem borc toplami alacak
 * toplamina, tum kapanis bakiyelerinin toplami sifira esittir; ayrica her hesap icin
 * `kapanis + donem sonrasi net = canli bakiye` olmalidir (bakiye sayaci ile defter uyumu).
 */
export function verifySnapshot(
  snapshot: PeriodSnapshot,
  accounts: readonly Account[],
  afterNet: ReadonlyMap<string, number>,
): ChecklistItem[] {
  const problems: ChecklistItem[] = [];
  if (snapshot.totals.debit !== snapshot.totals.credit) {
    problems.push({ code: 'trial_balance_unbalanced', message: 'Dönem borç ve alacak toplamları eşit değil', amount: snapshot.totals.debit - snapshot.totals.credit });
  }
  if (snapshot.totals.closing !== 0) {
    problems.push({ code: 'trial_balance_unbalanced', message: 'Kapanış bakiyelerinin toplamı sıfır değil', amount: snapshot.totals.closing });
  }
  const closing = new Map(snapshot.rows.map((r) => [r.accountId, r.closing]));
  const mismatched = accounts.filter((a) => (closing.get(a.accountId) ?? 0) + (afterNet.get(a.accountId) ?? 0) !== a.balance);
  if (mismatched.length) {
    problems.push({
      code: 'balance_mismatch',
      message: `Defter ile hesap bakiyesi uyuşmuyor: ${mismatched.slice(0, 5).map((a) => a.name).join(', ')}${mismatched.length > 5 ? '…' : ''}`,
      count: mismatched.length,
    });
  }
  return problems;
}

/** Dönem sınırları ve bir sonraki kapanabilir ay. */
export function periodRange(period: string) {
  const { first, last } = periodBounds(period);
  return { start: first, end: last };
}
