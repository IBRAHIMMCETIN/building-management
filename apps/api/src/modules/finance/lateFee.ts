/**
 * Kistelyevm gecikme tazminati (KMK m.20) - saf hesaplama, kayan nokta yok.
 *
 * Kurallar (proje kararlari 1a / 2a):
 *  - Oran aylik baz puandir (500 = %5). Gunluk oran = aylik / 30; BASIT faiz, bilesik degil.
 *  - Her aidat kendi vadesinden itibaren ayri isler: vade gunu D olan borc D+1. gunden
 *    itibaren tazminat dogurur ((D, odeme gunu] araligi).
 *  - Tahsilatlar tarih sirasiyla en eski VADELI ANAPARAYA mahsup edilir (FIFO). Odenen kisim
 *    icin tazminat odeme gunu durur, kalan anapara uzerinden devam eder.
 *  - Tazminatin kendisine tazminat islemez: tazminat taban olarak yalnizca aidat tahakkuklari
 *    (`dues_charge`) alinir. Anaparayi asan tahsilat tazminat borcuna / avansa sayilir.
 *  - Tutarlar kurus tam sayidir; ara toplam BigInt "kurus x gun" olarak tutulur ve sonuc
 *    TEK SEFER yarim yukari yuvarlanir.
 *
 * Deftere yazim (1a): ekranda `toplam(bugun) - deftere yazilmis` "islemis tazminat" olarak
 * gosterilir; ayin 1'inde `toplam(onceki ay sonu) - deftere yazilmis` tek kayit yazilir.
 * Boylece kacirilan aylar veya sonradan girilen (geriye tarihli) tahsilatlar bir sonraki
 * kesinlestirmede kendiliginden dengelenir (eksi fark yazilmaz, sifirlanir).
 */
import type { IsoDate } from '../core/types.js';
import type { Transaction } from './types.js';

export type FeeCharge = { id: string; dueDate: IsoDate; amount: number };
export type FeeCredit = { date: IsoDate; amount: number };

export type LateFeeInput = {
  charges: readonly FeeCharge[];
  credits: readonly FeeCredit[];
  /** Aylik oran, baz puan (500 = %5). */
  monthlyBasisPoints: number;
  /** Hesap gunu (dahil): bu gune kadar islemis tazminat. */
  asOf: IsoDate;
};

export type LateFeeResult = {
  /** Kurus, yarim yukari yuvarlanmis. */
  fee: number;
  /** Sum(acik anapara x gecikme gunu), kurus-gun. */
  principalDays: bigint;
  /** `asOf` itibariyla vadesi gecmis, odenmemis anapara. */
  overduePrincipal: number;
};

const DAY_MS = 86_400_000;
/** 30 gun x 10.000 baz puan. */
const DIVISOR = 300_000n;

export function dayNumber(d: IsoDate): number {
  return Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
}

/** n / d, yarim yukari (n >= 0). */
function roundHalfUp(n: bigint, d: bigint): bigint {
  return (n * 2n + d) / (d * 2n);
}

export function computeLateFee({ charges, credits, monthlyBasisPoints, asOf }: LateFeeInput): LateFeeResult {
  if (!Number.isInteger(monthlyBasisPoints) || monthlyBasisPoints < 0) throw new Error('Gecersiz oran');
  const end = dayNumber(asOf);

  const open = [...charges]
    .filter((c) => c.amount > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
    .map((c) => ({ due: dayNumber(c.dueDate), remaining: c.amount }));

  let principalDays = 0n;
  const accrue = (amount: number, due: number, closedOn: number) => {
    const days = Math.min(closedOn, end) - due;
    if (days > 0 && amount > 0) principalDays += BigInt(amount) * BigInt(days);
  };

  // Tahsilatlar tarih sirasiyla, en eski vadeden baslayarak anaparaya mahsup edilir.
  const sortedCredits = [...credits].filter((c) => c.amount > 0).sort((a, b) => a.date.localeCompare(b.date));
  let i = 0;
  for (const credit of sortedCredits) {
    let left = credit.amount;
    const paidOn = dayNumber(credit.date);
    while (left > 0 && i < open.length) {
      const c = open[i] as (typeof open)[number];
      const applied = Math.min(left, c.remaining);
      accrue(applied, c.due, paidOn);
      c.remaining -= applied;
      left -= applied;
      if (c.remaining === 0) i++;
    }
  }

  let overduePrincipal = 0;
  for (const c of open.slice(i)) {
    accrue(c.remaining, c.due, end);
    if (c.due < end) overduePrincipal += c.remaining;
  }

  const fee = monthlyBasisPoints === 0 ? 0n : roundHalfUp(principalDays * BigInt(monthlyBasisPoints), DIVISOR);
  return { fee: Number(fee), principalDays, overduePrincipal };
}

// ---------------------------------------------------------------------------
// Defterden girdi cikarma (bir alt cari hesabi icin)
// ---------------------------------------------------------------------------

export type AccountFeeLedger = {
  charges: FeeCharge[];
  credits: FeeCredit[];
  /** Deftere yazilmis (iptal edilmemis) gecikme tazminati toplami. */
  postedFees: number;
};

/** Ters kayitla iptal edilen islemler ve ters kayitlarin kendisi. */
export function cancelledTransactions(transactions: Iterable<Transaction>): Set<string> {
  const cancelled = new Set<string>();
  for (const tx of transactions) {
    if (tx.kind === 'reversal' && tx.reversalOf) {
      cancelled.add(tx.reversalOf);
      cancelled.add(tx.transactionId);
    }
  }
  return cancelled;
}

/**
 * Bir alacak (alt cari) hesabinin tazminat girdileri. Taban yalnizca aidat tahakkuklari;
 * alacak satirlari (tahsilat vb.) islem tarihinde mahsup edilir.
 */
export function feeLedgerFor(
  accountId: string,
  transactions: Iterable<Transaction>,
  cancelled: ReadonlySet<string> = cancelledTransactions(transactions),
): AccountFeeLedger {
  const out: AccountFeeLedger = { charges: [], credits: [], postedFees: 0 };
  for (const tx of transactions) {
    if (cancelled.has(tx.transactionId)) continue;
    for (const line of tx.lines) {
      if (line.accountId !== accountId) continue;
      if (line.side === 'debit') {
        if (tx.kind === 'dues_charge') out.charges.push({ id: tx.transactionId, dueDate: tx.dueDate ?? tx.date, amount: line.amount });
        else if (tx.kind === 'late_fee') out.postedFees += line.amount;
      } else {
        out.credits.push({ date: tx.date, amount: line.amount });
      }
    }
  }
  return out;
}

/** `asOf` itibariyla henuz deftere yazilmamis tazminat (negatif fark 0 sayilir). */
export function unpostedLateFee(ledger: AccountFeeLedger, monthlyBasisPoints: number, asOf: IsoDate): number {
  const { fee } = computeLateFee({ charges: ledger.charges, credits: ledger.credits, monthlyBasisPoints, asOf });
  return Math.max(fee - ledger.postedFees, 0);
}

// ---------------------------------------------------------------------------
// Donem yardimcilari (YYYY-MM)
// ---------------------------------------------------------------------------

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;

export function isPeriod(value: unknown): value is string {
  return typeof value === 'string' && PERIOD.test(value);
}

/** "2026-11" -> { first: "2026-11-01", last: "2026-11-30" } */
export function periodBounds(period: string): { first: IsoDate; last: IsoDate } {
  const m = PERIOD.exec(period);
  if (!m) throw new Error(`Gecersiz donem: ${period}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return { first: `${period}-01`, last: `${period}-${String(lastDay).padStart(2, '0')}` };
}

/** "2026-12" -> "2027-01" */
export function nextPeriod(period: string): string {
  const { last } = periodBounds(period);
  return new Date(Date.parse(`${last}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 7);
}

/** "2026-01" -> "2025-12" */
export function previousPeriod(period: string): string {
  const { first } = periodBounds(period);
  return new Date(Date.parse(`${first}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 7);
}

const MONTHS_TR = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

/** "2026-11" -> "Kasım 2026" */
export function periodLabel(period: string): string {
  const { first } = periodBounds(period);
  return `${MONTHS_TR[Number(first.slice(5, 7)) - 1]} ${first.slice(0, 4)}`;
}
