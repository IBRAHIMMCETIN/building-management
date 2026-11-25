import { getTenantItem, queryTenantAll } from '../../config/dynamodb.js';
import { FISCAL_PERIOD_PREFIX, type FinanceLock, type FiscalPeriod, buildSnapshot, netByAccount, periodKeys, snapshotHash } from './periodLock.js';
import type { Kurus } from '../core/types.js';
import type { MeterLine, MeterPeriod } from '../meters/types.js';
import type { PaymentIntent } from '../payments/types.js';
import { type AccountRecon, reconcileAccount } from './bank/reconciliation.js';
import type { BankDecision, BankLine, BankStatement } from './bank/types.js';
import type { CariClosure } from './closures.js';
import { cancelledIn, linesOfAccount, readSubledger } from './subledger.js';
import { financeKeys } from './repository.js';
import type { Account, LedgerEntry, Payment, Transaction } from './types.js';
import { type CostSummary, EXPLINK_PREFIX, type ExpenseLinkRecord } from '../workcosts/types.js';

/**
 * Gecelik defter denetimi (`ledger_audit`).
 *
 * SALT OKUNUR: hicbir kayit duzeltilmez (append-only defter; duzeltme yalnizca insan kararli
 * ters kayitla). Sapmalar yapilandirilmis log + CloudWatch metrigi (`LedgerDrift`) + platform
 * alarmi olarak raporlanir; site yoneticisi arayuzune yansimaz.
 *
 * Kontroller:
 *  - tx_unbalanced            islem satirlarinda borc != alacak veya totalAmount uyusmuyor
 *  - tx_entries_mismatch      islem satirlari ile LE# kayitlari birebir degil
 *  - entry_orphan             LE# kaydinin islem basligi yok
 *  - entry_account_missing    LE# kaydinin hesabi yok
 *  - balance_mismatch         hesap `balance` != sum(LE#) (borc - alacak)
 *  - closed_period_write      kapama kilidinden (closedThrough) SONRA, kilitli doneme yazilmis kayit
 *  - closure_lock_missing     tamamlanmis kapamanin kaynak hesabinda kilit yok / geride
 *  - closure_lock_orphan      hesapta kilit var ama onu koyan tamamlanmis kapama yok
 *  - receipt_duplicate        ayni makbuz numarasi birden fazla tahsilatta
 *  - receipt_counter_behind   makbuz sayaci en buyuk makbuz numarasinin gerisinde
 *  - online_payment_unposted  SUCCEEDED odeme niyetinin tahsilat/islem kaydi eksik veya tutarsiz
 *  - bank_match_mismatch      (Faz B2) `matched` banka satirinin karar kaydi / dagilim toplami / bagli
 *                             tahsilat ve tazminat islemleri tutarsiz; geri alinan eslestirmenin islemleri
 *                             iptal edilmemis; (B3) gidere cevrilen satirin gider islemi yok/tutarsiz;
 *                             (B3.5) tedarikci odemesine cevrilen satirin islemi yok/tutarsiz
 *  - meter_period_mismatch    (Finans 2.3) onayli sayac doneminin satir toplami / tahakkuk toplami /
 *                             kalem sayisi fatura tutariyla uyusmuyor; geri alinmis donemde canli kalem var
 *  - meter_period_stuck       (Finans 2.3) donem `posting` / `reversing` ara durumunda 30 dakikadan uzun
 *  - ticket_cost_mismatch     (O1-4) talep / bakim gorevi masraf ozeti, aktif EXPLINK kilitleri ve defterle
 *                             uyusmuyor (masraf listesi, toplam, yansitma islemleri)
 *  - explink_orphan           (O1-4) aktif EXPLINK kilidinin isi yok / isi onu listelemiyor / islemi defterde yok
 *
 * Bulgu OLMAYAN rapor alanlari:
 *  - bankRecon  (Faz B3) banka hesabi basina son ekstre kapanis bakiyesi <-> defter bakiyesi;
 *               `unexplainedDiff` (bekleyen satirlarla aciklanamayan fark) `BankReconDiff`
 *               metrigi olarak yayinlanir. Defter tutarsizligi degil, mutabakat sinyalidir.
 *
 * Es zamanli yazimlar: okumalar tek anlik goruntu degildir. Yanlis alarmi onlemek icin
 * okuma sirasi bilincli secilir (niyet -> kapama -> islem -> LE# -> hesap -> tahsilat -> sayac)
 * ve bakiye/kilit/yetim kayit bulgulari raporlanmadan once tekil okumalarla YENIDEN dogrulanir
 * (bakiyede hesap surumu okuma boyunca degismemis olmali; degistiyse sonuc "kararsiz" sayilir).
 */

export const AUDIT_CODES = [
  'tx_unbalanced',
  'tx_entries_mismatch',
  'entry_orphan',
  'entry_account_missing',
  'balance_mismatch',
  'closed_period_write',
  'closure_lock_missing',
  'closure_lock_orphan',
  'receipt_duplicate',
  'receipt_counter_behind',
  'online_payment_unposted',
  'bank_match_mismatch',
  /** Finans 2.2: hedefli mahsup (settles) satirin tutarini asiyor ya da ayni caride olmayan/iptal edilmis kaleme isaret ediyor. */
  'settlement_invalid',
  /** Finans 2.3: sayac donemi tutar mutabakati. */
  'meter_period_mismatch',
  /** Finans 2.3: ara durumda takili kalan sayac donemi (onay / geri alma yarida). */
  'meter_period_stuck',
  /** Finans 2.4: kapali donemin snapshot'i bozuk ya da defterden yeniden hesaplananla uyusmuyor. */
  'fiscal_period_drift',
  /** Finans 2.4: kapanistan SONRA kapali doneme tarihli islem yazilmis (kilit asilmis). */
  'fiscal_closed_write',
  /** Finans 2.4: kilit kaydi kapanan donemlerle tutarsiz ya da kapanis yarida takili. */
  'fiscal_lock_mismatch',
  /** O1-4: is (talep / bakim gorevi) masraf ozeti kilitler veya defterle tutarsiz. */
  'ticket_cost_mismatch',
  /** O1-4: aktif masraf kilidinin isi yok ya da isi onu listelemiyor; islemi defterde yok. */
  'explink_orphan',
] as const;
export type AuditCode = (typeof AUDIT_CODES)[number];

export type AuditFinding = {
  code: AuditCode;
  accountId?: string;
  transactionId?: string;
  intentId?: string;
  closureId?: string;
  receiptNumber?: string;
  /** Faz B2: banka satiri. */
  lineId?: string;
  /** Finans 2.3: sayac donemi. */
  periodId?: string;
  /** O1-4: is (`ticket:<id>` / `maintenance:<id>`) ve masraf. */
  workRef?: string;
  expenseId?: string;
  expected?: number | string;
  actual?: number | string;
  detail?: string;
};

export type AuditSnapshot = {
  apartmentId: string;
  intents: PaymentIntent[];
  closures: CariClosure[];
  transactions: Transaction[];
  entries: LedgerEntry[];
  accounts: Account[];
  payments: Payment[];
  receiptCounter: number;
  /** Faz B2: banka satirlari ve eslestirme kararlari (eski kaynaklarda yok). */
  bankLines?: BankLine[];
  bankDecisions?: BankDecision[];
  /** Faz B3: banka ekstreleri (mutabakat metrigi). */
  bankStatements?: BankStatement[];
  /** Finans 2.3: sayac donemleri ve dagitim satirlari (eski kaynaklarda yok). */
  meterPeriods?: MeterPeriod[];
  meterLines?: MeterLine[];
  /** Finans 2.4: donem kilidi ve kapanan donemler (eski kaynaklarda yok). */
  financeLock?: FinanceLock;
  fiscalPeriods?: FiscalPeriod[];
  /** O1-4: masrafi olan isler ve masraf kilitleri (eski kaynaklarda yok). */
  workTargets?: WorkTargetSnapshot[];
  expenseLinks?: ExpenseLinkRecord[];
};

/** O1-4: talep / bakim gorevinin masraf ozeti (denetim icin). */
export type WorkTargetSnapshot = { ref: string; SK: string; version: number; costSummary?: CostSummary };

/** Borc pozitif, alacak negatif (repository `ADD #balance :delta` ile ayni isaret). */
const signed = (side: 'debit' | 'credit', amount: number) => (side === 'debit' ? amount : -amount);

const receiptNo = (r: string): number | undefined => {
  const m = /^MKB-(\d+)$/.exec(r);
  return m ? Number(m[1]) : undefined;
};

// ---------------------------------------------------------------------------
// Saf kontroller (anlik goruntu uzerinde)
// ---------------------------------------------------------------------------

export function checkTransactions(s: Pick<AuditSnapshot, 'transactions' | 'entries'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const byTx = new Map<string, LedgerEntry[]>();
  for (const e of s.entries) {
    const list = byTx.get(e.transactionId) ?? [];
    list.push(e);
    byTx.set(e.transactionId, list);
  }
  for (const tx of s.transactions) {
    let debit = 0;
    let credit = 0;
    for (const l of tx.lines) {
      if (l.side === 'debit') debit += l.amount;
      else credit += l.amount;
    }
    if (debit !== credit || tx.totalAmount !== debit) {
      out.push({ code: 'tx_unbalanced', transactionId: tx.transactionId, expected: debit, actual: credit, detail: `totalAmount=${tx.totalAmount}` });
    }
    // Satir i <-> LE kaydi lineNo i+1 (toLedgerEntries ile ayni eslesme).
    const entries = byTx.get(tx.transactionId) ?? [];
    const sig = (accountId: string, side: string, amount: number, lineNo: number) => `${lineNo}|${accountId}|${side}|${amount}`;
    const want = tx.lines.map((l, i) => sig(l.accountId, l.side, l.amount, i + 1)).sort();
    const have = entries.map((e) => sig(e.accountId, e.side, e.amount, e.lineNo)).sort();
    if (want.length !== have.length || want.some((w, i) => w !== have[i])) {
      out.push({ code: 'tx_entries_mismatch', transactionId: tx.transactionId, expected: want.length, actual: have.length });
    }
  }
  return out;
}

/**
 * Finans 2.2: hedefli mahsup tutarliligi. Canli (iptal edilmemis) bir alacak satirindaki `settles`
 * toplami satir tutarini asamaz; her hedef kalem ayni caride canli bir borc kalemi olmali ve bir
 * kaleme yapilan hedefli kapamalarin toplami kalem tutarini asmamalidir.
 */
export function checkSettlements(s: Pick<AuditSnapshot, 'transactions'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const cancelled = cancelledIn(s.transactions);
  const subs = new Map<string, { cutoff?: string; charges: Map<string, number> }>();
  const subOf = (accountId: string) => {
    let m = subs.get(accountId);
    if (!m) {
      const sub = readSubledger(linesOfAccount(accountId, s.transactions), cancelled);
      m = { ...(sub.cutoff ? { cutoff: sub.cutoff } : {}), charges: new Map(sub.charges.map((c) => [c.id, c.amount])) };
      subs.set(accountId, m);
    }
    return m;
  };
  const chargesOf = (accountId: string) => subOf(accountId).charges;
  const settledTotals = new Map<string, number>();
  for (const tx of s.transactions) {
    if (cancelled.has(tx.transactionId)) continue;
    for (const l of tx.lines) {
      if (!l.settles?.length) continue;
      const sum = l.settles.reduce((a, st) => a + st.amount, 0);
      if (l.side !== 'credit' || sum > l.amount || l.settles.some((st) => !Number.isInteger(st.amount) || st.amount <= 0)) {
        out.push({ code: 'settlement_invalid', transactionId: tx.transactionId, accountId: l.accountId, expected: l.amount, actual: sum, detail: 'settles_exceeds_line' });
        continue;
      }
      // Cari kapamayla devredilmis donem (kesim oncesi) bu hesapta artik hesaba katilmaz.
      const cut = subOf(l.accountId).cutoff;
      if (cut && tx.date <= cut) continue;
      const charges = chargesOf(l.accountId);
      for (const st of l.settles) {
        if (!charges.has(st.chargeId)) {
          out.push({ code: 'settlement_invalid', transactionId: tx.transactionId, accountId: l.accountId, detail: `unknown_charge:${st.chargeId}` });
          continue;
        }
        const k = `${l.accountId}|${st.chargeId}`;
        settledTotals.set(k, (settledTotals.get(k) ?? 0) + st.amount);
      }
    }
  }
  for (const [k, total] of settledTotals) {
    const [accountId, chargeId] = k.split('|') as [string, string];
    const amount = chargesOf(accountId).get(chargeId) ?? 0;
    if (total > amount) out.push({ code: 'settlement_invalid', accountId, expected: amount, actual: total, detail: `over_settled:${chargeId}` });
  }
  return out;
}

/** Ara durumda (posting / reversing) izin verilen en uzun sure. */
export const METER_PERIOD_STUCK_MINUTES = 30;

/**
 * Finans 2.3: sayac donemi mutabakati.
 *  - posted: dondurulmus satir toplami = fatura tutari; donemin tahakkuklari (referans
 *    `METER_PERIOD:<id>`, iptal edilmis olsun olmasin - es zamanli geri almada yanlis alarm olmasin)
 *    toplami = fatura tutari; kalem sayisi = `chargeCount`; her satirin islemi defterde.
 *  - reversed: donemin canli (ters kaydedilmemis) tahakkuku kalmamali.
 *  - posting / reversing: `updatedAt` uzerinden 30 dakikadan uzun sure -> takili.
 */
export function checkMeterPeriods(s: Pick<AuditSnapshot, 'transactions' | 'meterPeriods' | 'meterLines'>, now: Date): AuditFinding[] {
  const periods = (s.meterPeriods ?? []).filter((p) => p.entityType === 'METER_PERIOD');
  if (periods.length === 0) return [];
  const out: AuditFinding[] = [];
  const cancelled = cancelledIn(s.transactions);
  const charges = new Map<string, Transaction[]>();
  for (const t of s.transactions) {
    if (t.kind !== 'dues_charge' || !t.reference?.startsWith('METER_PERIOD:')) continue;
    const id = t.reference.slice('METER_PERIOD:'.length);
    charges.set(id, [...(charges.get(id) ?? []), t]);
  }
  const lines = (s.meterLines ?? []).filter((l) => l.entityType === 'METER_LINE');
  const fail = (p: MeterPeriod, detail: string, extra: Partial<AuditFinding> = {}) => out.push({ code: 'meter_period_mismatch', periodId: p.periodId, detail, ...extra });

  for (const p of periods) {
    const list = charges.get(p.periodId) ?? [];
    if (p.status === 'posting' || p.status === 'reversing') {
      const ageMin = (now.getTime() - Date.parse(p.updatedAt)) / 60_000;
      if (ageMin > METER_PERIOD_STUCK_MINUTES) {
        out.push({ code: 'meter_period_stuck', periodId: p.periodId, actual: p.updatedAt, detail: `${p.status} ${Math.floor(ageMin)} dk` });
      }
      continue;
    }
    if (p.status === 'posted') {
      const expected = p.totalAmount ?? 0;
      const own = lines.filter((l) => l.periodId === p.periodId && l.calcHash === p.calc?.hash);
      const lineSum = own.reduce((sum, l) => sum + l.amount, 0);
      if (lineSum !== expected) fail(p, 'satir toplami fatura tutarina esit degil', { expected, actual: lineSum });
      const chargeSum = list.reduce((sum, t) => sum + t.totalAmount, 0);
      if (chargeSum !== expected) fail(p, 'tahakkuk toplami fatura tutarina esit degil', { expected, actual: chargeSum });
      if (p.chargeCount !== undefined && list.length !== p.chargeCount) fail(p, 'tahakkuk sayisi uyusmuyor', { expected: p.chargeCount, actual: list.length });
      const ids = new Set(list.map((t) => t.transactionId));
      for (const l of own) {
        if (l.transactionId && !ids.has(l.transactionId)) fail(p, `satirin islemi defterde yok (${l.unitId})`, { transactionId: l.transactionId });
      }
      continue;
    }
    if (p.status === 'reversed') {
      const live = list.filter((t) => !cancelled.has(t.transactionId));
      if (live.length) {
        fail(p, 'geri alinmis donemde ters kaydedilmemis tahakkuk var', { actual: live.reduce((sum, t) => sum + t.totalAmount, 0), transactionId: live[0]?.transactionId });
      }
    }
  }
  return out;
}

/**
 * O1-4: is masraflari. Ozet (`costSummary`), kilit (EXPLINK#) ve gider islemi ayni atomik yazimda
 * olustugundan birebir tutarli olmalidir. Ters kayit ozeti degistirmez (okuma aninda duser);
 * bu yuzden toplam, kilitlerin yazim anindaki tutarlariyla karsilastirilir.
 */
export function checkWorkCosts(s: Pick<AuditSnapshot, 'transactions' | 'workTargets' | 'expenseLinks'>): AuditFinding[] {
  const targets = s.workTargets ?? [];
  const links = (s.expenseLinks ?? []).filter((l) => l.entityType === 'EXPENSE_LINK');
  if (targets.length === 0 && links.length === 0) return [];
  const out: AuditFinding[] = [];
  const txs = new Map(s.transactions.map((t) => [t.transactionId, t]));
  const active = links.filter((l) => l.status === 'active');
  const byTarget = new Map<string, ExpenseLinkRecord[]>();
  for (const l of active) {
    const ref = `${l.target.type}:${l.target.id}`;
    byTarget.set(ref, [...(byTarget.get(ref) ?? []), l]);
  }
  const targetMap = new Map(targets.map((t) => [t.ref, t]));

  for (const t of targets) {
    const sum = t.costSummary;
    if (!sum) continue;
    const own = byTarget.get(t.ref) ?? [];
    const want = own.map((l) => l.expenseId).sort().join(',');
    const have = [...sum.expenseIds].sort().join(',');
    if (want !== have) out.push({ code: 'ticket_cost_mismatch', workRef: t.ref, expected: want, actual: have, detail: 'ozetteki masraflar aktif kilitlerle uyusmuyor' });
    const lockTotal = own.reduce((a, l) => a + l.amount, 0);
    const itemTotal = (sum.items ?? []).reduce((a, i) => a + i.amount, 0);
    if (sum.total !== lockTotal || sum.total !== itemTotal) {
      out.push({ code: 'ticket_cost_mismatch', workRef: t.ref, expected: lockTotal, actual: sum.total, detail: `toplam uyusmuyor (kalemler ${itemTotal})` });
    }
    for (const r of sum.recharges ?? []) {
      const tx = txs.get(r.transactionId);
      if (!tx || tx.kind !== 'dues_charge' || tx.totalAmount !== r.amount) {
        out.push({ code: 'ticket_cost_mismatch', workRef: t.ref, transactionId: r.transactionId, expected: r.amount, actual: tx?.totalAmount ?? 'yok', detail: 'yansitma islemi defterde yok / tutarsiz' });
      }
    }
  }

  for (const l of active) {
    const ref = `${l.target.type}:${l.target.id}`;
    const t = targetMap.get(ref);
    if (!t || !t.costSummary?.expenseIds.includes(l.expenseId)) {
      out.push({ code: 'explink_orphan', workRef: ref, expenseId: l.expenseId, detail: t ? 'is bu masrafi listelemiyor' : 'is bulunamadi' });
    }
    const tx = txs.get(l.transactionId);
    if (!tx || tx.totalAmount !== l.amount) {
      out.push({ code: 'explink_orphan', workRef: ref, expenseId: l.expenseId, transactionId: l.transactionId, expected: l.amount, actual: tx?.totalAmount ?? 'yok', detail: 'gider islemi defterde yok / tutarsiz' });
    }
  }
  return out;
}

/** Islem basligi anlik goruntude olmayan LE# kayitlari (yeniden dogrulanacak adaylar). */
export function orphanEntryCandidates(s: Pick<AuditSnapshot, 'transactions' | 'entries'>): string[] {
  const known = new Set(s.transactions.map((t) => t.transactionId));
  return [...new Set(s.entries.filter((e) => !known.has(e.transactionId)).map((e) => e.transactionId))].sort();
}

/** Hesap bazinda LE# net toplami. */
export function entryTotals(entries: readonly LedgerEntry[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const e of entries) totals.set(e.accountId, (totals.get(e.accountId) ?? 0) + signed(e.side, e.amount));
  return totals;
}

/** Bakiye adaylari: `balance` != sum(LE#). Hesabi olmayan kayitlar ayri bulgudur. */
export function balanceCandidates(s: Pick<AuditSnapshot, 'accounts' | 'entries'>): { mismatched: string[]; missingAccounts: AuditFinding[] } {
  const totals = entryTotals(s.entries);
  const accounts = new Map(s.accounts.map((a) => [a.accountId, a]));
  const mismatched: string[] = [];
  for (const a of s.accounts) if ((totals.get(a.accountId) ?? 0) !== a.balance) mismatched.push(a.accountId);
  const missingAccounts: AuditFinding[] = [];
  for (const [accountId, total] of totals) {
    if (!accounts.has(accountId)) missingAccounts.push({ code: 'entry_account_missing', accountId, actual: total });
  }
  return { mismatched: mismatched.sort(), missingAccounts };
}

/**
 * Kapama kilidi: hesap `closedThrough = D` ise, kilidi koyan kapamadan SONRA olusturulmus ve
 * tarihi <= D olan kayit, kilit ihlalidir. Kapama ve geri almanin kendi islemleri muaftir.
 */
export function checkClosures(s: Pick<AuditSnapshot, 'accounts' | 'closures' | 'entries'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const bySource = new Map<string, CariClosure[]>();
  for (const c of s.closures) {
    const list = bySource.get(c.sourceAccountId) ?? [];
    list.push(c);
    bySource.set(c.sourceAccountId, list);
  }
  const accounts = new Map(s.accounts.map((a) => [a.accountId, a]));

  for (const [accountId, closures] of bySource) {
    const acc = accounts.get(accountId);
    for (const c of closures) {
      if (c.status !== 'completed') continue;
      if (!acc?.closedThrough || acc.closedThrough < c.moveOutDate) {
        out.push({ code: 'closure_lock_missing', accountId, closureId: c.closureId, expected: c.moveOutDate, actual: acc?.closedThrough ?? '' });
      }
    }
  }

  for (const acc of s.accounts) {
    if (!acc.closedThrough) continue;
    const closures = bySource.get(acc.accountId) ?? [];
    const locking = closures
      .filter((c) => c.status === 'completed' && c.moveOutDate === acc.closedThrough)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (!locking) {
      out.push({ code: 'closure_lock_orphan', accountId: acc.accountId, actual: acc.closedThrough });
      continue;
    }
    const exempt = new Set<string>();
    for (const c of closures) {
      for (const id of Object.values(c.transactionIds)) if (id) exempt.add(id);
      for (const id of c.reversal?.transactionIds ?? []) exempt.add(id);
    }
    for (const e of s.entries) {
      if (e.accountId !== acc.accountId || exempt.has(e.transactionId)) continue;
      if (e.date <= acc.closedThrough && e.createdAt > locking.createdAt) {
        out.push({ code: 'closed_period_write', accountId: acc.accountId, transactionId: e.transactionId, closureId: locking.closureId, expected: `> ${acc.closedThrough}`, actual: e.date });
      }
    }
  }
  return out;
}

export function checkReceipts(s: Pick<AuditSnapshot, 'payments' | 'receiptCounter'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const seen = new Map<string, number>();
  let max = 0;
  for (const p of s.payments) {
    seen.set(p.receiptNumber, (seen.get(p.receiptNumber) ?? 0) + 1);
    max = Math.max(max, receiptNo(p.receiptNumber) ?? 0);
  }
  for (const [receiptNumber, n] of seen) if (n > 1) out.push({ code: 'receipt_duplicate', receiptNumber, actual: n });
  if (s.receiptCounter < max) out.push({ code: 'receipt_counter_behind', expected: max, actual: s.receiptCounter });
  return out;
}

/**
 * Tamamlanmis online odemeler: her odeme kaydi var, niyete bagli, tahsilat islemi defterde ve
 * saglayici referansini tasiyor; odeme tutarlari toplami niyet tutarina esit.
 */
export function checkOnlinePayments(s: Pick<AuditSnapshot, 'intents' | 'payments' | 'transactions'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const payments = new Map(s.payments.map((p) => [p.paymentId, p]));
  const txs = new Map(s.transactions.map((t) => [t.transactionId, t]));
  for (const intent of s.intents) {
    if (intent.status !== 'SUCCEEDED') continue;
    const fail = (detail: string, extra: Partial<AuditFinding> = {}) =>
      out.push({ code: 'online_payment_unposted', intentId: intent.intentId, detail, ...extra });
    const ids = intent.paymentIds ?? [];
    if (ids.length === 0) {
      fail('paymentIds yok');
      continue;
    }
    let total = 0;
    for (const id of ids) {
      const p = payments.get(id);
      if (!p) {
        fail('tahsilat kaydi yok', { detail: `tahsilat kaydi yok: ${id}` });
        continue;
      }
      total += p.amount;
      if (p.intentId !== intent.intentId) fail('tahsilat baska niyete bagli', { transactionId: p.transactionId });
      const tx = txs.get(p.transactionId);
      if (!tx) fail('tahsilat islemi defterde yok', { transactionId: p.transactionId });
      else if (intent.providerPaymentId && tx.reference !== `${intent.provider.toUpperCase()}:${intent.providerPaymentId}`) {
        fail('saglayici referansi uyusmuyor', { transactionId: p.transactionId, expected: `${intent.provider.toUpperCase()}:${intent.providerPaymentId}`, actual: tx.reference ?? '' });
      }
    }
    if (total !== intent.amount && ids.every((id) => payments.has(id))) {
      fail('tutar uyusmuyor', { expected: intent.amount, actual: total });
    }
    // Online Odeme v2 · P1: apartmanin komisyon gideri tahsilatla ayni yazimda olmali.
    const commission = intent.settlement?.commission ?? 0;
    if (commission > 0) {
      const ref = `ONLINE-FEE:${intent.intentId}`;
      const feeTx = (intent.transactionIds ?? []).map((id) => txs.get(id)).find((t) => t?.reference === ref);
      if (!feeTx) fail('komisyon gideri defterde yok', { expected: commission });
      else if (feeTx.totalAmount !== commission) {
        fail('komisyon gideri tutari uyusmuyor', { transactionId: feeTx.transactionId, expected: commission, actual: feeTx.totalAmount });
      }
    }
  }
  return out;
}

/**
 * Faz B2: banka eslestirmeleri. `matched` satirin son karari `match` olmali; dagilim toplami satir
 * tutarina esit; her dagilim icin banka hesabina borc / alt cariye alacak tahsilat islemi ve
 * (varsa) tazminat satiri defterde ve iptal edilmemis. Geri alinan (`unmatch`) eslestirmenin
 * islemleri ters kayitla iptal edilmis olmali.
 */
export function checkBankMatches(s: Pick<AuditSnapshot, 'transactions' | 'bankLines' | 'bankDecisions'>): AuditFinding[] {
  const out: AuditFinding[] = [];
  const lines = s.bankLines ?? [];
  const decisions = s.bankDecisions ?? [];
  if (lines.length === 0 && decisions.length === 0) return out;
  const txs = new Map(s.transactions.map((t) => [t.transactionId, t]));
  const cancelled = new Set(s.transactions.filter((t) => t.kind === 'reversal' && t.reversalOf).map((t) => t.reversalOf as string));
  const byKey = new Map(decisions.map((d) => [`${d.lineId}|${d.decisionNo}`, d]));
  const fail = (line: { lineId: string }, detail: string, extra: Partial<AuditFinding> = {}) =>
    out.push({ code: 'bank_match_mismatch', lineId: line.lineId, detail, ...extra });

  for (const line of lines) {
    if (line.status !== 'matched') {
      if (line.match) fail(line, `satir ${line.status} ama eslestirme bilgisi tasiyor`);
      continue;
    }
    const d = line.match ? byKey.get(`${line.lineId}|${line.match.decisionNo}`) : undefined;
    if (d?.kind === 'expense') {
      // B3: cikan satir -> gider (gider hesabi borc, banka alacak, satir tutari).
      const tx = d.transactionIds
        .map((id) => txs.get(id))
        .find(
          (t) =>
            t?.kind === 'expense' &&
            t.lines.some((l) => l.side === 'credit' && l.accountId === line.bankAccountId && l.amount === line.amount) &&
            t.lines.some((l) => l.side === 'debit' && l.accountId === d.expense?.expenseAccountId && l.amount === line.amount),
        );
      if (line.direction !== 'out') fail(line, 'giren satir gidere cevrilmis');
      if (!tx) fail(line, 'gider islemi defterde yok veya tutari uyusmuyor', { expected: line.amount });
      else if (cancelled.has(tx.transactionId)) fail(line, 'gider ters kayitla iptal edilmis ama satir eslesmis', { transactionId: tx.transactionId });
      continue;
    }
    if (d?.kind === 'payable') {
      // B3.5: cikan satir -> tedarikci odemesi (borc: tedarikci, alacak: banka, satir tutari).
      const tx = d.transactionIds
        .map((id) => txs.get(id))
        .find(
          (t) =>
            t?.kind === 'payable_payment' &&
            t.lines.some((l) => l.side === 'credit' && l.accountId === line.bankAccountId && l.amount === line.amount) &&
            t.lines.some((l) => l.side === 'debit' && l.accountId === d.payable?.payableAccountId && l.amount === line.amount),
        );
      if (line.direction !== 'out') fail(line, 'giren satir tedarikci odemesine cevrilmis');
      if (!tx) fail(line, 'tedarikci odemesi defterde yok veya tutari uyusmuyor', { expected: line.amount });
      else if (cancelled.has(tx.transactionId)) fail(line, 'tedarikci odemesi ters kayitla iptal edilmis ama satir eslesmis', { transactionId: tx.transactionId });
      continue;
    }
    if (!d || d.kind !== 'match') {
      fail(line, 'eslestirme karar kaydi yok');
      continue;
    }
    const allocations = d.allocations ?? [];
    const total = allocations.reduce((sum, a) => sum + a.amount, 0);
    if (total !== line.amount) fail(line, 'dagilim toplami satir tutarina esit degil', { expected: line.amount, actual: total });
    const used = new Set<string>();
    for (const a of allocations) {
      const tx = d.transactionIds
        .map((id) => txs.get(id))
        .find(
          (t) =>
            t &&
            !used.has(t.transactionId) &&
            t.kind === 'payment' &&
            t.lines.some((l) => l.side === 'debit' && l.accountId === line.bankAccountId && l.amount === a.amount) &&
            t.lines.some((l) => l.side === 'credit' && l.accountId === a.accountId && l.amount === a.amount),
        );
      if (!tx) {
        fail(line, 'tahsilat islemi defterde yok veya tutari uyusmuyor', { accountId: a.accountId, expected: a.amount });
        continue;
      }
      used.add(tx.transactionId);
      if (cancelled.has(tx.transactionId)) fail(line, 'tahsilat ters kayitla iptal edilmis ama satir eslesmis', { transactionId: tx.transactionId });
      if (a.lateFee > 0) {
        const fee = d.transactionIds
          .map((id) => txs.get(id))
          .find((t) => t?.kind === 'late_fee' && t.lines.some((l) => l.side === 'debit' && l.accountId === a.accountId && l.amount === a.lateFee));
        if (!fee) fail(line, 'kesinlestirilen tazminat defterde yok', { accountId: a.accountId, expected: a.lateFee });
        else if (cancelled.has(fee.transactionId)) fail(line, 'tazminat iptal edilmis ama satir eslesmis', { transactionId: fee.transactionId });
      }
    }
  }
  for (const d of decisions) {
    if (d.kind !== 'unmatch') continue;
    for (const id of d.reversedTransactionIds ?? []) {
      if (!cancelled.has(id)) fail(d, 'geri alinan eslestirmenin islemi iptal edilmemis', { transactionId: id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Veri kaynagi ve denetci
// ---------------------------------------------------------------------------

type AmountRow = { accountId: string; opening: number; debit: number; credit: number; closing: number };
const nonZero = (r: AmountRow) => r.opening !== 0 || r.debit !== 0 || r.credit !== 0 || r.closing !== 0;
const amountKey = (r: AmountRow) => `${r.accountId}|${r.opening}|${r.debit}|${r.credit}|${r.closing}`;
function amountsOf(rows: readonly AmountRow[]): string {
  return rows.filter(nonZero).map(amountKey).sort().join('\n');
}
function firstDifference(a: readonly AmountRow[], b: readonly AmountRow[]): string | undefined {
  const bm = new Map(b.filter(nonZero).map((r) => [r.accountId, amountKey(r)]));
  const am = new Map(a.filter(nonZero).map((r) => [r.accountId, amountKey(r)]));
  for (const id of new Set([...am.keys(), ...bm.keys()])) if (am.get(id) !== bm.get(id)) return id;
  return undefined;
}

/** Finans 2.4: yarida kalan kapanis bu sureden eskiyse bulgu. */
export const FISCAL_CLOSE_STUCK_MINUTES = 30;

/**
 * Finans 2.4: mali donem butunlugu (salt okunur).
 *  - Her kapali ayin snapshot'i defterden yeniden hesaplanir (acilis = onceki tum hareketler);
 *    ozet (`snapshotHash`, yalnizca tutarlar) saklananla ayni olmali. Saklanan satirlarin ozeti de
 *    kendi `hash`'ine esit olmali (kayit bozulmasi).
 *  - Kapanistan sonra olusturulmus, kapali aya tarihli islem: kilit asilmis demektir.
 *  - Kilit: son kapanan ay kapali olmali ve `lockedThrough` o ayin son gunu olmali; yarida kalan
 *    kapanis 30 dakikadan eskiyse takili sayilir.
 */
export function checkFiscalPeriods(s: Pick<AuditSnapshot, 'accounts' | 'transactions' | 'financeLock' | 'fiscalPeriods'>, now: Date): AuditFinding[] {
  const out: AuditFinding[] = [];
  const closed = (s.fiscalPeriods ?? []).filter((p) => p.status === 'closed').sort((a, b) => a.period.localeCompare(b.period));
  const lock = s.financeLock;
  if (lock?.lastClosedPeriod) {
    const last = closed.find((p) => p.period === lock.lastClosedPeriod);
    if (!last) out.push({ code: 'fiscal_lock_mismatch', periodId: lock.lastClosedPeriod, detail: 'last_closed_missing' });
    else if (!lock.closing && lock.lockedThrough !== last.periodEnd) {
      out.push({ code: 'fiscal_lock_mismatch', periodId: last.period, expected: last.periodEnd, actual: lock.lockedThrough ?? '', detail: 'locked_through' });
    }
  }
  if (lock?.closing && now.getTime() - Date.parse(lock.closing.startedAt) > FISCAL_CLOSE_STUCK_MINUTES * 60_000) {
    out.push({ code: 'fiscal_lock_mismatch', periodId: lock.closing.period, actual: lock.closing.startedAt, detail: 'close_stuck' });
  }
  if (!closed.length) return out;

  const txs = [...s.transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const p of closed) {
    if (snapshotHash(p.snapshot.rows) !== p.snapshot.hash) {
      out.push({ code: 'fiscal_period_drift', periodId: p.period, expected: p.snapshot.hash, detail: 'snapshot_corrupt' });
      continue;
    }
    const opening = netByAccount(txs.filter((t) => t.date < p.periodStart));
    const inPeriod = txs.filter((t) => t.date >= p.periodStart && t.date <= p.periodEnd);
    // Tutar karsilastirmasi: hesap ekleme, ad/kod degisikligi ve hareketsiz satirlar sonucu degistirmez.
    const rebuilt = buildSnapshot({ accounts: s.accounts, opening, periodTransactions: inPeriod });
    const want = amountsOf(p.snapshot.rows);
    const have = amountsOf(rebuilt.rows);
    if (want !== have) {
      const diff = firstDifference(p.snapshot.rows, rebuilt.rows);
      out.push({ code: 'fiscal_period_drift', periodId: p.period, ...(diff ? { accountId: diff } : {}), detail: 'ledger_changed' });
    }
    for (const t of inPeriod) {
      if (t.createdAt > p.closedAt) out.push({ code: 'fiscal_closed_write', periodId: p.period, transactionId: t.transactionId, expected: `<= ${p.closedAt}`, actual: t.createdAt });
    }
  }
  return out;
}

export type AuditSource = {
  /** Anlik goruntu; okuma sirasi snapshot alanlarinin sirasidir (bkz. modul aciklamasi). */
  load(apartmentId: string): Promise<AuditSnapshot>;
  getAccount(apartmentId: string, accountId: string): Promise<Account | undefined>;
  listAccountEntries(apartmentId: string, accountId: string): Promise<LedgerEntry[]>;
  getTransaction(apartmentId: string, transactionId: string): Promise<Transaction | undefined>;
  listClosures(apartmentId: string): Promise<CariClosure[]>;
  /** Faz B2: banka bulgusunu raporlamadan once satirin guncel halini okur (eski kaynaklarda yok). */
  getBankLine?(apartmentId: string, sk: string): Promise<BankLine | undefined>;
  /** O1-4: is / kilit belgesinin guncel surumu (bulguyu raporlamadan once). */
  getVersion?(apartmentId: string, sk: string): Promise<number | undefined>;
};

export function createDynamoAuditSource(): AuditSource {
  const all = <T>(apartmentId: string, prefix: string) => queryTenantAll<T>(apartmentId, prefix, { ConsistentRead: true });
  return {
    async load(apartmentId) {
      // Sira onemli: bir kaydi doguran yazim, ona bagli kayitlardan ONCE okunur.
      const intents = (await all<PaymentIntent>(apartmentId, 'PI#')).filter((i) => i.entityType === 'PAYMENT_INTENT');
      const closures = await all<CariClosure>(apartmentId, 'CLOSURE#');
      // Banka satiri ve karari, bagli islemlerle ayni atomik yazimdadir: islemlerden ONCE okunur.
      const bankStatements = (await all<BankStatement>(apartmentId, 'BANKSTMT#')).filter((x) => x.entityType === 'BANK_STATEMENT');
      const bankLines = (await all<BankLine>(apartmentId, 'BANKTX#')).filter((l) => l.entityType === 'BANK_LINE');
      const bankDecisions = (await all<BankDecision>(apartmentId, 'BANKMATCH#')).filter((d) => d.entityType === 'BANK_MATCH');
      // Finans 2.3: donem -> satirlar -> islemler (donem durumu bagli kayitlardan ONCE okunur).
      const meterPeriods = (await all<MeterPeriod>(apartmentId, 'MPERIOD#')).filter((p) => p.entityType === 'METER_PERIOD');
      const meterLines = (await all<MeterLine>(apartmentId, 'MDLINE#')).filter((l) => l.entityType === 'METER_LINE');
      // Finans 2.4: kilit ve donemler islemlerden ONCE (kapanis sonrasi yazimlar sonradan gorulur).
      const financeLock = await getTenantItem<FinanceLock>(periodKeys.lock(apartmentId));
      const fiscalPeriods = (await all<FiscalPeriod>(apartmentId, FISCAL_PERIOD_PREFIX)).filter((p) => p.entityType === 'FISCAL_PERIOD');
      // O1-4: is ozeti ve kilit gider islemiyle ayni atomik yazimda: islemlerden ONCE okunur.
      type WorkDoc = { SK: string; entityType?: string; version: number; costSummary?: CostSummary; ticketId?: string; taskId?: string };
      const tickets = (await all<WorkDoc>(apartmentId, 'TICKET#')).filter((t) => t.entityType === 'TICKET' && t.costSummary);
      const tasks = (await all<WorkDoc>(apartmentId, 'MTASK#')).filter((t) => t.entityType === 'MAINT_TASK' && t.costSummary);
      const workTargets: WorkTargetSnapshot[] = [
        ...tickets.map((t) => ({ ref: `ticket:${t.ticketId}`, SK: t.SK, version: t.version, costSummary: t.costSummary })),
        ...tasks.map((t) => ({ ref: `maintenance:${t.taskId}`, SK: t.SK, version: t.version, costSummary: t.costSummary })),
      ];
      const expenseLinks = (await all<ExpenseLinkRecord>(apartmentId, EXPLINK_PREFIX)).filter((l) => l.entityType === 'EXPENSE_LINK');
      const transactions = await all<Transaction>(apartmentId, 'TX#');
      const entries = await all<LedgerEntry>(apartmentId, 'LE#');
      const accounts = await all<Account>(apartmentId, 'ACCT#');
      const payments = await all<Payment>(apartmentId, 'PAY#');
      const counter = await getTenantItem<{ value?: number }>(financeKeys.counter(apartmentId, 'receipt'));
      return {
        apartmentId,
        intents,
        closures,
        transactions,
        entries,
        accounts,
        payments,
        receiptCounter: counter?.value ?? 0,
        bankLines,
        bankDecisions,
        bankStatements,
        meterPeriods,
        meterLines,
        ...(financeLock ? { financeLock } : {}),
        fiscalPeriods,
        workTargets,
        expenseLinks,
      };
    },
    getVersion: async (apartmentId, sk) => (await getTenantItem<{ version?: number }>({ PK: `APT#${apartmentId}`, SK: sk }))?.version,
    getAccount: (apartmentId, accountId) => getTenantItem<Account>(financeKeys.account(apartmentId, accountId)),
    listAccountEntries: (apartmentId, accountId) => all<LedgerEntry>(apartmentId, `LE#${accountId}#`),
    getTransaction: (apartmentId, transactionId) => getTenantItem<Transaction>(financeKeys.transaction(apartmentId, transactionId)),
    listClosures: (apartmentId) => all<CariClosure>(apartmentId, 'CLOSURE#'),
    getBankLine: (apartmentId, sk) => getTenantItem<BankLine>({ PK: `APT#${apartmentId}`, SK: sk }),
  };
}

export type AuditReport = {
  apartmentId: string;
  counts: { transactions: number; entries: number; accounts: number; payments: number; closures: number; intents: number };
  findings: AuditFinding[];
  /** Es zamanli yazim nedeniyle sonuca varilamayan bakiye kontrolleri (bulgu sayilmaz). */
  unstable: string[];
  /** Faz B3: kapanis bakiyeli ekstresi olan banka hesaplarinin mutabakati (bulgu degil; metrik). */
  bankRecon?: AccountRecon[];
};

/** Anlik goruntudeki her banka hesabi icin son ekstreye gore mutabakat. */
export function bankReconciliations(s: Pick<AuditSnapshot, 'accounts' | 'entries' | 'bankLines' | 'bankStatements'>): AccountRecon[] {
  const statements = s.bankStatements ?? [];
  if (statements.length === 0) return [];
  const out: AccountRecon[] = [];
  for (const a of s.accounts) {
    if (a.type !== 'bank') continue;
    const r = reconcileAccount({
      bankAccountId: a.accountId,
      statements,
      lines: (s.bankLines ?? []).filter((l) => l.bankAccountId === a.accountId),
      entries: s.entries,
    });
    if (r) out.push(r);
  }
  return out;
}

export function createLedgerAuditor(source: AuditSource, opts: { now?: () => Date } = {}) {
  const now = opts.now ?? (() => new Date());
  /** Bakiye: hesap -> LE# -> hesap; surum degismediyse karsilastir. */
  async function recheckBalance(apartmentId: string, accountId: string): Promise<AuditFinding | 'stable_ok' | 'unstable'> {
    const before = await source.getAccount(apartmentId, accountId);
    const entries = await source.listAccountEntries(apartmentId, accountId);
    const after = await source.getAccount(apartmentId, accountId);
    if (!before || !after || before.version !== after.version) return 'unstable';
    const total = entryTotals(entries).get(accountId) ?? 0;
    if (total === after.balance) return 'stable_ok';
    return { code: 'balance_mismatch', accountId, expected: total as Kurus, actual: after.balance, detail: `entries=${entries.length}` };
  }

  async function run(apartmentId: string): Promise<AuditReport> {
    const s = await source.load(apartmentId);
    const findings: AuditFinding[] = [];
    const unstable: string[] = [];

    findings.push(...checkTransactions(s));
    for (const transactionId of orphanEntryCandidates(s)) {
      if (!(await source.getTransaction(apartmentId, transactionId))) findings.push({ code: 'entry_orphan', transactionId });
    }

    const { mismatched, missingAccounts } = balanceCandidates(s);
    for (const f of missingAccounts) {
      // Hesap yeni olusturulmus olabilir: tekil okumayla dogrula.
      if (!(await source.getAccount(apartmentId, f.accountId as string))) findings.push(f);
    }
    for (const accountId of mismatched) {
      const r = await recheckBalance(apartmentId, accountId);
      if (r === 'unstable') unstable.push(accountId);
      else if (r !== 'stable_ok') findings.push(r);
    }

    // Kilit bulgulari: hesap ve kapama listesi yeniden okunup dogrulanir (kapama nadir).
    const closureFindings = checkClosures(s);
    if (closureFindings.some((f) => f.code !== 'closed_period_write')) {
      const closures = await source.listClosures(apartmentId);
      const ids = [...new Set(closureFindings.map((f) => f.accountId as string))];
      const accounts = (await Promise.all(ids.map((id) => source.getAccount(apartmentId, id)))).filter((a): a is Account => !!a);
      const confirmed = checkClosures({ accounts, closures, entries: s.entries });
      const key = (f: AuditFinding) => `${f.code}|${f.accountId}|${f.closureId ?? ''}|${f.transactionId ?? ''}`;
      const still = new Set(confirmed.map(key));
      findings.push(...closureFindings.filter((f) => f.code === 'closed_period_write' || still.has(key(f))));
    } else {
      findings.push(...closureFindings);
    }

    findings.push(...checkReceipts(s));
    findings.push(...checkOnlinePayments(s));
    findings.push(...checkSettlements(s));
    findings.push(...checkMeterPeriods(s, now()));
    findings.push(...checkFiscalPeriods(s, now()));

    // O1-4: is masraflari. Is ya da kilit okuma sirasinda degistiyse (es zamanli baglama) kararsiz.
    for (const f of checkWorkCosts(s)) {
      if (source.getVersion) {
        const target = s.workTargets?.find((t) => t.ref === f.workRef);
        const link = f.expenseId ? s.expenseLinks?.find((l) => l.expenseId === f.expenseId) : undefined;
        const docs = [target && { SK: target.SK, version: target.version }, link && { SK: link.SK, version: link.version }].filter((d): d is { SK: string; version: number } => !!d);
        let moved = false;
        for (const d of docs) if ((await source.getVersion(apartmentId, d.SK)) !== d.version) moved = true;
        if (moved) {
          unstable.push(`work:${f.workRef}`);
          continue;
        }
      }
      findings.push(f);
    }

    // Faz B2: banka eslestirmeleri. Satir okuma sirasinda degistiyse (es zamanli eslestirme / geri
    // alma) bulgu raporlanmaz, kararsiz sayilir.
    for (const f of checkBankMatches(s)) {
      const snap = s.bankLines?.find((l) => l.lineId === f.lineId);
      if (snap && source.getBankLine) {
        const now = await source.getBankLine(apartmentId, snap.SK);
        if (!now || now.version !== snap.version) {
          unstable.push(`bank:${f.lineId}`);
          continue;
        }
      }
      findings.push(f);
    }

    const bankRecon = s.bankStatements ? bankReconciliations(s) : undefined;
    return {
      apartmentId,
      counts: {
        transactions: s.transactions.length,
        entries: s.entries.length,
        accounts: s.accounts.length,
        payments: s.payments.length,
        closures: s.closures.length,
        intents: s.intents.length,
      },
      findings,
      unstable,
      ...(bankRecon ? { bankRecon } : {}),
    };
  }

  return { run };
}

export type LedgerAuditor = ReturnType<typeof createLedgerAuditor>;
