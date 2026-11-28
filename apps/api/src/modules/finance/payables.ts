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
 *
 * Tedarikci avans mahsubu (`supplier_advance_offset`, borc: tedarikci): mahsubun hedefledigi
 * faturalar (`supplierAdvance.settles`) ONCE kendi tutarlariyla kapanir (`advanceApplied`);
 * hedefe yerlesmeyen kalan (or. fatura sonradan iptal edildi) odemelerle ayni FIFO havuzuna girer.
 */

export type PayableItem = {
  transactionId: string;
  date: IsoDate;
  description: string;
  reference?: string;
  amount: number;
  /** Henuz odenmemis kisim. */
  open: number;
  /** Bu faturaya hedefli mahsup edilen tedarikci avansi. */
  advanceApplied?: number;
};

export type PayableSummary = {
  /** Faturalar (iptal edilmemis alacak kalemleri) toplami. */
  billed: number;
  /** Odemeler (iptal edilmemis borc kalemleri; avans mahsubu haric) toplami. */
  paid: number;
  /** Avans mahsuplari (iptal edilmemis `supplier_advance_offset`) toplami. */
  advanceApplied: number;
  /** Acik borc (billed - paid - advanceApplied, en az 0). */
  openBalance: number;
  /** Faturalardan fazla odeme (normalde 0; fazla odeme reddedilir). */
  advance: number;
  /** Acik kalemler (eskiden yeniye). */
  openItems: PayableItem[];
  lastPaymentDate?: IsoDate;
};

type TxLike = Pick<Transaction, 'transactionId' | 'kind' | 'description' | 'reference' | 'reversalOf'> & Partial<Pick<Transaction, 'supplierAdvance'>>;

export function payableSummary(
  accountId: string,
  entries: readonly Pick<LedgerEntry, 'accountId' | 'transactionId' | 'side' | 'amount' | 'date' | 'createdAt'>[],
  txById: ReadonlyMap<string, TxLike>,
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
  const offsets: { amount: number; settles: { transactionId: string; amount: number }[] }[] = [];
  let paid = 0;
  let advanceApplied = 0;
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
    } else if (tx.kind === 'supplier_advance_offset') {
      advanceApplied += e.amount;
      offsets.push({ amount: e.amount, settles: tx.supplierAdvance?.settles ?? [] });
    } else {
      paid += e.amount;
      if (!lastPaymentDate || e.date > lastPaymentDate) lastPaymentDate = e.date;
    }
  }
  const billed = bills.reduce((s, b) => s + b.amount, 0);
  const byId = new Map(bills.map((b) => [b.transactionId, b]));
  let pool = paid;
  // 1) Hedefli avans mahsuplari kendi faturalarina; yerlesmeyen kalan havuza.
  for (const o of offsets) {
    let left = o.amount;
    for (const st of o.settles) {
      const bill = byId.get(st.transactionId);
      if (!bill || left <= 0) continue;
      const take = Math.min(st.amount, bill.open, left);
      if (take <= 0) continue;
      bill.open -= take;
      bill.advanceApplied = (bill.advanceApplied ?? 0) + take;
      left -= take;
    }
    pool += left;
  }
  // 2) Odemeler (ve yerlesmeyen mahsup kalani) eskiden yeniye.
  for (const b of bills) {
    const take = Math.min(pool, b.open);
    b.open -= take;
    pool -= take;
  }
  return {
    billed,
    paid,
    advanceApplied,
    openBalance: Math.max(0, billed - paid - advanceApplied),
    advance: Math.max(0, paid + advanceApplied - billed),
    openItems: bills.filter((b) => b.open > 0),
    ...(lastPaymentDate ? { lastPaymentDate } : {}),
  };
}
