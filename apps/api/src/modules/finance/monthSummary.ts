/**
 * P1-c: acik (kapanmamis) aylarin hesap-ay hareket ozeti (`MSUM#<YYYY-MM>#<accountId>`).
 *
 * Her defter yazimi (`postBatch`: tahakkuk, tahsilat, gider, virman, ters kayit, mahsup, devir...)
 * satir yazdigi her (hesap, islem ayi) icin ozet kaydini hesap bakiyesiyle AYNI `TransactWriteItems`
 * icinde `ADD` ile gunceller (canli alanlar `d`, `c`, `p`). Ozet turetilmis bir sayactir (hesap
 * bakiyesi gibi); defter (TX/LE) degismez, silme yoktur.
 *
 *  - `d` / `c`: hesabin o ayki borc / alacak satir toplami (kurus).
 *  - `p`: o ayki `payment` turu islemlerin bu hesaba BORC satirlari (kasa/banka hesaplarinda
 *    tahsilat girisi; Genel Bakis "bu ay tahsilat").
 *  - `ld` / `lc` / `lp`: P1-c ONCESI yazilmis (`ms` isaretsiz) islemlerin ayni toplamlari; yalnizca
 *    backfill betigi `SET` eder (idempotent: dondurulmus kume, ayni deger). Toplam = canli + eski.
 *
 * Raporlar ozeti yalnizca site `MSUMSTATE.ready` iken kullanir (backfill dogrulanip isaretlenmis ya
 * da P1-c sonrasi acilmis site); aksi halde eski yol (donem islemleri) - sonuc ayni, yalnizca yavas.
 */
import type { IsoDate, TableKeys } from '../core/types.js';
import type { Transaction } from './types.js';

export type MonthSummaryItem = TableKeys & {
  entityType: 'MONTH_SUMMARY';
  siteId: string;
  accountId: string;
  /** YYYY-MM */
  month: string;
  d?: number;
  c?: number;
  p?: number;
  ld?: number;
  lc?: number;
  lp?: number;
  updatedAt?: string;
};

export type MonthSummaryState = TableKeys & {
  entityType: 'MONTH_SUMMARY_STATE';
  siteId: string;
  ready: boolean;
  /** `new_site`: P1-c sonrasi acilan site (eski islem yok); `backfill`: betikle dogrulandi. */
  source: 'new_site' | 'backfill';
  readyAt: string;
};

export type MonthDelta = { d: number; c: number; p: number };

/** Bir hesabin ayki toplam hareketi (canli + backfill). */
export function monthTotals(item: Pick<MonthSummaryItem, 'd' | 'c' | 'p' | 'ld' | 'lc' | 'lp'>): MonthDelta {
  return { d: (item.d ?? 0) + (item.ld ?? 0), c: (item.c ?? 0) + (item.lc ?? 0), p: (item.p ?? 0) + (item.lp ?? 0) };
}

export const monthOf = (date: IsoDate): string => date.slice(0, 7);
const key = (month: string, accountId: string) => `${month}|${accountId}`;

/** Islemlerden (hesap, ay) -> borc / alacak / tahsilat-girisi toplamlari. */
export function monthDeltas(transactions: Iterable<Transaction>): Map<string, MonthDelta & { month: string; accountId: string }> {
  const out = new Map<string, MonthDelta & { month: string; accountId: string }>();
  for (const tx of transactions) {
    const month = monthOf(tx.date);
    for (const l of tx.lines) {
      const k = key(month, l.accountId);
      const cur = out.get(k) ?? { month, accountId: l.accountId, d: 0, c: 0, p: 0 };
      if (l.side === 'debit') {
        cur.d += l.amount;
        if (tx.kind === 'payment') cur.p += l.amount;
      } else cur.c += l.amount;
      out.set(k, cur);
    }
  }
  return out;
}

export type MonthSummaryRepo = {
  listTransactions(apartmentId: string): Promise<{ items: Transaction[] }>;
  listMonthSummaries(apartmentId: string, fromMonth: string, toMonth?: string): Promise<MonthSummaryItem[]>;
  setLegacyMonthSummary(apartmentId: string, month: string, accountId: string, legacy: MonthDelta): Promise<void>;
  getMonthSummaryState(apartmentId: string): Promise<MonthSummaryState | undefined>;
  markMonthSummaryReady(apartmentId: string, source: MonthSummaryState['source'], opts?: { onlyIfAbsent?: boolean }): Promise<boolean>;
};

export type ReconcileResult = {
  transactions: number;
  /** Ozete hic sayilmamis (P1-c oncesi) islem. */
  legacyTransactions: number;
  /** `SET` edilen (hesap, ay) eski toplam kaydi. */
  legacyWritten: number;
  /** Dogrulama: ozet ile defter arasinda farkli olan (hesap, ay). */
  mismatches: { month: string; accountId: string; expected: MonthDelta; actual: MonthDelta }[];
  ready: boolean;
};

/**
 * Site icin eski islemleri ozete ekler (`apply`), sonra TUM defteri ozetle karsilastirir. Fark yoksa
 * (ve `apply`) site `ready` isaretlenir. Es zamanli yazim dogrulamayi yaniltabilir: yeniden okunarak
 * en fazla 3 kez denenir. `isCounted`: islemin canli sayildigi (varsayilan `ms === 1`).
 */
export async function reconcileMonthSummaries(
  repo: MonthSummaryRepo,
  apartmentId: string,
  opts: { mode: 'apply' | 'dry-run' | 'verify'; isCounted?: (tx: Transaction) => boolean },
): Promise<ReconcileResult> {
  const apply = opts.mode === 'apply';
  const counted = opts.isCounted ?? ((tx: Transaction) => tx.ms === 1);
  let result: ReconcileResult = { transactions: 0, legacyTransactions: 0, legacyWritten: 0, mismatches: [], ready: false };
  for (let attempt = 0; attempt < 3; attempt++) {
    const all = (await repo.listTransactions(apartmentId)).items.filter((t) => t.siteId === apartmentId);
    const legacy = all.filter((t) => !counted(t));
    let legacyWritten = 0;
    if (apply) {
      for (const v of monthDeltas(legacy).values()) {
        await repo.setLegacyMonthSummary(apartmentId, v.month, v.accountId, { d: v.d, c: v.c, p: v.p });
        legacyWritten++;
      }
    }
    const expected = monthDeltas(all);
    const stored = new Map<string, MonthDelta & { month: string; accountId: string }>();
    const dry = opts.mode === 'dry-run';
    for (const item of await repo.listMonthSummaries(apartmentId, '0000-01')) {
      if (item.siteId !== apartmentId) continue;
      // Dry-run: saklanan eski alanlar yerine "uygulansaydi" yazilacak eski toplamlar eklenir.
      const totals = dry ? { d: item.d ?? 0, c: item.c ?? 0, p: item.p ?? 0 } : monthTotals(item);
      stored.set(key(item.month, item.accountId), { month: item.month, accountId: item.accountId, ...totals });
    }
    if (dry) {
      for (const v of monthDeltas(legacy).values()) {
        const k = key(v.month, v.accountId);
        const cur = stored.get(k) ?? { month: v.month, accountId: v.accountId, d: 0, c: 0, p: 0 };
        stored.set(k, { ...cur, d: cur.d + v.d, c: cur.c + v.c, p: cur.p + v.p });
      }
    }
    const mismatches: ReconcileResult['mismatches'] = [];
    for (const k of new Set([...expected.keys(), ...stored.keys()])) {
      const e = expected.get(k);
      const a = stored.get(k);
      const ex = { d: e?.d ?? 0, c: e?.c ?? 0, p: e?.p ?? 0 };
      const ac = { d: a?.d ?? 0, c: a?.c ?? 0, p: a?.p ?? 0 };
      if (ex.d !== ac.d || ex.c !== ac.c || ex.p !== ac.p) {
        const [month, accountId] = k.split('|') as [string, string];
        mismatches.push({ month, accountId, expected: ex, actual: ac });
      }
    }
    result = { transactions: all.length, legacyTransactions: legacy.length, legacyWritten, mismatches, ready: false };
    if (mismatches.length === 0) break;
  }
  if (apply && result.mismatches.length === 0) {
    await repo.markMonthSummaryReady(apartmentId, 'backfill');
    result.ready = true;
  }
  return result;
}
