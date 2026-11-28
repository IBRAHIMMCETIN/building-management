/**
 * Finans raporlari (saf fonksiyonlar). Defter append-only oldugu icin raporlar islem
 * basliklarindan (Transaction.lines) ve hesap bakiyelerinden turetilir; hicbir sey yazmaz.
 * Tum tutarlar kurus cinsinden tam sayidir.
 */
import type { IsoDate, LiableParty, Unit } from '../core/types.js';
import {
  type CoreEntry,
  buildDueRemindersFromCores,
  buildDuesStatusFromCores,
  buildFormerAccountsFromCores,
  summarizeLines,
} from './accountSummary.js';
import { cancelledTransactions } from './lateFee.js';
import { type AccountLine, linesOfAccount } from './subledger.js';
import { type Account, type Transaction, isPrimaryReceivableId } from './types.js';

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
  /** Tahsilat: makbuz indirilebilir. */
  hasReceipt: boolean;
  /** Gidere bagli fatura dosyasi. */
  invoice?: { fileName: string };
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
  else if (tx.kind === 'opening_balance') category = 'accrual';
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
    hasReceipt: tx.kind === 'payment',
    invoice: tx.invoice ? { fileName: tx.invoice.fileName } : undefined,
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
  /**
   * Ayrilan sakin/malik carileri (tasinmada kapama ile acilan) toplami. Daire durumuna
   * (`status`, `balance`, `overdue`) dahil degildir; ayri takip edilir.
   */
  former?: PartyDues;
};

/** `fee`: deftere yazilmis gecikme tazminati; mahsupta anaparadan SONRA gelir (karar 2a). */
type Charge = { amount: number; dueDate: IsoDate; fee?: boolean };

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
  // Iptal edilen islem ve ters kaydi birlikte disarida birakilir; cari kapamadan onceki donem
  // dikkate alinmaz (kurallar subledger.ts'te tek yerde).
  const cancelled = cancelledTransactions(transactions);
  type Meta = { unitId: string; party: LiableParty; main: boolean };
  const meta = new Map<string, Meta>();
  const linesByAccount = new Map<string, AccountLine[]>();
  for (const tx of transactions) {
    for (const line of tx.lines) {
      if (!line.unitId || !line.liableParty || !receivableIds.has(line.accountId)) continue;
      if (!meta.has(line.accountId)) {
        meta.set(line.accountId, {
          unitId: line.unitId,
          party: line.liableParty,
          // Guncel cari: ana cari veya (`split` dairede) paydas alt carisi.
          main: isPrimaryReceivableId(line.accountId, line.unitId, line.liableParty),
        });
      }
      const list = linesByAccount.get(line.accountId) ?? [];
      list.push({ transaction: tx, side: line.side, amount: line.amount, date: tx.date, ...(line.settles ? { settles: line.settles } : {}) });
      linesByAccount.set(line.accountId, list);
    }
  }

  // P1-a: hesap ozeti uzerinden (servis, saklanan ozetlerle ayni kurucuyu kullanir).
  const entries: CoreEntry[] = [...linesByAccount].map(([accountId, lines]) => {
    const m = meta.get(accountId) as Meta;
    return { accountId, unitId: m.unitId, party: m.party, main: m.main, core: summarizeLines(lines, cancelled) };
  });
  return buildDuesStatusFromCores(units, entries, today, lateFeeBasisPoints);
}

// ---------------------------------------------------------------------------
// Ayrilan sakin / malik carileri (tasinmada kapama ile acilan)
// ---------------------------------------------------------------------------

export type FormerAccountView = {
  accountId: string;
  name: string;
  unitId: string;
  unitNumber?: string;
  blockId?: string;
  liableParty: LiableParty;
  closureId?: string;
  holder?: Account['holder'];
  /** Pozitif borc, negatif avans (hesap bakiyesi). */
  balance: number;
  debt: number;
  advance: number;
  overdue: number;
  oldestUnpaidDueDate?: IsoDate;
  daysOverdue: number;
  /** Islemis, deftere yazilmamis tazminat (bugun itibariyla). */
  lateFee: number;
  lastPaymentDate?: IsoDate;
};

/**
 * Ana cari olmayan (kapamayla acilmis) alacak hesaplari. Kurallar subledger.ts ile ayni;
 * varsayilan olarak yalnizca bakiyesi olanlar (`includeSettled` ile hepsi).
 */
export function buildFormerAccounts(
  accounts: Account[],
  units: Unit[],
  transactions: Transaction[],
  today: IsoDate,
  lateFeeBasisPoints = 0,
  includeSettled = false,
): FormerAccountView[] {
  const cancelled = cancelledTransactions(transactions);
  return buildFormerAccountsFromCores(
    accounts,
    units,
    (accountId) => summarizeLines(linesOfAccount(accountId, transactions), cancelled),
    today,
    lateFeeBasisPoints,
    includeSettled,
  );
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
  /** Sakinlerin toplam borcu (pozitif cari bakiyeler; ayrilan carileri de icerir). */
  receivables: number;
  /** Bunun ayrilan sakin/malik carilerindeki kismi (tasinmada devredilen borclar). */
  formerReceivables: number;
  /** Borcu olan ayrilan cari sayisi. */
  formerDebtorCount: number;
  /** Sakinlerin avanslari (negatif cari bakiyeler, mutlak deger). */
  advances: number;
  /** Tedarikci borclari. */
  payables: number;
  /** Tedarikcilere verilen, henuz faturayla mahsup edilmemis avanslar (sakin alacaklarina dahil degil). */
  supplierAdvances: number;
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
  // Tedarikci avans alt hesaplari (`supplierAdvanceOf`) sakin carisi degildir.
  const recv = accounts.filter((a) => a.type === 'receivable' && !a.supplierAdvanceOf);
  const supplierAdvances = accounts.filter((a) => a.type === 'receivable' && a.supplierAdvanceOf).reduce((s, a) => s + Math.max(a.balance, 0), 0);
  const formerRecv = recv.filter((a) => a.unitId && a.liableParty && !isPrimaryReceivableId(a.accountId, a.unitId, a.liableParty));
  const cash = sum('cash');
  const bank = sum('bank');
  return {
    currency: 'TRY',
    cash,
    bank,
    totalFunds: cash + bank,
    receivables: recv.reduce((s, a) => s + Math.max(a.balance, 0), 0),
    formerReceivables: formerRecv.reduce((s, a) => s + Math.max(a.balance, 0), 0),
    formerDebtorCount: formerRecv.filter((a) => a.balance > 0).length,
    advances: recv.reduce((s, a) => s + Math.max(-a.balance, 0), 0),
    // Borc hesabinin normal tarafi alacak: bakiye (borc - alacak) negatiftir.
    payables: -sum('payable'),
    supplierAdvances,
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
  /** Finans 2.1: paydas alt carisi; hatirlatma yalnizca bu paydasa gider. */
  userId?: string;
};

/**
 * `date` gunu gonderilecek hatirlatmalar: acik borcu olan alt carilerde vadesi 3 gun sonra
 * olan (upcoming), 1 gun once (overdue_1) ve 7 gun once (overdue_7) gecen kalemler.
 * Acik tutar ayni FIFO kuraliyla bulunur (anapara once, deftere yazilmis tazminat en son);
 * ayni vadeli kalemler toplanir. Iptal edilen islemler sayilmaz.
 */
export function buildDueReminders(
  transactions: Transaction[],
  receivableIds: Set<string>,
  date: IsoDate,
  /** Hesap -> paydas kullanici (paydas alt carileri, Finans 2.1). */
  holders: ReadonlyMap<string, string> = new Map(),
): DueReminder[] {
  const cancelled = cancelledTransactions(transactions);
  type Acc = { accountId: string; unitId: string; party: LiableParty; lines: AccountLine[] };
  const perAccount = new Map<string, Acc>();

  for (const tx of transactions) {
    for (const line of tx.lines) {
      if (!line.unitId || !line.liableParty || !receivableIds.has(line.accountId)) continue;
      let acc = perAccount.get(line.accountId);
      if (!acc) {
        acc = { accountId: line.accountId, unitId: line.unitId, party: line.liableParty, lines: [] };
        perAccount.set(line.accountId, acc);
      }
      // Finans 2.2: hedefli kapama (yapilandirma / mahsup) satirla birlikte tasinir.
      acc.lines.push({ transaction: tx, side: line.side, amount: line.amount, date: tx.date, ...(line.settles ? { settles: line.settles } : {}) });
    }
  }
  return buildDueRemindersFromCores(
    [...perAccount.values()].map((acc) => ({ accountId: acc.accountId, unitId: acc.unitId, party: acc.party, core: summarizeLines(acc.lines, cancelled) })),
    date,
    holders,
  );
}
