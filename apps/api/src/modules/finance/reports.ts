/**
 * Finans raporlari (saf fonksiyonlar). Defter append-only oldugu icin raporlar islem
 * basliklarindan (Transaction.lines) ve hesap bakiyelerinden turetilir; hicbir sey yazmaz.
 * Tum tutarlar kurus cinsinden tam sayidir.
 */
import type { IsoDate, LiableParty, Unit } from '../core/types.js';
import { type FeeCharge, type FeeCredit, cancelledTransactions, unpostedLateFee } from './lateFee.js';
import type { Account, Transaction } from './types.js';

// ---------------------------------------------------------------------------
// Islem siniflandirma (hareket tablosu)
// ---------------------------------------------------------------------------

/**
 * income: kasa/bankaya giris (tahsilat), expense: kasa/bankadan cikis (gider),
 * transfer: kasa <-> banka, accrual: nakit hareketi olmayan tahakkuk, reversal: ters kayit.
 */
export type TransactionCategory = 'income' | 'expense' | 'transfer' | 'accrual' | 'reversal';

export type FundsMovement = {
  accountId: string;
  accountName: string;
  accountType: 'cash' | 'bank';
  direction: 'in' | 'out';
  amount: number;
};

export type TransactionView = {
  transactionId: string;
  date: IsoDate;
  dueDate?: IsoDate;
  description: string;
  kind: Transaction['kind'];
  category: TransactionCategory;
  amount: number;
  /** Kasa/banka satirlari (tahakkukta bos). */
  funds: FundsMovement[];
  /** Pozitif: kasa/bankaya net giris, negatif: cikis, 0: nakit etkisi yok. */
  netFundsChange: number;
  unitId?: string;
  unitNumber?: string;
  liableParty?: LiableParty;
  reference?: string;
  reversalOf?: string;
  reason?: string;
  batchId?: string;
  createdAt: string;
  createdBy: string;
};

const isFunds = (a: Account | undefined): a is Account & { type: 'cash' | 'bank' } =>
  a?.type === 'cash' || a?.type === 'bank';

export function toTransactionView(
  tx: Transaction,
  accounts: Map<string, Account>,
  unitNumbers: Map<string, string>,
): TransactionView {
  const funds: FundsMovement[] = [];
  for (const line of tx.lines) {
    const acc = accounts.get(line.accountId);
    if (!isFunds(acc)) continue;
    funds.push({
      accountId: acc.accountId,
      accountName: acc.name,
      accountType: acc.type,
      direction: line.side === 'debit' ? 'in' : 'out',
      amount: line.amount,
    });
  }
  const netFundsChange = funds.reduce((s, f) => s + (f.direction === 'in' ? f.amount : -f.amount), 0);

  let category: TransactionCategory;
  if (tx.kind === 'reversal') category = 'reversal';
  else if (funds.some((f) => f.direction === 'in') && funds.some((f) => f.direction === 'out')) category = 'transfer';
  else if (netFundsChange > 0) category = 'income';
  else if (netFundsChange < 0) category = 'expense';
  else category = 'accrual';

  const unitLine = tx.lines.find((l) => l.unitId);
  return {
    transactionId: tx.transactionId,
    date: tx.date,
    dueDate: tx.dueDate,
    description: tx.description,
    kind: tx.kind,
    category,
    amount: tx.totalAmount,
    funds,
    netFundsChange,
    unitId: unitLine?.unitId,
    unitNumber: unitLine?.unitId ? unitNumbers.get(unitLine.unitId) : undefined,
    liableParty: unitLine?.liableParty,
    reference: tx.reference,
    reversalOf: tx.reversalOf,
    reason: tx.reason,
    batchId: tx.batchId,
    createdAt: tx.createdAt,
    createdBy: tx.createdBy,
  };
}

// ---------------------------------------------------------------------------
// Daire bazli aidat durumu
// ---------------------------------------------------------------------------

export type DuesStatus = 'paid' | 'pending' | 'overdue' | 'advance' | 'none';

export type PartyDues = {
  /** Toplam tahakkuk (borc satirlari). */
  charged: number;
  /** Toplam odeme/duzeltme (alacak satirlari). */
  paid: number;
  /** Bakiye: pozitif borc, negatif avans. */
  balance: number;
  /** Vadesi gecmis ve karsilanmamis tutar (FIFO: odemeler en eski borca sayilir). */
  overdue: number;
  /** En eski karsilanmamis vadenin tarihi. */
  oldestUnpaidDueDate?: IsoDate;
  /** Islemis ama henuz deftere yazilmamis kistelyevm gecikme tazminati (bugun itibariyla). */
  lateFee: number;
};

export type UnitDuesView = {
  unitId: string;
  unitNumber: string;
  blockId: string;
  owner: PartyDues;
  occupant: PartyDues;
  balance: number;
  overdue: number;
  /** Malik + sakin carilerinin islemis (deftere yazilmamis) gecikme tazminati. */
  lateFee: number;
  daysOverdue: number;
  status: DuesStatus;
  lastPaymentDate?: IsoDate;
};

/** `fee`: deftere yazilmis gecikme tazminati; mahsupta anaparadan SONRA gelir (karar 2a). */
type Charge = { amount: number; dueDate: IsoDate; fee?: boolean };

function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * FIFO: alacaklar (odeme, iptal) en eski vadeli borclardan baslayarak dusulur. Kalan
 * borclardan vadesi bugunden once olanlar gecikmis sayilir. Vadesiz borc satiri (ornegin bir
 * odemenin ters kaydi) islem tarihinde vadeli kabul edilir.
 */
export function computePartyDues(charges: Charge[], credits: number, today: IsoDate, lateFee = 0): PartyDues {
  const sorted = [...charges].sort((a, b) => Number(a.fee ?? false) - Number(b.fee ?? false) || a.dueDate.localeCompare(b.dueDate));
  const charged = sorted.reduce((s, c) => s + c.amount, 0);
  let remainingCredit = credits;
  let overdue = 0;
  let oldestUnpaidDueDate: IsoDate | undefined;
  for (const c of sorted) {
    const covered = Math.min(remainingCredit, c.amount);
    remainingCredit -= covered;
    const open = c.amount - covered;
    if (open <= 0) continue;
    oldestUnpaidDueDate ??= c.dueDate;
    if (c.dueDate < today) overdue += open;
  }
  return { charged, paid: credits, balance: charged - credits, overdue, oldestUnpaidDueDate, lateFee };
}

export function buildDuesStatus(
  units: Unit[],
  transactions: Transaction[],
  receivableIds: Set<string>,
  today: IsoDate,
  lateFeeBasisPoints = 0,
): UnitDuesView[] {
  type Acc = { charges: Charge[]; credits: number; feeCharges: FeeCharge[]; feeCredits: FeeCredit[]; postedFees: number };
  const empty = (): Acc => ({ charges: [], credits: 0, feeCharges: [], feeCredits: [], postedFees: 0 });
  const perUnit = new Map<string, { owner: Acc; occupant: Acc; lastPaymentDate?: IsoDate }>();
  const slot = (unitId: string) => {
    let s = perUnit.get(unitId);
    if (!s) {
      s = { owner: empty(), occupant: empty() };
      perUnit.set(unitId, s);
    }
    return s;
  };

  // Ters kayit ve iptal ettigi islem birlikte disarida birakilir: iptal edilen tahakkuk
  // "odeme" gibi en eski borca sayilmamali (FIFO'yu bozar), iptal edilen odeme de odeme degildir.
  const cancelled = cancelledTransactions(transactions);

  for (const tx of transactions) {
    if (cancelled.has(tx.transactionId)) continue;
    for (const line of tx.lines) {
      if (!line.unitId || !line.liableParty || !receivableIds.has(line.accountId)) continue;
      const s = slot(line.unitId);
      const party = s[line.liableParty];
      if (line.side === 'debit') {
        const dueDate = tx.dueDate ?? tx.date;
        party.charges.push({ amount: line.amount, dueDate, fee: tx.kind === 'late_fee' });
        if (tx.kind === 'dues_charge') party.feeCharges.push({ id: tx.transactionId, dueDate, amount: line.amount });
        if (tx.kind === 'late_fee') party.postedFees += line.amount;
      } else {
        party.credits += line.amount;
        party.feeCredits.push({ date: tx.date, amount: line.amount });
        if (tx.kind === 'payment' && (!s.lastPaymentDate || tx.date > s.lastPaymentDate)) s.lastPaymentDate = tx.date;
      }
    }
  }

  return units
    .filter((u) => u.status === 'active')
    .map((u) => {
      const s = perUnit.get(u.unitId) ?? { owner: empty(), occupant: empty() };
      const fee = (a: Acc) =>
        lateFeeBasisPoints > 0
          ? unpostedLateFee({ charges: a.feeCharges, credits: a.feeCredits, postedFees: a.postedFees }, lateFeeBasisPoints, today)
          : 0;
      const owner = computePartyDues(s.owner.charges, s.owner.credits, today, fee(s.owner));
      const occupant = computePartyDues(s.occupant.charges, s.occupant.credits, today, fee(s.occupant));
      const balance = owner.balance + occupant.balance;
      const overdue = owner.overdue + occupant.overdue;
      const oldest = [owner, occupant]
        .filter((p) => p.overdue > 0 && p.oldestUnpaidDueDate)
        .map((p) => p.oldestUnpaidDueDate as IsoDate)
        .sort()[0];
      const status: DuesStatus =
        owner.charged + occupant.charged === 0 && balance === 0
          ? 'none'
          : overdue > 0
            ? 'overdue'
            : balance > 0
              ? 'pending'
              : balance < 0
                ? 'advance'
                : 'paid';
      return {
        unitId: u.unitId,
        unitNumber: u.number,
        blockId: u.blockId,
        owner,
        occupant,
        balance,
        overdue,
        lateFee: owner.lateFee + occupant.lateFee,
        daysOverdue: oldest ? Math.max(daysBetween(oldest, today), 0) : 0,
        status,
        lastPaymentDate: s.lastPaymentDate,
      };
    });
}

// ---------------------------------------------------------------------------
// Ozet kartlari
// ---------------------------------------------------------------------------

export type FinanceSummary = {
  currency: 'TRY';
  cash: number;
  bank: number;
  /** Kasa + banka (likit varlik). */
  totalFunds: number;
  /** Sakinlerin toplam borcu (pozitif cari bakiyeler). */
  receivables: number;
  /** Sakinlerin avanslari (negatif cari bakiyeler, mutlak deger). */
  advances: number;
  /** Tedarikci borclari. */
  payables: number;
  overdue: number;
  /** Islemis, henuz deftere yazilmamis gecikme tazminati toplami. */
  accruedLateFees: number;
  overdueUnitCount: number;
  pendingUnitCount: number;
  fundsAccounts: { accountId: string; name: string; type: 'cash' | 'bank'; balance: number }[];
};

export function buildSummary(accounts: Account[], dues: UnitDuesView[]): FinanceSummary {
  const active = accounts.filter((a) => a.status === 'active' || a.balance !== 0);
  const sum = (type: Account['type']) => active.filter((a) => a.type === type).reduce((s, a) => s + a.balance, 0);
  const recv = accounts.filter((a) => a.type === 'receivable');
  const cash = sum('cash');
  const bank = sum('bank');
  return {
    currency: 'TRY',
    cash,
    bank,
    totalFunds: cash + bank,
    receivables: recv.reduce((s, a) => s + Math.max(a.balance, 0), 0),
    advances: recv.reduce((s, a) => s + Math.max(-a.balance, 0), 0),
    // Borc hesabinin normal tarafi alacak: bakiye (borc - alacak) negatiftir.
    payables: -sum('payable'),
    overdue: dues.reduce((s, d) => s + d.overdue, 0),
    accruedLateFees: dues.reduce((s, d) => s + d.lateFee, 0),
    overdueUnitCount: dues.filter((d) => d.status === 'overdue').length,
    pendingUnitCount: dues.filter((d) => d.status === 'pending').length,
    fundsAccounts: active
      .filter(isFunds)
      .map((a) => ({ accountId: a.accountId, name: a.name, type: a.type, balance: a.balance }))
      .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name, 'tr')),
  };
}

// ---------------------------------------------------------------------------
// Borc hatirlatmalari (zamanlanmis gorev)
// ---------------------------------------------------------------------------

export type DueReminderKind = 'upcoming' | 'overdue_1' | 'overdue_7';

export type DueReminder = {
  unitId: string;
  liableParty: LiableParty;
  kind: DueReminderKind;
  dueDate: IsoDate;
  /** O vadedeki acik (odenmemis) tutar. */
  amount: number;
};

const shiftDate = (d: IsoDate, days: number): IsoDate =>
  new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * `date` gunu gonderilecek hatirlatmalar: acik borcu olan alt carilerde vadesi 3 gun sonra
 * olan (upcoming), 1 gun once (overdue_1) ve 7 gun once (overdue_7) gecen kalemler.
 * Acik tutar ayni FIFO kuraliyla bulunur (anapara once, deftere yazilmis tazminat en son);
 * ayni vadeli kalemler toplanir. Iptal edilen islemler sayilmaz.
 */
export function buildDueReminders(transactions: Transaction[], receivableIds: Set<string>, date: IsoDate): DueReminder[] {
  const targets = new Map<IsoDate, DueReminderKind>([
    [shiftDate(date, 3), 'upcoming'],
    [shiftDate(date, -1), 'overdue_1'],
    [shiftDate(date, -7), 'overdue_7'],
  ]);
  const cancelled = cancelledTransactions(transactions);
  type Acc = { unitId: string; party: LiableParty; charges: Charge[]; credits: number };
  const perAccount = new Map<string, Acc>();

  for (const tx of transactions) {
    if (cancelled.has(tx.transactionId)) continue;
    for (const line of tx.lines) {
      if (!line.unitId || !line.liableParty || !receivableIds.has(line.accountId)) continue;
      let acc = perAccount.get(line.accountId);
      if (!acc) {
        acc = { unitId: line.unitId, party: line.liableParty, charges: [], credits: 0 };
        perAccount.set(line.accountId, acc);
      }
      if (line.side === 'debit') acc.charges.push({ amount: line.amount, dueDate: tx.dueDate ?? tx.date, fee: tx.kind === 'late_fee' });
      else acc.credits += line.amount;
    }
  }

  const out: DueReminder[] = [];
  for (const acc of [...perAccount.values()].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.party.localeCompare(b.party))) {
    const sorted = [...acc.charges].sort((a, b) => Number(a.fee ?? false) - Number(b.fee ?? false) || a.dueDate.localeCompare(b.dueDate));
    let credit = acc.credits;
    const byDue = new Map<IsoDate, number>();
    for (const c of sorted) {
      const covered = Math.min(credit, c.amount);
      credit -= covered;
      const open = c.amount - covered;
      if (open > 0 && targets.has(c.dueDate)) byDue.set(c.dueDate, (byDue.get(c.dueDate) ?? 0) + open);
    }
    for (const [dueDate, amount] of [...byDue.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      out.push({ unitId: acc.unitId, liableParty: acc.party, kind: targets.get(dueDate) as DueReminderKind, dueDate, amount });
    }
  }
  return out;
}
