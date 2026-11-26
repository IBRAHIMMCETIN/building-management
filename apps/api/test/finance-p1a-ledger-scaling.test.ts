/**
 * P1-a: finans defter okumalarinin olceklenmesi.
 *
 *  1. Kistelyevm zaman cizelgesi (`lateFeeTimeline`) refaktor oncesi `computeLateFee` ile her asOf
 *     icin birebir ayni (eski algoritmanin bire bir kopyasina karsi rastgele girdiler).
 *  2. Alt cari ozeti (`summarizeLines` + ufuk katlama) eski formullerle (allocate + unpostedLateFee)
 *     birebir ayni (rastgele defterler: kismi odeme, ters kayit, hedefli kapama, tazminat).
 *  3. 1.200 bagimsiz bolum x 24 ay (~55 bin defter islemi): Genel Bakis / dues-status / ozet /
 *     tazminat kesinlestirmesi / hatirlatma TAM DEFTER TARAMASI yapmaz, okunan satir sayisi
 *     degisen hesaplarla sinirlidir ve sonuclar eski tam-defter hesabiyla birebir aynidir.
 *  4. Donem kapanisi: onceki ay kapaliysa acilis anlik goruntuden; gecmis aylar okunmaz.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type IsoDate, type LiableParty, type Unit, toKurus } from '../src/modules/core/types.js';
import { feeAt, partyDuesOf, summarizeLines, unpostedFeeOf } from '../src/modules/finance/accountSummary.js';
import {
  type FeeCharge,
  type FeeCredit,
  type FeeSettlement,
  computeLateFee,
  dayNumber,
  feeLedgerFor,
  lateFeeTimeline,
  principalDaysAt,
  unpostedLateFee,
} from '../src/modules/finance/lateFee.js';
import { buildSnapshot, netByAccount } from '../src/modules/finance/periodLock.js';
import { type PeriodCheckSources, createPeriodService } from '../src/modules/finance/periods.js';
import { buildDueReminders, buildDuesStatus, buildSummary } from '../src/modules/finance/reports.js';
import type { FinanceRepository, TransactionQuery } from '../src/modules/finance/repository.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import { type AccountLine, allocate, feeInputsOf, linesOfAccount, readSubledger } from '../src/modules/finance/subledger.js';
import { type Account, type LedgerEntry, type Transaction, type TransactionKind, type TransactionLine, isPrimaryReceivableId, mainReceivableId } from '../src/modules/finance/types.js';
import { backfillFinanceSummary } from '../scripts/backfill-finance-summary.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';

const APT = 'apt-1';
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };

/** Deterministik PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)] as T };
}

const addDays = (d: IsoDate, n: number): IsoDate => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// 1. Zaman cizelgesi == refaktor oncesi computeLateFee
// ---------------------------------------------------------------------------

/** Refaktor ONCESI `computeLateFee` (lateFee.ts, Finans 2.2) - bire bir kopya, yalnizca test icin. */
function legacyComputeFee(charges: readonly FeeCharge[], credits: readonly FeeCredit[], settlements: readonly FeeSettlement[], bps: number, asOf: IsoDate): number {
  const end = dayNumber(asOf);
  const open = [...charges]
    .filter((c) => c.amount > 0)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.id.localeCompare(b.id))
    .map((c) => {
      const due = dayNumber(c.dueDate);
      const feeBase = Math.min(c.feeBase ?? c.amount, c.amount);
      return { id: c.id, due, start: c.accrueFrom ? Math.max(due, dayNumber(c.accrueFrom)) : due, remaining: c.amount, bearing: feeBase };
    });
  const byId = new Map(open.map((c) => [c.id, c]));
  let principalDays = 0n;
  const accrue = (amount: number, start: number, closedOn: number) => {
    const days = Math.min(closedOn, end) - start;
    if (days > 0 && amount > 0) principalDays += BigInt(amount) * BigInt(days);
  };
  const apply = (c: (typeof open)[number], amount: number, day: number) => {
    const applied = Math.min(amount, c.remaining);
    const fromBearing = Math.min(applied, c.bearing);
    accrue(fromBearing, c.start, day);
    c.bearing -= fromBearing;
    c.remaining -= applied;
    return applied;
  };
  const events = [
    ...settlements.filter((st) => st.amount > 0).map((st) => ({ day: dayNumber(st.date), order: 0, amount: st.amount, chargeId: st.chargeId as string | undefined })),
    ...credits.filter((c) => c.amount > 0).map((c) => ({ day: dayNumber(c.date), order: 1, amount: c.amount, chargeId: undefined as string | undefined })),
  ].sort((a, b) => a.day - b.day || a.order - b.order);
  for (const ev of events) {
    if (ev.chargeId !== undefined) {
      const c = byId.get(ev.chargeId);
      if (c) apply(c, ev.amount, ev.day);
      continue;
    }
    let left = ev.amount;
    for (const c of open) {
      if (left <= 0) break;
      if (c.remaining <= 0) continue;
      left -= apply(c, left, ev.day);
    }
  }
  for (const c of open) {
    if (c.remaining <= 0) continue;
    accrue(c.bearing, c.start, end);
  }
  const d = 300_000n;
  const n = principalDays * BigInt(bps);
  return bps === 0 ? 0 : Number((n * 2n + d) / (d * 2n));
}

describe('kistelyevm zaman cizelgesi', () => {
  it('her asOf icin refaktor oncesi algoritmayla birebir ayni (1.500 rastgele senaryo)', () => {
    const r = rng(42);
    const base = '2024-01-01';
    for (let k = 0; k < 1500; k++) {
      const charges: FeeCharge[] = Array.from({ length: r.int(0, 8) }, (_, i) => {
        const amount = r.int(0, 300_000);
        return {
          id: `c${i}`,
          dueDate: addDays(base, r.int(0, 700)),
          amount,
          ...(r.next() < 0.2 ? { accrueFrom: addDays(base, r.int(0, 700)) } : {}),
          ...(r.next() < 0.2 ? { feeBase: r.int(0, amount) } : {}),
        };
      });
      const credits: FeeCredit[] = Array.from({ length: r.int(0, 8) }, () => ({ date: addDays(base, r.int(0, 800)), amount: r.int(0, 400_000) }));
      const settlements: FeeSettlement[] = charges.length
        ? Array.from({ length: r.int(0, 3) }, () => ({ chargeId: r.pick(charges).id, date: addDays(base, r.int(0, 800)), amount: r.int(0, 200_000) }))
        : [];
      const timeline = lateFeeTimeline({ charges, credits, settlements });
      for (let j = 0; j < 4; j++) {
        const asOf = addDays(base, r.int(-30, 900));
        const bps = r.pick([0, 1, 300, 500, 1000]);
        const expected = legacyComputeFee(charges, credits, settlements, bps, asOf);
        expect(computeLateFee({ charges, credits, settlements, monthlyBasisPoints: bps, asOf }).fee).toBe(expected);
        // Cizelge asOf'tan bagimsiz: ayni cizelge her asOf'u dogru verir.
        const pd = principalDaysAt(timeline.segments, dayNumber(asOf));
        expect(bps === 0 ? 0 : Number((pd * BigInt(bps) * 2n + 300_000n) / 600_000n)).toBe(expected);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Alt cari ozeti == eski formuller (allocate + unpostedLateFee)
// ---------------------------------------------------------------------------

let seq = 0;
function tx(kind: TransactionKind, date: IsoDate, lines: TransactionLine[], extra: Partial<Transaction> = {}): Transaction {
  const id = `${date.replaceAll('-', '')}-${String(++seq).padStart(8, '0')}`;
  return {
    PK: `APT#${APT}`,
    SK: `TX#${id}`,
    entityType: 'TRANSACTION',
    transactionId: id,
    siteId: APT,
    kind,
    date,
    description: kind,
    lines,
    totalAmount: toKurus(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
    createdAt: `${date}T08:00:00.000Z`,
    createdBy: 'seed',
    ...extra,
  };
}
const recvLine = (accountId: string, unitId: string, party: LiableParty, side: 'debit' | 'credit', amount: number, settles?: { chargeId: string; amount: number }[]): TransactionLine => ({
  accountId,
  side,
  amount: toKurus(amount),
  unitId,
  liableParty: party,
  ...(settles ? { settles: settles.map((s) => ({ chargeId: s.chargeId, amount: toKurus(s.amount) })) } : {}),
});
const sys = (accountId: string, side: 'debit' | 'credit', amount: number): TransactionLine => ({ accountId, side, amount: toKurus(amount) });
const mirror = (t: Transaction, date: IsoDate) =>
  tx('reversal', date, t.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })), { reversalOf: t.transactionId });

/** Ozet oncesi rapor kodunun formulleri (reports.ts, Finans 2.2) - bagimsiz kahin. */
function legacyParty(lines: AccountLine[], today: IsoDate, bps: number) {
  const sub = readSubledger(lines);
  const { open } = allocate(sub, today);
  const overdueOpen = open.filter((c) => c.overdue);
  return {
    charged: sub.charges.filter((c) => c.txKind !== 'restructure').reduce((s, c) => s + c.amount, 0),
    paid: sub.credits.reduce((s, c) => s + c.amount, 0),
    balance: sub.balance,
    overdue: overdueOpen.reduce((s, c) => s + c.remaining, 0),
    ...(open[0] ? { oldestUnpaidDueDate: open[0].dueDate } : {}),
    lateFee: bps > 0 ? unpostedLateFee(feeInputsOf(sub), bps, today) : 0,
  };
}

describe('alt cari ozeti', () => {
  it('rastgele defterlerde eski formullerle birebir ayni; ufuk katlama sonucu degistirmez', () => {
    const r = rng(7);
    const acc = 'recv-u1-owner';
    for (let k = 0; k < 400; k++) {
      const txs: Transaction[] = [];
      const charges: Transaction[] = [];
      for (let m = 0; m < r.int(1, 30); m++) {
        const date = addDays('2024-01-01', r.int(0, 900));
        const roll = r.next();
        if (roll < 0.4) {
          const amt = r.int(1, 250_000);
          const t = tx(r.next() < 0.1 ? 'opening_balance' : 'dues_charge', date, [recvLine(acc, 'u1', 'owner', 'debit', amt), sys('income-dues', 'credit', amt)], { dueDate: addDays(date, r.int(0, 20)) });
          charges.push(t);
          txs.push(t);
        } else if (roll < 0.75) {
          const amt = r.int(1, 300_000);
          const settles = charges.length && r.next() < 0.15 ? [{ chargeId: r.pick(charges).transactionId, amount: r.int(1, amt) }] : undefined;
          txs.push(tx('payment', date, [sys('cash', 'debit', amt), recvLine(acc, 'u1', 'owner', 'credit', amt, settles)]));
        } else if (roll < 0.85) {
          const amt = r.int(1, 20_000);
          txs.push(tx('late_fee', date, [recvLine(acc, 'u1', 'owner', 'debit', amt), sys('income-late-fee', 'credit', amt)], { dueDate: addDays(date, 10) }));
        } else if (txs.length) {
          const target = r.pick(txs.filter((t) => t.kind !== 'reversal' && !txs.some((x) => x.reversalOf === t.transactionId)));
          if (target) txs.push(mirror(target, addDays(target.date, r.int(0, 60))));
        }
      }
      const lines = linesOfAccount(acc, txs);
      for (let j = 0; j < 3; j++) {
        const today = addDays('2024-01-01', r.int(0, 1100));
        const horizon = r.next() < 0.5 ? undefined : addDays(today, -r.int(0, 900));
        const bps = r.pick([0, 500, 1000]);
        const core = summarizeLines(lines, undefined, horizon);
        expect(partyDuesOf(core, today, bps)).toEqual(legacyParty(lines, today, bps));
        // Kesinlestirme (donem sonu) tutari ve "donem sonuna kadar yazilmis" varyanti.
        expect(unpostedFeeOf(core, bps, today)).toBe(bps > 0 ? unpostedLateFee(feeLedgerFor(acc, txs), bps, today) : 0);
        const asOfLater = addDays(today, r.int(0, 90));
        expect(feeAt(core, bps, asOfLater)).toBe(computeLateFee({ ...feeInputsOf(readSubledger(lines)), monthlyBasisPoints: bps, asOf: asOfLater }).fee);
      }
    }
  });

  it('ufuktan once sorgu programlama hatasi olarak reddedilir (sessizce yanlis sonuc yok)', () => {
    const core = summarizeLines([], undefined, '2026-01-01');
    expect(() => feeAt(core, 500, '2025-12-31')).toThrow(/ufku/);
  });
});

// ---------------------------------------------------------------------------
// 3. Buyuk site: tam defter taramasi yok, sonuclar birebir ayni
// ---------------------------------------------------------------------------

const UNITS = 1200;
const MONTHS = 24; // 2024-12 .. 2026-11
const TODAY = '2026-12-02';
const NOW = new Date(`${TODAY}T09:00:00.000Z`);

function unit(id: string): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: id.slice(1),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2024-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 1,
  } as Unit;
}

function account(accountId: string, unitId: string, party: LiableParty): Account {
  return {
    PK: `APT#${APT}`,
    SK: `ACCT#${accountId}`,
    entityType: 'ACCOUNT',
    accountId,
    siteId: APT,
    type: 'receivable',
    name: `Daire ${unitId} ${party}`,
    status: 'active',
    balance: toKurus(0),
    unitId,
    liableParty: party,
    createdAt: '2024-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2024-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 0,
  } as Account;
}

type Counts = { fullScans: number; rangedScans: number; txItems: number; entryQueries: number; entryItems: number; batchGetItems: number; accountsRefreshed: Set<string> };

/** Sayan sarmalayici + hesap satirlari icin dizinli okuyucu (sahte deponun dogrusal taramasi yerine). */
function instrument(fake: ReturnType<typeof createFakeFinanceRepo>) {
  const counts: Counts = { fullScans: 0, rangedScans: 0, txItems: 0, entryQueries: 0, entryItems: 0, batchGetItems: 0, accountsRefreshed: new Set() };
  let indexedAt = -1;
  let index = new Map<string, LedgerEntry[]>();
  const entriesOf = (accountId: string) => {
    if (indexedAt !== fake.transactions.size) {
      index = new Map();
      for (const t of [...fake.transactions.values()].sort((a, b) => a.transactionId.localeCompare(b.transactionId))) {
        t.lines.forEach((l, i) => {
          const list = index.get(l.accountId) ?? [];
          list.push({ PK: t.PK, SK: `LE#${l.accountId}#${t.transactionId}#${i + 1}`, entityType: 'LEDGER_ENTRY', entryId: `${t.transactionId}:${i + 1}`, transactionId: t.transactionId, siteId: t.siteId, accountId: l.accountId, side: l.side, amount: l.amount, date: t.date, lineNo: i + 1, createdAt: t.createdAt, createdBy: t.createdBy } as LedgerEntry);
          index.set(l.accountId, list);
        });
      }
      indexedAt = fake.transactions.size;
    }
    return index.get(accountId) ?? [];
  };
  const repo: FinanceRepository = {
    ...fake.repo,
    listTransactions: async (apt, q: TransactionQuery = {}) => {
      if (!q.from && !q.to && !q.limit && !q.cursor) counts.fullScans++;
      else counts.rangedScans++;
      const out = await fake.repo.listTransactions(apt, q);
      counts.txItems += out.items.length;
      return out;
    },
    listAccountEntries: async (_apt, accountId, range = {}) => {
      counts.entryQueries++;
      counts.accountsRefreshed.add(accountId);
      const out = entriesOf(accountId).filter((e) => e.date >= (range.from ?? '0000-00-00') && e.date <= (range.to ?? '9999-99-99'));
      counts.entryItems += out.length;
      return out;
    },
    getTransactions: async (apt, ids) => {
      counts.batchGetItems += ids.length;
      return fake.repo.getTransactions!(apt, ids);
    },
  };
  const reset = () => {
    counts.fullScans = 0;
    counts.rangedScans = 0;
    counts.txItems = 0;
    counts.entryQueries = 0;
    counts.entryItems = 0;
    counts.batchGetItems = 0;
    counts.accountsRefreshed = new Set();
  };
  return { repo, counts, reset };
}

describe(`buyuk site (${UNITS} bolum x ${MONTHS} ay)`, () => {
  const fake = createFakeFinanceRepo(APT);
  const io = instrument(fake);
  const units = Array.from({ length: UNITS }, (_, i) => unit(`u${i + 1}`));
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: io.repo, core, now: () => NOW, newId: () => `id${String(++n).padStart(6, '0')}` });
  const RATE = 500; // getSite yok: varsayilan %5
  const all = () => [...fake.transactions.values()].sort((a, b) => a.transactionId.localeCompare(b.transactionId));
  const receivableIds = () => new Set([...fake.accounts.values()].filter((a) => a.type === 'receivable').map((a) => a.accountId));
  const byNumber = <T extends { unitNumber: string }>(xs: T[]) => [...xs].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, 'tr', { numeric: true }));

  beforeAll(async () => {
    await finance.ensureSystemAccounts(ctx);
    const accounts: Account[] = [];
    for (const u of units) {
      accounts.push(account(mainReceivableId(u.unitId, 'owner'), u.unitId, 'owner'));
      if (Number(u.unitId.slice(1)) % 10 === 0) accounts.push(account(mainReceivableId(u.unitId, 'occupant'), u.unitId, 'occupant'));
    }
    await fake.repo.ensureAccounts(accounts);
    const post = (t: Transaction) => fake.repo.postBatch({ transactions: [t], idempotency: { id: `seed-${t.transactionId}`, fingerprint: 'seed' } });
    const r = rng(2026);
    for (let m = 0; m < MONTHS; m++) {
      const month = new Date(Date.UTC(2024, 11 + m, 1)).toISOString().slice(0, 7);
      for (const u of units) {
        const i = Number(u.unitId.slice(1));
        const acc = mainReceivableId(u.unitId, 'owner');
        const amount = 150_050 + (i % 7) * 100;
        await post(tx('dues_charge', `${month}-01`, [recvLine(acc, u.unitId, 'owner', 'debit', amount), sys('income-dues', 'credit', amount)], { dueDate: `${month}-10` }));
        if (i % 10 === 0) {
          const occ = mainReceivableId(u.unitId, 'occupant');
          await post(tx('dues_charge', `${month}-01`, [recvLine(occ, u.unitId, 'occupant', 'debit', 42_000), sys('income-dues', 'credit', 42_000)], { dueDate: `${month}-15` }));
          if (r.next() < 0.7) await post(tx('payment', `${month}-${String(r.int(10, 28)).padStart(2, '0')}`, [sys('cash', 'debit', 42_000), recvLine(occ, u.unitId, 'occupant', 'credit', 42_000)]));
        }
        const pattern = i % 5;
        const payDay = (d: number) => `${month}-${String(d).padStart(2, '0')}`;
        const pay = (date: IsoDate, amt: number) => post(tx('payment', date, [sys('bank', 'debit', amt), recvLine(acc, u.unitId, 'owner', 'credit', amt)]));
        if (pattern === 0) await pay(payDay(5), amount);
        else if (pattern === 1) await pay(payDay(25), amount);
        else if (pattern === 2) await pay(payDay(20), Math.floor(amount / 2) + (m % 2 ? Math.ceil(amount / 2) : 0));
        else if (pattern === 3 && m < MONTHS - 6) await pay(payDay(8), amount);
        else if (pattern === 4 && m % 3 === 2) await pay(payDay(12), amount * 3);
      }
    }
    // Ters kayitlar (iptal edilmis odeme / tahakkuk) ve iki donemin tazminat kesinlestirmesi.
    const u7 = all().filter((t) => t.lines.some((l) => l.accountId === 'recv-u7-owner'));
    await post(mirror(u7.find((t) => t.kind === 'payment') as Transaction, '2026-06-03'));
    await post(mirror(u7.find((t) => t.kind === 'dues_charge') as Transaction, '2026-06-03'));
    await finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    await finance.postLateFees(APT, { period: '2026-10', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    // Ozetleri sil (backfill oncesi durum): ilk okuma hesap kapsamli yeniden uretir.
    fake.summaries.clear();
    io.reset();
  }, 240_000);

  it('defter gercekten buyuk (binlerce gecmis kayit)', () => {
    expect(fake.transactions.size).toBeGreaterThan(50_000);
  });

  it('dues-status: tam tarama yok, sonuc eski tam-defter hesabiyla birebir; ikinci okuma hic defter satiri okumaz', async () => {
    const legacy = byNumber(buildDuesStatus(units, all(), receivableIds(), TODAY, RATE));
    io.reset();
    const first = await finance.duesStatus(ctx);
    expect(io.counts.fullScans).toBe(0);
    expect(first.items).toEqual(legacy);
    // Ozetsiz ilk okuma: her alt cari yalnizca KENDI satirlari (hesap basina 1 sorgu).
    expect(io.counts.entryQueries).toBe(receivableIds().size);
    expect(fake.summaries.size).toBe(receivableIds().size);

    io.reset();
    const second = await finance.duesStatus(ctx);
    expect(second.items).toEqual(legacy);
    expect(io.counts).toMatchObject({ fullScans: 0, rangedScans: 0, txItems: 0, entryQueries: 0, entryItems: 0, batchGetItems: 0 });
  }, 120_000);

  it('tek tahsilattan sonra yalnizca o alt cari yeniden okunur; Genel Bakis ozeti birebir', async () => {
    await finance.recordPayment(ctx, { idempotencyKey: 'p1a-pay-1', unitId: 'u13', liableParty: 'owner', amount: 100_000, method: 'cash', paidAt: TODAY });
    io.reset();
    const s = await finance.summary(ctx);
    expect(io.counts.fullScans).toBe(0);
    expect([...io.counts.accountsRefreshed]).toEqual(['recv-u13-owner']);
    // Okunan satir sayisi o hesabin gecmisiyle sinirli (24 ay tahakkuk + odemeler), siteyle degil.
    expect(io.counts.entryItems).toBeLessThan(120);
    const accounts = [...fake.accounts.values()];
    const legacy = buildSummary(accounts, buildDuesStatus(units, all(), receivableIds(), TODAY, RATE));
    const { asOf: _asOf, ...rest } = s;
    expect(rest).toEqual(legacy);
  }, 120_000);

  it('borc hatirlatmalari birebir, tam tarama yok', async () => {
    const accounts = [...fake.accounts.values()];
    const current = new Set(accounts.filter((a) => a.type === 'receivable' && a.unitId && a.liableParty && isPrimaryReceivableId(a.accountId, a.unitId, a.liableParty)).map((a) => a.accountId));
    for (const date of ['2026-11-07', '2026-11-11', '2026-11-12', '2026-11-17', TODAY]) {
      io.reset();
      const got = await finance.dueReminders(APT, date);
      expect(io.counts.fullScans).toBe(0);
      expect(got).toEqual(buildDueReminders(all(), current, date, new Map()));
    }
  }, 120_000);

  it('gecikme tazminati kesinlestirmesi: tutarlar eski tam-defter hesabiyla birebir, tam tarama yok', async () => {
    // Eski hesap: hesabin TUM islemleri uzerinden (hesap basina gruplanarak; sonuc ayni).
    const byAccount = new Map<string, Transaction[]>();
    for (const t of all()) for (const id of new Set(t.lines.map((l) => l.accountId))) byAccount.set(id, [...(byAccount.get(id) ?? []), t]);
    const expected = new Map<string, number>();
    for (const a of [...fake.accounts.values()].filter((x) => x.type === 'receivable')) {
      const amount = unpostedLateFee(feeLedgerFor(a.accountId, byAccount.get(a.accountId) ?? []), RATE, '2026-11-30');
      if (amount >= 1) expected.set(a.accountId, amount);
    }
    expect(expected.size).toBeGreaterThan(100);
    io.reset();
    const r = await finance.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    expect(io.counts.fullScans).toBe(0);
    expect(new Map(r.items.filter((i) => !i.replayed).map((i) => [i.accountId, i.amount as number]))).toEqual(expected);
    // Kesinlestirme sonrasi ozetler worker icinde tazelendi: sonraki rapor defter okumaz.
    io.reset();
    const after = await finance.duesStatus(ctx);
    expect(io.counts.entryQueries).toBe(0);
    expect(after.items).toEqual(byNumber(buildDuesStatus(units, all(), receivableIds(), TODAY, RATE)));
    // Mizan dengesi (append-only, kurus mutabakati) bozulmadi.
    expect(fake.trialBalance()).toBe(0);
  }, 180_000);

  it('bayat ozet (surum tutmuyor) asla kullanilmaz', async () => {
    const acc = 'recv-u21-owner';
    const item = fake.summaries.get(`${APT}|${acc}`);
    expect(item).toBeDefined();
    // Hesap surumunu ozete dokunmadan ilerlet (es zamanli yazim taklidi) ve ozeti "yanlis" yap.
    fake.summaries.set(`${APT}|${acc}`, { ...structuredClone(item!), core: { ...structuredClone(item!.core), balance: 1 } });
    const a = fake.accounts.get(`${APT}|${acc}`)!;
    await fake.repo.postBatch({ transactions: [tx('payment', TODAY, [sys('cash', 'debit', 1), recvLine(acc, 'u21', 'owner', 'credit', 1)])], idempotency: { id: 'p1a-stale', fingerprint: 'x' } });
    expect(fake.accounts.get(`${APT}|${acc}`)!.version).toBe(a.version + 1);
    io.reset();
    const got = await finance.duesStatus(ctx);
    expect([...io.counts.accountsRefreshed]).toEqual([acc]);
    expect(got.items).toEqual(byNumber(buildDuesStatus(units, all(), receivableIds(), TODAY, RATE)));
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 4. Donem kapanisi: onceki kapali ay varsa gecmis okunmaz
// ---------------------------------------------------------------------------

describe('donem kapanisi okumalari', () => {
  it('ikinci kapanis yalnizca donem ve sonrasini okur; anlik goruntu tam defterle birebir', async () => {
    const fake = createFakeFinanceRepo(APT);
    const io = instrument(fake);
    const fiscal = createFakeFiscalRepo(fake.docs);
    const units = [unit('u1'), unit('u2')];
    const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
    let n = 0;
    const now = new Date('2026-11-25T09:00:00.000Z');
    const finance = createFinanceService({ repository: io.repo, core, now: () => now, newId: () => `id${String(++n).padStart(4, '0')}` });
    const sources: PeriodCheckSources = {
      meterPeriods: async () => [],
      reviewPayments: async () => 0,
      unmatchedBankLines: async () => 0,
      pendingOffsetRequests: async () => 0,
      lateFeeSettings: async () => ({ monthlyBasisPoints: 500 }),
    };
    const periods = createPeriodService({ finance: io.repo, fiscal: fiscal.repo, sources, now: () => now });
    let k = 0;
    const charge = (unitId: string, date: string, amount: number, dueDate: string) =>
      finance.chargeUnit(ctx, { idempotencyKey: `dues-key-${++k}`, unitId, liableParty: 'owner', amount, date, dueDate, description: `Aidat ${date}` });
    const pay = (unitId: string, paidAt: string, amount: number) =>
      finance.recordPayment(ctx, { idempotencyKey: `pay-key-${++k}`, unitId, liableParty: 'owner', amount, method: 'cash', paidAt });
    for (const m of ['2025-07', '2025-08', '2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']) {
      await charge('u1', `${m}-01`, 100_000, `${m}-10`);
      await charge('u2', `${m}-01`, 80_000, `${m}-10`);
      await pay('u1', `${m}-20`, 100_000);
    }
    await finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    const lockVersion = async () => (await fiscal.repo.getLock(APT))?.version ?? 0;

    // Ilk kapanis (onceki kapali ay yok): acilis tek seferlik donem oncesi islemlerden.
    const first = await periods.checklist(ctx, '2026-09');
    await periods.close(ctx, '2026-09', { expectedLockVersion: await lockVersion(), acknowledgeWarnings: first.warnings.map((w) => w.code) });

    const calls: TransactionQuery[] = [];
    const listTransactions = io.repo.listTransactions;
    io.repo.listTransactions = async (apt, q = {}) => {
      calls.push(q);
      return listTransactions(apt, q);
    };
    io.reset();
    const check = await periods.checklist(ctx, '2026-10');
    await periods.close(ctx, '2026-10', { expectedLockVersion: await lockVersion(), acknowledgeWarnings: check.warnings.map((w) => w.code) });
    expect(io.counts.fullScans).toBe(0);
    // Hicbir okuma donem basindan (2026-10-01) oncesine uzanmaz.
    for (const q of calls) expect(q.from && q.from >= '2026-10-01').toBe(true);

    const closed = await fiscal.repo.getPeriod(APT, '2026-10');
    const txs = [...fake.transactions.values()];
    const expected = buildSnapshot({
      accounts: [...fake.accounts.values()],
      opening: netByAccount(txs.filter((t) => t.date < '2026-10-01')),
      periodTransactions: txs.filter((t) => t.date >= '2026-10-01' && t.date <= '2026-10-31'),
    });
    expect(closed?.snapshot.rows).toEqual(expected.rows);
    expect(closed?.snapshot.totals).toEqual(expected.totals);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. backfill:finance-summary - idempotent, dogrulamali
// ---------------------------------------------------------------------------

describe('backfill:finance-summary', () => {
  it('ozetleri yazar, ikinci calismada hicbir sey yazmaz, --verify eski hesapla uyusur, dry-run yazmaz', async () => {
    const fake = createFakeFinanceRepo(APT);
    const units = [unit('u1'), unit('u2'), unit('u3')];
    const coreRepo = {
      getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id),
      listUnits: async () => units,
      listSiteIds: async () => [APT],
    };
    let n = 0;
    const finance = createFinanceService({ repository: fake.repo, core: coreRepo, now: () => NOW, newId: () => `bf${++n}` });
    let k = 0;
    for (const m of ['2026-08', '2026-09', '2026-10', '2026-11']) {
      for (const u of units) await finance.chargeUnit(ctx, { idempotencyKey: `bf-dues-${++k}`, unitId: u.unitId, liableParty: 'owner', amount: 100_000, date: `${m}-01`, dueDate: `${m}-10`, description: `Aidat ${m}` });
      await finance.recordPayment(ctx, { idempotencyKey: `bf-pay-${++k}`, unitId: 'u1', liableParty: 'owner', amount: 100_000, method: 'cash', paidAt: `${m}-20` });
    }
    const quiet = { info: () => undefined };
    const deps = { core: coreRepo, finance: fake.repo, today: () => TODAY, log: quiet };

    const dry = await backfillFinanceSummary(deps, { dryRun: true });
    expect(dry).toMatchObject({ sites: 1, accounts: 3, written: 0 });
    expect(fake.summaries.size).toBe(0);

    const first = await backfillFinanceSummary(deps, { verify: true });
    expect(first).toMatchObject({ sites: 1, accounts: 3, fresh: 0, refreshed: 3, written: 3, mismatchedSites: [] });
    const again = await backfillFinanceSummary(deps, { verify: true });
    expect(again).toMatchObject({ fresh: 3, refreshed: 0, written: 0, mismatchedSites: [] });
    // Defter ve bakiyeler degismedi (ozet turetilmis veridir).
    expect(fake.trialBalance()).toBe(0);
  });
});
