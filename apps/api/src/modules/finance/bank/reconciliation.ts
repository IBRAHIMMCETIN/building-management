import type { IsoDate } from '../../core/types.js';
import type { LedgerEntry } from '../types.js';
import type { BankLine, BankStatement, DirectionTotals, LineDirection, LineStatus } from './types.js';

/*
 * Faz B3 - Banka mutabakati (saf hesaplar). API (`GET /api/bank/reconciliation`) ve gece denetimi
 * (`ledger_audit` -> `BankReconDiff` metrigi) ayni tanimi kullanir.
 *
 *   diff            = ekstre kapanis bakiyesi - defterdeki banka hesabi bakiyesi (ayni gun sonu)
 *   pendingNet      = o gune kadar eslesmemis (deftere islenmemis) satirlar: giren - cikan
 *   unexplainedDiff = diff - pendingNet
 *
 * Eslesmemis satirlar bankada olup defterde henuz olmayan hareketlerdir; farkin bu kismi
 * "beklenen"dir. `unexplainedDiff` sifir degilse banka ile defter, bekleyen satirlarla
 * aciklanamayacak sekilde ayrismistir: yoksayilan ama deftere hic islenmemis masraf, bankaya
 * yansimamis elle kayit, eksik/cakisan ekstre vb.
 */

export type ReconBucket = DirectionTotals;

export type ReconBreakdown = Record<`${'matched' | 'unmatched' | 'ignored'}${'In' | 'Out'}`, ReconBucket>;

export type ReconStatement = Pick<BankStatement, 'statementId' | 'bankAccountId' | 'status' | 'fileName' | 'period' | 'openingBalance' | 'closingBalance' | 'committed'>;

export type ReconLine = Pick<BankLine, 'date' | 'direction' | 'amount' | 'status'>;

const emptyBucket = (): ReconBucket => ({ count: 0, amount: 0 as ReconBucket['amount'] });

export function emptyBreakdown(): ReconBreakdown {
  return {
    matchedIn: emptyBucket(),
    matchedOut: emptyBucket(),
    unmatchedIn: emptyBucket(),
    unmatchedOut: emptyBucket(),
    ignoredIn: emptyBucket(),
    ignoredOut: emptyBucket(),
  };
}

const bucketKey = (status: LineStatus, direction: LineDirection) =>
  `${status}${direction === 'in' ? 'In' : 'Out'}` as keyof ReconBreakdown;

const inRange = (date: IsoDate, range: { from?: IsoDate; to?: IsoDate }) => (!range.from || date >= range.from) && (!range.to || date <= range.to);

/** Satir dokumu (tarih araliginda; `range` bossa tum satirlar). */
export function addLines(target: ReconBreakdown, lines: readonly ReconLine[], range: { from?: IsoDate; to?: IsoDate } = {}): ReconBreakdown {
  for (const l of lines) {
    if (!inRange(l.date, range)) continue;
    const b = target[bucketKey(l.status, l.direction)];
    b.count++;
    b.amount = (b.amount + l.amount) as ReconBucket['amount'];
  }
  return target;
}

/** Verilen gun sonuna kadar eslesmemis satirlarin net etkisi (giren - cikan). */
export function pendingNetThrough(lines: readonly ReconLine[], asOf: IsoDate): number {
  let net = 0;
  for (const l of lines) {
    if (l.status !== 'unmatched' || l.date > asOf) continue;
    net += l.direction === 'in' ? l.amount : -l.amount;
  }
  return net;
}

/** Defterdeki hesap bakiyesi (borc - alacak) verilen gun sonunda. */
export function ledgerBalanceThrough(entries: readonly Pick<LedgerEntry, 'accountId' | 'date' | 'side' | 'amount'>[], accountId: string, asOf: IsoDate): number {
  let total = 0;
  for (const e of entries) {
    if (e.accountId !== accountId || e.date > asOf) continue;
    total += e.side === 'debit' ? e.amount : -e.amount;
  }
  return total;
}

type Dated = ReconStatement & { period: { from: IsoDate; to: IsoDate } };

/**
 * Hesabin aktarilmis (committed) ekstreleri arasindan araliga duseni secer:
 *   opening: araligin basindan sonra baslayan en eski ekstre (acilis bakiyesi o gun basinda)
 *   closing: araligin sonundan once biten en yeni ekstre (kapanis bakiyesi o gun sonunda)
 * Ayni gun biten ekstrelerden en son aktarilan secilir.
 */
export function pickStatements(statements: readonly ReconStatement[], bankAccountId: string, range: { from?: IsoDate; to?: IsoDate } = {}) {
  const usable = statements.filter(
    (s): s is Dated => s.bankAccountId === bankAccountId && s.status === 'committed' && Boolean(s.period),
  );
  const closing = usable
    .filter((s) => !range.to || s.period.to <= range.to)
    .filter((s) => !range.from || s.period.to >= range.from)
    .sort((a, b) => b.period.to.localeCompare(a.period.to) || (b.committed?.committedAt ?? '').localeCompare(a.committed?.committedAt ?? ''))[0];
  const opening = usable
    .filter((s) => !range.from || s.period.from >= range.from)
    .filter((s) => !range.to || s.period.from <= range.to)
    .sort((a, b) => a.period.from.localeCompare(b.period.from) || (a.committed?.committedAt ?? '').localeCompare(b.committed?.committedAt ?? ''))[0];
  return { opening, closing };
}

export type AccountRecon = {
  bankAccountId: string;
  statementId: string;
  /** Kapanis bakiyesinin gunu (ekstrenin son hareket tarihi). */
  asOf: IsoDate;
  closingBalance: number;
  ledgerBalance: number;
  diff: number;
  pendingNet: number;
  unexplainedDiff: number;
};

/** Tek banka hesabi icin kapanis mutabakati; kapanis bakiyeli ekstre yoksa `undefined`. */
export function reconcileAccount(input: {
  bankAccountId: string;
  statements: readonly ReconStatement[];
  lines: readonly ReconLine[];
  entries: readonly Pick<LedgerEntry, 'accountId' | 'date' | 'side' | 'amount'>[];
  to?: IsoDate;
}): AccountRecon | undefined {
  const { closing } = pickStatements(input.statements, input.bankAccountId, input.to ? { to: input.to } : {});
  if (!closing?.period || closing.closingBalance === undefined) return undefined;
  const asOf = closing.period.to;
  const ledgerBalance = ledgerBalanceThrough(input.entries, input.bankAccountId, asOf);
  const diff = closing.closingBalance - ledgerBalance;
  const pendingNet = pendingNetThrough(input.lines, asOf);
  return {
    bankAccountId: input.bankAccountId,
    statementId: closing.statementId,
    asOf,
    closingBalance: closing.closingBalance,
    ledgerBalance,
    diff,
    pendingNet,
    unexplainedDiff: diff - pendingNet,
  };
}
