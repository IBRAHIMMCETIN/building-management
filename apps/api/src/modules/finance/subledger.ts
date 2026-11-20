/**
 * Alt cari (sakin/malik alacak hesabi) yorumlayicisi - TEK KAYNAK.
 *
 * Portal (acik kalemler, ozet), online odeme teklifi, raporlar (aidat durumu, hatirlatma) ve
 * kistelyevm (tazminat kesinlestirme) bir alt carinin satirlarini hep ayni kurallarla okur:
 *
 *  - Ters kayitla iptal edilen islem ve ters kaydin kendisi yok sayilir.
 *  - Cari kapama (`transfer` + `role: 'close'`): kesim tarihi ve oncesindeki satirlar (kapama
 *    islemi dahil) yok sayilir. Kapama o donemin net bakiyesini devrettigi icin bu satirlarin
 *    toplami sifirdir; hesaba kesim tarihine kadar yeni kayit yazilamaz (kilit).
 *  - Borc satirlari kalemdir: aidat/devir tahakkuku ve diger borclar anapara, `late_fee`
 *    tazminat kalemi; devir acilisi (`transfer` + `role: 'open'`) kalemlerine acilir.
 *  - Tazminat tabani: aidat tahakkuku, devir (acilis) bakiyesi ve devredilmis anapara (devir
 *    tarihinden itibaren). Tazminata tazminat islemez.
 *  - Alacak satirlari (tahsilat vb.) havuzdur; mahsup FIFO: once anapara (vade sirasiyla), en
 *    son tazminat kalemleri (karar 2a).
 *
 * Saf fonksiyonlar; I/O yok.
 */
import type { IsoDate, Kurus } from '../core/types.js';
import type { EntrySide, LedgerEntry, Transaction, TransactionKind } from './types.js';

export type AccountLine = { transaction: Transaction; side: EntrySide; amount: number; date: IsoDate };

export type SubCharge = {
  /** Islem kimligi; devir kaleminde `<islem>_<sira>`. Odeme kalem secimi bu kimlikle yapilir. */
  id: string;
  transactionId: string;
  txKind: TransactionKind;
  /** Deftere yazilmis tazminat kalemi (mahsupta en son). */
  lateFee: boolean;
  /** Kistelyevm tabanina girer mi? */
  feeBearing: boolean;
  description: string;
  date: IsoDate;
  dueDate: IsoDate;
  /** Tazminatin baslangici (devredilmis anaparada devir tarihi). */
  accrueFrom?: IsoDate;
  amount: number;
};

export type SubCredit = { transactionId: string; txKind: TransactionKind; date: IsoDate; amount: number };

export type Subledger = {
  /** Son cari kapama kesim tarihi (varsa); bu tarih ve oncesi dikkate alinmadi. */
  cutoff?: IsoDate;
  charges: SubCharge[];
  credits: SubCredit[];
  /** Bu hesapta deftere yazilmis (iptal edilmemis) tazminat toplami. */
  postedFees: number;
  /** Dikkate alinan satirlarin bakiyesi (borc - alacak). */
  balance: number;
};

/** Ters kayitla iptal edilen islemler ve ters kayitlarin kendisi. */
export function cancelledIn(transactions: Iterable<Transaction>): Set<string> {
  const cancelled = new Set<string>();
  for (const tx of transactions) {
    if (tx.kind === 'reversal' && tx.reversalOf) {
      cancelled.add(tx.reversalOf);
      cancelled.add(tx.transactionId);
    }
  }
  return cancelled;
}

/** Bir hesabin satirlari (islem listesinden). */
export function linesOfAccount(accountId: string, transactions: Iterable<Transaction>): AccountLine[] {
  const out: AccountLine[] = [];
  for (const tx of transactions) {
    for (const line of tx.lines) {
      if (line.accountId === accountId) out.push({ transaction: tx, side: line.side, amount: line.amount, date: tx.date });
    }
  }
  return out;
}

/** Bir hesabin satirlari (defter kayitlarindan; islemi bulunamayan kayit atlanir). */
export function linesFromEntries(entries: readonly LedgerEntry[], txById: ReadonlyMap<string, Transaction>): AccountLine[] {
  const out: AccountLine[] = [];
  for (const e of entries) {
    const tx = txById.get(e.transactionId);
    if (tx) out.push({ transaction: tx, side: e.side, amount: e.amount, date: e.date });
  }
  return out;
}

const FEE_BASE_KINDS: ReadonlySet<TransactionKind> = new Set(['dues_charge', 'opening_balance']);

/** Devir kaleminin kimligi (islem kimligi + sira; ID deseni `[A-Za-z0-9_-]`). */
export const transferItemId = (transactionId: string, index: number) => `${transactionId}_${index + 1}`;

export function readSubledger(lines: readonly AccountLine[], cancelled: ReadonlySet<string> = cancelledIn(lines.map((l) => l.transaction))): Subledger {
  const live = lines.filter((l) => !cancelled.has(l.transaction.transactionId) && l.transaction.kind !== 'reversal');

  let cutoff: IsoDate | undefined;
  for (const l of live) {
    const t = l.transaction.transfer;
    if (l.transaction.kind === 'transfer' && t?.role === 'close') {
      const c = t.cutoff ?? l.transaction.date;
      if (!cutoff || c > cutoff) cutoff = c;
    }
  }
  const scoped = cutoff ? live.filter((l) => l.date > (cutoff as IsoDate)) : live;

  const charges: SubCharge[] = [];
  const credits: SubCredit[] = [];
  let postedFees = 0;
  let balance = 0;

  for (const l of scoped) {
    const tx = l.transaction;
    balance += l.side === 'debit' ? l.amount : -l.amount;
    if (l.side === 'credit') {
      credits.push({ transactionId: tx.transactionId, txKind: tx.kind, date: l.date, amount: l.amount });
      continue;
    }

    const items = tx.kind === 'transfer' && tx.transfer?.role === 'open' ? tx.transfer.items : undefined;
    if (items && items.length > 0 && items.reduce((s, i) => s + i.amount, 0) === l.amount) {
      items.forEach((it, i) => {
        const fee = it.category === 'late_fee';
        charges.push({
          id: transferItemId(tx.transactionId, i),
          transactionId: tx.transactionId,
          txKind: tx.kind,
          lateFee: fee,
          feeBearing: !fee,
          description: it.description,
          date: it.date,
          dueDate: it.dueDate,
          // Devir tarihine kadarki tazminat kaynakta kesinlestirildi.
          ...(fee ? {} : { accrueFrom: tx.date }),
          amount: it.amount,
        });
      });
      continue;
    }

    const fee = tx.kind === 'late_fee';
    if (fee) postedFees += l.amount;
    charges.push({
      id: tx.transactionId,
      transactionId: tx.transactionId,
      txKind: tx.kind,
      lateFee: fee,
      feeBearing: FEE_BASE_KINDS.has(tx.kind),
      description: tx.description,
      date: tx.date,
      // Vadesiz borc satiri (ornegin bir odemenin ters kaydi) islem tarihinde vadeli sayilir.
      dueDate: tx.dueDate ?? tx.date,
      amount: l.amount,
    });
  }

  return { ...(cutoff ? { cutoff } : {}), charges, credits, postedFees, balance };
}

/** Kistelyevm girdileri (bkz. `lateFee.ts`). */
export function feeInputsOf(sub: Subledger) {
  return {
    charges: sub.charges
      .filter((c) => c.feeBearing)
      .map((c) => ({ id: c.id, dueDate: c.dueDate, amount: c.amount, ...(c.accrueFrom ? { accrueFrom: c.accrueFrom } : {}) })),
    credits: sub.credits.map((c) => ({ date: c.date, amount: c.amount })),
    postedFees: sub.postedFees,
  };
}

export type AllocatedCharge = SubCharge & { paid: Kurus; remaining: Kurus; overdue: boolean; daysOverdue: number };

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** FIFO sirasi: anapara once (vade, tarih, kimlik), tazminat kalemleri en son (karar 2a). */
export function fifoOrder(a: SubCharge, b: SubCharge): number {
  return (
    Number(a.lateFee) - Number(b.lateFee) ||
    a.dueDate.localeCompare(b.dueDate) ||
    a.date.localeCompare(b.date) ||
    a.id.localeCompare(b.id)
  );
}

/**
 * Alacak havuzunu kalemlere FIFO mahsup eder. `open`: kalan tutari olan kalemler (FIFO sirasinda);
 * `all`: tum kalemler odenen/kalan tutarlariyla; `advance`: artan alacak.
 */
export function allocate(sub: Subledger, today: IsoDate): { open: AllocatedCharge[]; all: AllocatedCharge[]; advance: Kurus } {
  let credit = sub.credits.reduce((s, c) => s + c.amount, 0);
  const all: AllocatedCharge[] = [];
  for (const c of [...sub.charges].sort(fifoOrder)) {
    const applied = Math.min(credit, c.amount);
    credit -= applied;
    const remaining = c.amount - applied;
    const late = remaining > 0 && c.dueDate < today;
    all.push({
      ...c,
      paid: applied as Kurus,
      remaining: remaining as Kurus,
      overdue: late,
      daysOverdue: late ? daysBetween(c.dueDate, today) : 0,
    });
  }
  return { open: all.filter((c) => c.remaining > 0), all, advance: credit as Kurus };
}
