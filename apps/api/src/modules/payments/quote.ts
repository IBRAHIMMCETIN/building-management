/**
 * Odenebilir tutar hesabi (saf fonksiyonlar, I/O yok).
 *
 * Girdi, sakinin portalda gordugu alt cari satirlaridir (uyelik donemiyle sinirli). Mahsup
 * kurallari portal (`allocateOpenDues`) ve kistelyevm (`computeLateFee`) ile birebir aynidir:
 * tahsilat once anaparayi vade sirasiyla, en son deftere yazilmis tazminat kalemlerini kapatir.
 */
import { type IsoDate, type Kurus, type LiableParty, toKurus } from '../core/types.js';
import { ValidationError } from '../core/validation.js';
import { unpostedLateFee } from '../finance/lateFee.js';
import { cancelledIn, feeInputsOf, linesFromEntries, readSubledger } from '../finance/subledger.js';
import type { LedgerEntry, Transaction } from '../finance/types.js';
import { type OpenDue, allocateOpenDues } from '../portal/service.js';
import { type FeePolicy, ZERO_FEES, computeSplit } from './fees.js';
import type { IntentAllocation, PaymentMode } from './types.js';

export const receivableAccountId = (unitId: string, party: LiableParty) => `recv-${unitId}-${party}`;

export type PartyQuote = {
  liableParty: LiableParty;
  /** Pozitif = borc, negatif = avans. */
  balance: Kurus;
  debt: Kurus;
  advance: Kurus;
  /** Bugune kadar islemis, henuz deftere yazilmamis gecikme tazminati. */
  accruedLateFee: Kurus;
  /** "Toplam borc" odemesinde bu alt cariden tahsil edilecek: `debt + accruedLateFee`. */
  totalDue: Kurus;
  /** Secilebilir anapara kalemleri (FIFO sirasinda; yalnizca bastan kesintisiz secilebilir). */
  items: OpenDue[];
  /** Deftere yazilmis, acik gecikme tazminati kalemleri (yalnizca toplam odemede kapanir). */
  postedLateFees: OpenDue[];
};

export type PaymentQuote = {
  asOf: IsoDate;
  lateFeeMonthlyBasisPoints: number;
  parties: PartyQuote[];
  totalDue: Kurus;
};

export type PartyLedgerInput = { party: LiableParty; entries: LedgerEntry[] };

/**
 * Bir alt carinin kistelyevm girdileri (portal ozetiyle ayni kurallar, `finance/subledger.ts`):
 * taban aidat tahakkuku, devir borcu ve devredilmis anapara; alacak satirlari islem tarihinde
 * mahsup edilir; yazilmis tazminat ayri; cari kapamadan onceki donem dikkate alinmaz.
 */
export function feeInputsFromEntries(entries: readonly LedgerEntry[], txById: ReadonlyMap<string, Transaction>) {
  return feeInputsOf(readSubledger(linesFromEntries(entries, txById), cancelledIn(txById.values())));
}

/** `asOf` itibariyla deftere yazilmamis tazminat (oran 0 ise 0). */
export function accruedLateFeeOf(
  entries: readonly LedgerEntry[],
  txById: ReadonlyMap<string, Transaction>,
  monthlyBasisPoints: number,
  asOf: IsoDate,
): Kurus {
  if (monthlyBasisPoints <= 0) return toKurus(0);
  return toKurus(unpostedLateFee(feeInputsFromEntries(entries, txById), monthlyBasisPoints, asOf));
}

export function buildPartyQuote(
  input: PartyLedgerInput,
  txById: ReadonlyMap<string, Transaction>,
  today: IsoDate,
  monthlyBasisPoints: number,
): PartyQuote {
  const balance = input.entries.reduce((s, e) => s + (e.side === 'debit' ? e.amount : -e.amount), 0);
  const debt = Math.max(balance, 0);
  const accruedLateFee = accruedLateFeeOf(input.entries, txById, monthlyBasisPoints, today);
  const { open } = allocateOpenDues(input.party, input.entries, txById as Map<string, Transaction>, today);
  return {
    liableParty: input.party,
    balance: toKurus(balance),
    debt: toKurus(debt),
    advance: toKurus(Math.max(-balance, 0)),
    accruedLateFee,
    totalDue: toKurus(debt + accruedLateFee),
    items: open.filter((o) => !o.lateFee),
    postedLateFees: open.filter((o) => o.lateFee),
  };
}

export function buildQuote(input: {
  ledgers: readonly PartyLedgerInput[];
  txById: ReadonlyMap<string, Transaction>;
  today: IsoDate;
  lateFeeMonthlyBasisPoints: number;
}): PaymentQuote {
  const parties = input.ledgers.map((l) => buildPartyQuote(l, input.txById, input.today, input.lateFeeMonthlyBasisPoints));
  return {
    asOf: input.today,
    lateFeeMonthlyBasisPoints: input.lateFeeMonthlyBasisPoints,
    parties,
    totalDue: toKurus(parties.reduce((s, p) => s + p.totalDue, 0)),
  };
}

// ---------------------------------------------------------------------------
// Secim -> dagilim
// ---------------------------------------------------------------------------

export type PaymentSelection =
  | { mode: 'total' }
  | { mode: 'items'; items: readonly { liableParty: LiableParty; transactionId: string }[] };

/** Platform payi, yarim yukari yuvarlanmis (BigInt; kayan nokta yok). */
export function platformFeeOf(amount: number, basisPoints: number): number {
  if (basisPoints <= 0) return 0;
  return Number((BigInt(amount) * BigInt(basisPoints) * 2n + 10_000n) / 20_000n);
}

/**
 * Secimi alt cari basina dagilima cevirir.
 *  - total: borcu veya islemis tazminati olan her alt cari; tazminat kesinlestirilir.
 *  - items: alt cari basina, secilen kalemler FIFO sirasindaki ilk N acik anapara kalemi
 *    olmalidir (atlama yok). Tazminat tahsil edilmez (Karar A).
 */
export function allocateSelection(
  quote: PaymentQuote,
  selection: PaymentSelection,
  /** Komisyon politikasi (`fees.ts`); sayi verilirse yalnizca platform payi (baz puan). */
  fees: FeePolicy | number = ZERO_FEES,
): { mode: PaymentMode; allocations: IntentAllocation[]; amount: Kurus; platformFee: Kurus; posEstimate: Kurus } {
  const allocations: IntentAllocation[] = [];

  if (selection.mode === 'total') {
    for (const p of quote.parties) {
      if (p.totalDue <= 0) continue;
      allocations.push({
        liableParty: p.liableParty,
        principal: p.debt,
        lateFee: p.accruedLateFee,
        amount: p.totalDue,
        subMerchantPrice: p.totalDue,
        transactionIds: [],
      });
    }
  } else {
    if (selection.items.length === 0) throw new ValidationError('En az bir borç kalemi seçilmeli', 'items');
    const byParty = new Map<LiableParty, string[]>();
    for (const s of selection.items) {
      const list = byParty.get(s.liableParty) ?? [];
      if (list.includes(s.transactionId)) throw new ValidationError('Aynı borç kalemi iki kez seçilmiş', 'items');
      list.push(s.transactionId);
      byParty.set(s.liableParty, list);
    }
    for (const [party, ids] of byParty) {
      const pq = quote.parties.find((p) => p.liableParty === party);
      if (!pq) throw new ValidationError('Seçilen cari hesap size ait değil', 'items');
      const prefix = pq.items.slice(0, ids.length);
      const selected = new Set(ids);
      if (prefix.length !== ids.length || prefix.some((it) => !selected.has(it.transactionId))) {
        throw new ValidationError(
          'Borç kalemleri en eski vadeliden başlayarak, atlamadan seçilmelidir',
          'items',
        );
      }
      const principal = prefix.reduce((s, it) => s + it.remaining, 0);
      allocations.push({
        liableParty: party,
        principal: toKurus(principal),
        lateFee: toKurus(0),
        amount: toKurus(principal),
        subMerchantPrice: toKurus(principal),
        transactionIds: prefix.map((it) => it.transactionId),
      });
    }
  }

  allocations.sort((a, b) => a.liableParty.localeCompare(b.liableParty));
  const policy: FeePolicy = typeof fees === 'number' ? { ...ZERO_FEES, platformBasisPoints: fees } : fees;
  // Sakinin odedigi tutar degismez; komisyon apartmana aktarilacak tutardan dusulur (Karar A).
  const split = computeSplit(
    allocations.map((a) => a.amount),
    policy,
  );
  allocations.forEach((a, i) => {
    const s = split.items[i]!;
    a.subMerchantPrice = s.subMerchantPrice;
    a.platformFee = s.platformFee;
    a.posEstimate = s.posEstimate;
  });
  return {
    mode: selection.mode,
    allocations,
    amount: split.amount,
    platformFee: split.platformFee,
    posEstimate: split.posEstimate,
  };
}
