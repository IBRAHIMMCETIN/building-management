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
import { cancelledIn, feeInputsOf, linesOfAccount, readSubledger } from './subledger.js';
import type { Transaction } from './types.js';

/**
 * `accrueFrom`: tazminatin baslayacagi gun (dahil degil; vadeyle ayni anlam). Cari devrinde
 * hedefteki anapara icin devir tarihidir: o gune kadarki tazminat kaynakta kesinlestirildi.
 */
export type FeeCharge = {
  id: string;
  dueDate: IsoDate;
  amount: number;
  accrueFrom?: IsoDate;
  /**
   * Finans 2.2: tazminat tabani (yapilandirma kalemi; yoksa tutarin tamami). Kalem tutari
   * `amount`; odemeler once anapara payini (`feeBase`) kapatir, tazminat yalnizca kalan anapara
   * payina isler (taksitlendirilen tazminata tazminat islemez).
   */
  feeBase?: number;
};
export type FeeCredit = { date: IsoDate; amount: number };
/** Finans 2.2: kaleme bagli (hedefli) kapama; havuza girmez, o kalemi o gun kapatir. */
export type FeeSettlement = { chargeId: string; date: IsoDate; amount: number };

export type LateFeeInput = {
  charges: readonly FeeCharge[];
  credits: readonly FeeCredit[];
  /** Finans 2.2: hedefli kapamalar (yoksa davranis oncekiyle birebir ayni). */
  settlements?: readonly FeeSettlement[];
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

/**
 * P1-a: tazminatin `asOf`'tan bagimsiz zaman cizelgesi. Kurus-gun katkisi bir "segment" ile
 * ifade edilir: `amount` kurus, `start` gununden (haric) `end` gunune (dahil) kadar isler;
 * `end = null` hala acik (odenmemis) tazminat tabanidir. Olaylar (hedefli kapama, havuz) asOf'a
 * bakilmadan uygulanir - `computeLateFee` de oyle yapar - bu yuzden
 * `principalDays(asOf) = Sum(amount x max(0, min(end, asOf) - start))` her asOf icin birebir aynidir.
 */
export type FeeSegment = { amount: number; start: number; end: number | null };

export type LateFeeTimeline = {
  segments: FeeSegment[];
  /** Olaylardan sonra kalan acik kalemler (vade gunu + kalan tutar), vade sirasinda. */
  open: { due: number; remaining: number }[];
};

export function lateFeeTimeline({ charges, credits, settlements = [] }: Pick<LateFeeInput, 'charges' | 'credits' | 'settlements'>): LateFeeTimeline {
  const open = [...charges]
    .filter((c) => c.amount > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
    .map((c) => {
      const due = dayNumber(c.dueDate);
      const feeBase = Math.min(c.feeBase ?? c.amount, c.amount);
      // Tazminat vadeden (veya devir tarihinden, hangisi sonraysa) sonraki gunden itibaren isler.
      return {
        id: c.id,
        due,
        start: c.accrueFrom ? Math.max(due, dayNumber(c.accrueFrom)) : due,
        remaining: c.amount,
        // Odemeler once anapara payini kapatir: kalan tazminat tabani.
        bearing: feeBase,
      };
    });
  const byId = new Map(open.map((c) => [c.id, c]));

  const segments: FeeSegment[] = [];
  /** Kaleme `amount` uygulanir; tazminat tabanindan dusen kisim o gune kadar tazminat dogurur. */
  const apply = (c: (typeof open)[number], amount: number, day: number) => {
    const applied = Math.min(amount, c.remaining);
    const fromBearing = Math.min(applied, c.bearing);
    if (fromBearing > 0) segments.push({ amount: fromBearing, start: c.start, end: day });
    c.bearing -= fromBearing;
    c.remaining -= applied;
    return applied;
  };

  // Olaylar tarih sirasiyla: ayni gunde once hedefli kapamalar, sonra havuz (FIFO).
  type Ev = { day: number; order: number; amount: number; chargeId?: string };
  const events: Ev[] = [
    ...settlements.filter((st) => st.amount > 0).map((st) => ({ day: dayNumber(st.date), order: 0, amount: st.amount, chargeId: st.chargeId })),
    ...credits.filter((c) => c.amount > 0).map((c) => ({ day: dayNumber(c.date), order: 1, amount: c.amount })),
  ].sort((a, b) => a.day - b.day || a.order - b.order);

  for (const ev of events) {
    if (ev.chargeId !== undefined) {
      const c = byId.get(ev.chargeId);
      if (c) apply(c, ev.amount, ev.day);
      continue;
    }
    // Havuz: en eski vadeli acik anaparadan baslayarak.
    let left = ev.amount;
    for (const c of open) {
      if (left <= 0) break;
      if (c.remaining <= 0) continue;
      left -= apply(c, left, ev.day);
    }
  }

  const stillOpen: LateFeeTimeline['open'] = [];
  for (const c of open) {
    if (c.remaining <= 0) continue;
    if (c.bearing > 0) segments.push({ amount: c.bearing, start: c.start, end: null });
    stillOpen.push({ due: c.due, remaining: c.remaining });
  }
  return { segments, open: stillOpen };
}

/** Segmentlerin `end` gunune (dahil) kadar kurus-gun toplami. */
export function principalDaysAt(segments: readonly FeeSegment[], end: number): bigint {
  let total = 0n;
  for (const s of segments) {
    const days = Math.min(s.end ?? end, end) - s.start;
    if (days > 0 && s.amount > 0) total += BigInt(s.amount) * BigInt(days);
  }
  return total;
}

/** Kurus-gun -> kurus tazminat (TEK yuvarlama, yarim yukari). */
export function feeOfPrincipalDays(principalDays: bigint, monthlyBasisPoints: number): number {
  if (!Number.isInteger(monthlyBasisPoints) || monthlyBasisPoints < 0) throw new Error('Gecersiz oran');
  return monthlyBasisPoints === 0 ? 0 : Number(roundHalfUp(principalDays * BigInt(monthlyBasisPoints), DIVISOR));
}

export function computeLateFee({ charges, credits, settlements = [], monthlyBasisPoints, asOf }: LateFeeInput): LateFeeResult {
  if (!Number.isInteger(monthlyBasisPoints) || monthlyBasisPoints < 0) throw new Error('Gecersiz oran');
  const end = dayNumber(asOf);
  const timeline = lateFeeTimeline({ charges, credits, settlements });
  const principalDays = principalDaysAt(timeline.segments, end);
  let overduePrincipal = 0;
  for (const c of timeline.open) if (c.due < end) overduePrincipal += c.remaining;
  return { fee: feeOfPrincipalDays(principalDays, monthlyBasisPoints), principalDays, overduePrincipal };
}

// ---------------------------------------------------------------------------
// Defterden girdi cikarma (bir alt cari hesabi icin)
// ---------------------------------------------------------------------------

export type AccountFeeLedger = {
  charges: FeeCharge[];
  credits: FeeCredit[];
  /** Finans 2.2: hedefli kapamalar. */
  settlements?: FeeSettlement[];
  /** Deftere yazilmis (iptal edilmemis) gecikme tazminati toplami. */
  postedFees: number;
};

/** Ters kayitla iptal edilen islemler ve ters kayitlarin kendisi. */
export const cancelledTransactions = cancelledIn;

/**
 * Bir alacak (alt cari) hesabinin tazminat girdileri. Kurallar `subledger.ts`'te (tek kaynak):
 * taban aidat tahakkuklari, devir borclari ve devredilmis anapara kalemleri; alacak satirlari
 * islem tarihinde mahsup edilir; cari kapamadan onceki donem dikkate alinmaz.
 */
export function feeLedgerFor(
  accountId: string,
  transactions: Iterable<Transaction>,
  cancelled: ReadonlySet<string> = cancelledTransactions(transactions),
): AccountFeeLedger {
  return feeInputsOf(readSubledger(linesOfAccount(accountId, transactions), cancelled));
}

/** `asOf` itibariyla henuz deftere yazilmamis tazminat (negatif fark 0 sayilir). */
export function unpostedLateFee(ledger: AccountFeeLedger, monthlyBasisPoints: number, asOf: IsoDate): number {
  const { fee } = computeLateFee({ charges: ledger.charges, credits: ledger.credits, settlements: ledger.settlements ?? [], monthlyBasisPoints, asOf });
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
