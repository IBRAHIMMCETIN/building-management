import type { IsoDate } from '../core/types.js';
import type { LedgerEntry, Transaction } from './types.js';

/*
 * Faz B3.5 - Tedarikci (payable) acik kalemleri (saf hesap).
 *
 * Tedarikci hesabi alacak-normaldir: vadeli gider (`expense`, alacak: tedarikci) borcu artirir,
 * `payable_payment` (borc: tedarikci) azaltir. Hesap bakiyesi depoda borc - alacak olarak
 * tutuldugu icin acik borc = -balance.
 *
 * Acik kalemler: ters kayitla iptal edilen islemler (ve ters kayitlarin kendisi) haric tutulur;
 * kalan alacak kalemleri (faturalar) eskiden yeniye, kalan borc kalemleri (odemeler) toplami ile
 * kapatilir (FIFO). Odeme faturaya bagli degildir; dokum bilgi amaclidir.
 */

export type PayableItem = {
  transactionId: string;
  date: IsoDate;
  description: string;
  reference?: string;
  amount: number;
  /** Henuz odenmemis kisim. */
  open: number;
};

export type PayableSummary = {
  /** Faturalar (iptal edilmemis alacak kalemleri) toplami. */
  billed: number;
  /** Odemeler (iptal edilmemis borc kalemleri) toplami. */
  paid: number;
  /** Acik borc (billed - paid, en az 0). */
  openBalance: number;
  /** Faturalardan fazla odeme (normalde 0; fazla odeme reddedilir). */
  advance: number;
  /** Acik kalemler (eskiden yeniye). */
  openItems: PayableItem[];
  lastPaymentDate?: IsoDate;
};

export function payableSummary(
  accountId: string,
  entries: readonly Pick<LedgerEntry, 'accountId' | 'transactionId' | 'side' | 'amount' | 'date' | 'createdAt'>[],
  txById: ReadonlyMap<string, Pick<Transaction, 'transactionId' | 'kind' | 'description' | 'reference' | 'reversalOf'>>,
): PayableSummary {
  const own = entries.filter((e) => e.accountId === accountId);
  const reversed = new Set<string>();
  for (const e of own) {
    const tx = txById.get(e.transactionId);
    if (tx?.kind === 'reversal' && tx.reversalOf) reversed.add(tx.reversalOf);
  }
  const sorted = [...own].sort(
    (a, b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.transactionId.localeCompare(b.transactionId),
  );
  const bills: PayableItem[] = [];
  let paid = 0;
  let lastPaymentDate: IsoDate | undefined;
  for (const e of sorted) {
    const tx = txById.get(e.transactionId);
    if (!tx || tx.kind === 'reversal' || reversed.has(tx.transactionId)) continue;
    if (e.side === 'credit') {
      bills.push({
        transactionId: tx.transactionId,
        date: e.date,
        description: tx.description,
        ...(tx.reference ? { reference: tx.reference } : {}),
        amount: e.amount,
        open: e.amount,
      });
    } else {
      paid += e.amount;
      if (!lastPaymentDate || e.date > lastPaymentDate) lastPaymentDate = e.date;
    }
  }
  const billed = bills.reduce((s, b) => s + b.amount, 0);
  let pool = paid;
  for (const b of bills) {
    const take = Math.min(pool, b.open);
    b.open -= take;
    pool -= take;
  }
  return {
    billed,
    paid,
    openBalance: Math.max(0, billed - paid),
    advance: Math.max(0, paid - billed),
    openItems: bills.filter((b) => b.open > 0),
    ...(lastPaymentDate ? { lastPaymentDate } : {}),
  };
}
