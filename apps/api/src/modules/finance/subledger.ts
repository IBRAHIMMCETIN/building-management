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
 *  - Finans 2.2 hedefli mahsup: alacak satirindaki `settles` kismi havuza girmez, gosterilen
 *    kalemleri dogrudan kapatir (once uygulanir); kalan kisim havuzdur. Hedefli kapama olmayan
 *    defterlerde sonuc oncekiyle birebir aynidir.
 *  - Finans 2.2 yapilandirma kalemleri (`restructure` + `plan.items`): taksit / birlestirilmis
 *    kalem; tazminat tabani yalnizca `feeBase` (anapara payi), odemeler once anapara payini kapatir.
 *
 * Saf fonksiyonlar; I/O yok.
 */
import type { IsoDate, Kurus } from '../core/types.js';
import type { EntrySide, LedgerEntry, Transaction, TransactionKind } from './types.js';

export type AccountLine = {
  transaction: Transaction;
  side: EntrySide;
  amount: number;
  date: IsoDate;
  /** Finans 2.2: hedefli mahsup (yalnizca alacak satiri). */
  settles?: readonly { chargeId: string; amount: number }[];
};

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
  /** Finans 2.2: tazminat tabani (yapilandirma kalemi; yoksa tutarin tamami). */
  feeBase?: number;
  /** Finans 2.2: yapilandirma kalemi ise plan kimligi ve taksit sirasi. */
  plan?: { planId: string; no: number };
};

export type SubCredit = { transactionId: string; txKind: TransactionKind; date: IsoDate; amount: number };
/** Finans 2.2: hedefli kapama (havuz disi). */
export type SubSettlement = { transactionId: string; txKind: TransactionKind; date: IsoDate; chargeId: string; amount: number };

export type Subledger = {
  /** Son cari kapama kesim tarihi (varsa); bu tarih ve oncesi dikkate alinmadi. */
  cutoff?: IsoDate;
  charges: SubCharge[];
  /** Havuz (FIFO) alacaklari. */
  credits: SubCredit[];
  /** Finans 2.2: kaleme bagli (hedefli) kapamalar. */
  settlements: SubSettlement[];
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
      if (line.accountId === accountId) {
        out.push({ transaction: tx, side: line.side, amount: line.amount, date: tx.date, ...(line.settles ? { settles: line.settles } : {}) });
      }
    }
  }
  return out;
}

/** Bir hesabin satirlari (defter kayitlarindan; islemi bulunamayan kayit atlanir). */
export function linesFromEntries(entries: readonly LedgerEntry[], txById: ReadonlyMap<string, Transaction>): AccountLine[] {
  const out: AccountLine[] = [];
  for (const e of entries) {
    const tx = txById.get(e.transactionId);
    if (!tx) continue;
    // Hedefli mahsup islem satirindadir (defter kaydinda tutulmaz).
    const settles = Array.isArray(tx.lines) && Number.isFinite(e.lineNo) ? tx.lines[e.lineNo - 1]?.settles : undefined;
    out.push({ transaction: tx, side: e.side, amount: e.amount, date: e.date, ...(settles ? { settles } : {}) });
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
  const settlements: SubSettlement[] = [];
  const offsetDebits: { transactionId: string; date: IsoDate; amount: number; description: string }[] = [];
  let postedFees = 0;
  let balance = 0;

  for (const l of scoped) {
    const tx = l.transaction;
    balance += l.side === 'debit' ? l.amount : -l.amount;
    if (l.side === 'credit') {
      let pooled = l.amount;
      for (const st of l.settles ?? []) {
        const amount = Math.min(st.amount, pooled);
        if (amount <= 0) continue;
        settlements.push({ transactionId: tx.transactionId, txKind: tx.kind, date: l.date, chargeId: st.chargeId, amount });
        pooled -= amount;
      }
      if (pooled > 0) credits.push({ transactionId: tx.transactionId, txKind: tx.kind, date: l.date, amount: pooled });
      continue;
    }
    // Finans 2.2: avans mahsubunun kaynak (borc) satiri kalem degildir; avansi (havuzu) tuketir.
    if (tx.kind === 'offset') {
      offsetDebits.push({ transactionId: tx.transactionId, date: l.date, amount: l.amount, description: tx.description });
      continue;
    }
    // Finans 2.2: yapilandirma kalemleri (taksitler / birlestirilmis kalem).
    const planItems = tx.kind === 'restructure' ? tx.plan?.items : undefined;
    if (planItems && planItems.length > 0 && planItems.reduce((sum, it) => sum + it.amount, 0) === l.amount) {
      const planId = tx.plan?.planId ?? '';
      planItems.forEach((it, i) => {
        charges.push({
          id: transferItemId(tx.transactionId, i),
          transactionId: tx.transactionId,
          txKind: tx.kind,
          lateFee: false,
          feeBearing: it.feeBase > 0,
          description: it.description,
          date: tx.date,
          dueDate: it.dueDate,
          amount: it.amount,
          feeBase: Math.min(it.feeBase, it.amount),
          plan: { planId, no: it.no },
        });
      });
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

  // Bilinmeyen (veya bu donemde olmayan) kaleme hedefli kapama havuza sayilir: toplam korunur.
  const known = new Set(charges.map((c) => c.id));
  const kept: SubSettlement[] = [];
  for (const st of settlements) {
    if (known.has(st.chargeId)) kept.push(st);
    else credits.push({ transactionId: st.transactionId, txKind: st.txKind, date: st.date, amount: st.amount });
  }
  // Avans mahsubu: mahsup gunune kadarki havuz alacaklarindan EN YENIDEN geriye dusulur (eski
  // alacaklarin kalemlere mahsup zamanlamasi, dolayisiyla tazminat hesabi degismez). Havuz
  // yetmezse (ornegin sonradan bir tahsilat ters kaydedildi) kalan kisim tazminat dogurmayan,
  // mahsup gunu vadeli bir borc kalemi olur.
  for (const od of offsetDebits) {
    let left = od.amount;
    const candidates = credits
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c.date <= od.date && c.amount > 0)
      .sort((a, b) => b.c.date.localeCompare(a.c.date) || b.i - a.i);
    for (const { c } of candidates) {
      if (left <= 0) break;
      const take = Math.min(left, c.amount);
      c.amount -= take;
      left -= take;
    }
    if (left > 0) {
      charges.push({
        id: od.transactionId,
        transactionId: od.transactionId,
        txKind: 'offset',
        lateFee: false,
        feeBearing: false,
        description: od.description,
        date: od.date,
        dueDate: od.date,
        amount: left,
      });
    }
  }
  const pool = credits.filter((c) => c.amount > 0);
  return { ...(cutoff ? { cutoff } : {}), charges, credits: pool, settlements: kept, postedFees, balance };
}

/** Kistelyevm girdileri (bkz. `lateFee.ts`). */
export function feeInputsOf(sub: Subledger) {
  const bearing = new Set(sub.charges.filter((c) => c.feeBearing).map((c) => c.id));
  return {
    charges: sub.charges
      .filter((c) => c.feeBearing)
      .map((c) => ({
        id: c.id,
        dueDate: c.dueDate,
        amount: c.amount,
        ...(c.accrueFrom ? { accrueFrom: c.accrueFrom } : {}),
        ...(c.feeBase !== undefined && c.feeBase < c.amount ? { feeBase: c.feeBase } : {}),
      })),
    credits: sub.credits.map((c) => ({ date: c.date, amount: c.amount })),
    // Finans 2.2: tazminat dogurmayan kaleme hedefli kapama tazminat hesabini etkilemez.
    settlements: sub.settlements.filter((st) => bearing.has(st.chargeId)).map((st) => ({ chargeId: st.chargeId, date: st.date, amount: st.amount })),
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
  // Finans 2.2: hedefli kapamalar once kendi kalemlerine; kalem tutarini asan kisim havuza.
  const settled = new Map<string, number>();
  for (const st of sub.settlements ?? []) settled.set(st.chargeId, (settled.get(st.chargeId) ?? 0) + st.amount);
  const all: AllocatedCharge[] = [];
  for (const c of [...sub.charges].sort(fifoOrder)) {
    const total = settled.get(c.id) ?? 0;
    const targeted = Math.min(total, c.amount);
    credit += total - targeted;
    const pooled = Math.min(credit, c.amount - targeted);
    credit -= pooled;
    const applied = targeted + pooled;
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

/**
 * Finans 2.2: hesapta odenmemis yapilandirma (taksit / muaccel) kalemi kalan planlar. Boyle bir
 * caride tasinma kapamasi ve mulk/hisse devri yapilamaz (once plan kapanmali veya iptal edilmeli).
 */
export function openPlanIds(accountId: string, transactions: readonly Transaction[]): string[] {
  const sub = readSubledger(linesOfAccount(accountId, transactions), cancelledIn(transactions));
  const { open } = allocate(sub, '9999-12-31');
  return [...new Set(open.flatMap((c) => (c.plan ? [c.plan.planId] : [])))];
}
