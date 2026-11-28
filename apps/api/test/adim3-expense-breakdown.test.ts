import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import { toKurus } from '../src/modules/core/types.js';
import { DEFAULT_EXPENSE_ACCOUNTS } from '../src/modules/finance/service.js';
import { staticSiteFeatureReader } from '../src/modules/features/guard.js';
import { type MonthSummaryItem, monthDeltas } from '../src/modules/finance/monthSummary.js';
import { financeKeys, monthSummaryKeys } from '../src/modules/finance/repository.js';
import type { Transaction } from '../src/modules/finance/types.js';
import {
  ACCOUNT_CATEGORY,
  EXPENSE_CATEGORY_META,
  type ExpenseBreakdownDeps,
  buildExpenseBreakdown,
  largestRemainder,
  loadExpenseBreakdown,
  resolveMonth,
} from '../src/modules/portal/expenseBreakdown.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-28T09:00:00.000Z');

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

let seq = 0;
function tx(kind: Transaction['kind'], date: string, lines: [string, 'debit' | 'credit', number][], reversalOf?: string): Transaction {
  const transactionId = `${date.replaceAll('-', '')}-t${++seq}`;
  const total = lines.filter((l) => l[1] === 'debit').reduce((s, l) => s + l[2], 0);
  return {
    ...financeKeys.transaction(APT, transactionId),
    entityType: 'TRANSACTION',
    transactionId,
    siteId: APT,
    kind,
    date,
    description: `${kind} ${seq} - ABC Temizlik Ltd. Ahmet Yilmaz`,
    ...(reversalOf ? { reversalOf } : {}),
    lines: lines.map(([accountId, side, amount]) => ({ accountId, side, amount: toKurus(amount) })),
    totalAmount: toKurus(total),
    createdAt: `${date}T10:00:00.000Z`,
    createdBy: 'm1',
    ms: 1,
  };
}

const expense = (date: string, account: string, amount: number) => tx('expense', date, [[account, 'debit', amount], ['bank', 'credit', amount]]);

const accounts = [
  ...DEFAULT_EXPENSE_ACCOUNTS.map((a) => ({ accountId: a.accountId, type: 'expense' as const, siteId: APT })),
  // Yonetici tarafindan acilmis ozel hesap: adi tedarikci icerebilir -> "Diger".
  { accountId: 'b8f1c2d4-ozel', type: 'expense' as const, siteId: APT },
  { accountId: 'bank', type: 'bank' as const, siteId: APT },
  { accountId: 'recv-u1-occupant', type: 'receivable' as const, siteId: APT },
];

/** Islemlerden MSUM benzetimi (postBatch'in yazdigi ozetle ayni kural). */
function summariesOf(list: Transaction[]): MonthSummaryItem[] {
  return [...monthDeltas(list).values()].map((v) => ({
    ...monthSummaryKeys.item(APT, v.month, v.accountId),
    entityType: 'MONTH_SUMMARY',
    siteId: APT,
    accountId: v.accountId,
    month: v.month,
    d: v.d,
    c: v.c,
    p: v.p,
  }));
}

function deps(list: Transaction[], ready: boolean) {
  const store = summariesOf(list);
  const d = {
    listAccounts: vi.fn(async () => accounts),
    getMonthSummaryState: vi.fn(async () => (ready ? { ready: true } : undefined)),
    listMonthSummaries: vi.fn(async (_a: string, from: string, to?: string) => store.filter((i) => i.month >= from && i.month <= (to ?? '9999-12'))),
    listTransactions: vi.fn(async (_a: string, q: { from?: string; to?: string } = {}) => ({
      items: list.filter((t) => (!q.from || t.date >= q.from) && (!q.to || t.date <= q.to)),
    })),
    now: () => NOW,
  } satisfies ExpenseBreakdownDeps;
  return d;
}

describe('en buyuk kalan yontemi', () => {
  it('toplam daima tam; esit agirlikta kalan siraya gore', () => {
    expect(largestRemainder([1, 1, 1], 10_000)).toEqual([3334, 3333, 3333]);
    expect(largestRemainder([1, 1, 1], 10_000).reduce((s, v) => s + v, 0)).toBe(10_000);
    expect(largestRemainder([0, 0], 10_000)).toEqual([0, 0]);
    expect(largestRemainder([5], 10_000)).toEqual([10_000]);
    const r = rng(3);
    for (let k = 0; k < 500; k++) {
      const w = Array.from({ length: 1 + Math.floor(r() * 8) }, () => 1 + Math.floor(r() * 50_000_000));
      const out = largestRemainder(w, 10_000);
      expect(out.reduce((s, v) => s + v, 0)).toBe(10_000);
      expect(out.every((v) => v >= 0)).toBe(true);
    }
  });
});

describe('gider dagilimi kurallari', () => {
  it('personel ve ozel hesaplar "Diger"de; isim / hesap kimligi donmez; yuzde tam 100', () => {
    const net = new Map([
      ['exp-electricity', 333_333],
      ['exp-water', 333_333],
      ['exp-staff', 600_000],
      ['b8f1c2d4-ozel', 100_001],
      ['exp-heating', 1_000_000],
    ]);
    const b = buildExpenseBreakdown('2026-10', net, 'summary');
    expect(b.items.map((i) => i.category)).toEqual(['heating', 'electricity', 'water', 'other']);
    expect(b.items.at(-1)).toMatchObject({ category: 'other', label: 'Diğer', amount: 700_001 });
    expect(b.total).toBe(2_366_667);
    expect(b.items.reduce((s, i) => s + i.amount, 0)).toBe(b.total);
    expect(b.items.reduce((s, i) => s + i.shareBp, 0)).toBe(10_000);
    expect(b.items.every((i) => i.percent === i.shareBp / 100)).toBe(true);
    const json = JSON.stringify(b);
    expect(json).not.toMatch(/exp-|ozel|Personel|personel|staff/);
    expect(b.items.map((i) => i.label).every((l) => Object.values(EXPENSE_CATEGORY_META).some((m) => m.label === l))).toBe(true);
  });

  it('net <= 0 kategori gosterilmez; gider yoksa bos durum', () => {
    const b = buildExpenseBreakdown('2026-10', new Map([['exp-water', -5_000], ['exp-cleaning', 0]]), 'summary');
    expect(b).toMatchObject({ empty: true, total: 0, items: [] });
  });

  it('personel gideri ayri kategori olarak eslenmez', () => {
    expect(ACCOUNT_CATEGORY['exp-staff']).toBe('other');
    expect(Object.keys(EXPENSE_CATEGORY_META)).not.toContain('staff');
  });

  it('ay dogrulamasi: varsayilan bu ay; gelecek ve 24 aydan eski ay reddedilir', () => {
    expect(resolveMonth(undefined, NOW)).toBe('2026-11');
    expect(resolveMonth('2026-10', NOW)).toBe('2026-10');
    expect(() => resolveMonth('2026-12', NOW)).toThrow(/Gelecek/);
    expect(() => resolveMonth('2024-10', NOW)).toThrow(/24/);
    expect(() => resolveMonth('2026-13', NOW)).toThrow(/YYYY-AA/);
  });
});

describe('okuma yolu: hesap-ay ozeti, tam tarama yok', () => {
  function world() {
    const r = rng(11);
    const list: Transaction[] = [];
    const ids = [...DEFAULT_EXPENSE_ACCOUNTS.map((a): string => a.accountId), 'b8f1c2d4-ozel'];
    for (let m = 1; m <= 11; m++) {
      const month = `2026-${String(m).padStart(2, '0')}`;
      for (let k = 0; k < 40; k++) {
        const t = expense(`${month}-${String(1 + Math.floor(r() * 28)).padStart(2, '0')}`, ids[Math.floor(r() * ids.length)] as string, 1_000 + Math.floor(r() * 900_000));
        list.push(t);
        // Ara sira ters kayit (net duser).
        if (k % 13 === 0) list.push(tx('reversal', t.date, t.lines.map((l) => [l.accountId, l.side === 'debit' ? 'credit' : 'debit', l.amount] as [string, 'debit' | 'credit', number]), t.transactionId));
      }
      // Gider disi hareketler (tahakkuk, tahsilat) sonucu etkilemez.
      list.push(tx('dues_charge', `${month}-01`, [['recv-u1-occupant', 'debit', 75_000], ['income-dues', 'credit', 75_000]]));
      list.push(tx('payment', `${month}-12`, [['bank', 'debit', 75_000], ['recv-u1-occupant', 'credit', 75_000]]));
    }
    return list;
  }

  it('ozet hazirsa yalnizca o ayin ozet kayitlari okunur; donem yoluyla kurus kurus ayni', async () => {
    const list = world();
    for (const month of ['2026-01', '2026-06', '2026-11']) {
      const fast = deps(list, true);
      const slow = deps(list, false);
      const a = await loadExpenseBreakdown(fast, APT, month);
      const b = await loadExpenseBreakdown(slow, APT, month);
      expect(a.source).toBe('summary');
      expect(b.source).toBe('period');
      expect({ ...a, source: 'x' }).toEqual({ ...b, source: 'x' });
      expect(a.items.reduce((s, i) => s + i.shareBp, 0)).toBe(10_000);
      expect(fast.listTransactions).not.toHaveBeenCalled();
      expect(fast.listMonthSummaries).toHaveBeenCalledWith(APT, month, month);
      // Donem yolu da yalnizca o ayi okur (tum defter degil).
      expect(slow.listTransactions).toHaveBeenCalledWith(APT, expect.objectContaining({ from: `${month}-01`, to: expect.stringMatching(new RegExp(`^${month}-`)) }));
      // Referans: o ayin gider hesabi satirlarinin net toplami.
      const expected = list
        .filter((t) => t.date.startsWith(month))
        .flatMap((t) => t.lines)
        .filter((l) => accounts.some((x) => x.type === 'expense' && x.accountId === l.accountId))
        .reduce((s, l) => s + (l.side === 'debit' ? l.amount : -l.amount), 0);
      expect(a.total).toBe(expected);
    }
  });

  it('gider hesabi yoksa veya o ay gider yoksa bos durum', async () => {
    const empty = await loadExpenseBreakdown({ ...deps([], true), listAccounts: async () => [] }, APT, '2026-10');
    expect(empty.empty).toBe(true);
    const none = await loadExpenseBreakdown(deps(world(), true), APT, '2026-11');
    expect(none.empty).toBe(false);
    const quiet = await loadExpenseBreakdown(deps([expense('2026-01-05', 'exp-water', 1000)], true), APT, '2026-02');
    expect(quiet).toMatchObject({ empty: true, total: 0, month: '2026-02' });
  });
});

describe('GET /api/portal/expense-breakdown', () => {
  const resident = { authorization: `Bearer ${encodeMockToken({ sub: 'r1', role: 'resident', apartmentId: APT })}` };
  const manager = { authorization: `Bearer ${encodeMockToken({ sub: 'm1', role: 'apartment_manager', apartmentId: APT })}` };
  const list = [expense('2026-10-03', 'exp-electricity', 300_000), expense('2026-10-04', 'exp-staff', 700_000)];
  const app = (on: boolean) =>
    createApp({
      version: 'test',
      authenticate: createMockAuthenticator(),
      mfaPolicy: { mode: 'off', graceDays: 7 },
      siteFeatures: staticSiteFeatureReader({ 'resident.expenseChart': on }),
      portalService: {} as never,
      expenseBreakdown: (ctx, month) => loadExpenseBreakdown(deps(list, true), ctx.apartmentId, month),
    });

  it('ozellik kapaliysa 403 feature_disabled', async () => {
    const res = await app(false).request('/api/portal/expense-breakdown?month=2026-10', { headers: resident });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'feature_disabled', feature: 'resident.expenseChart' });
  });

  it('acikken sakin sade kategorileri gorur; yonetici bu uca giremez; gecersiz ay 400', async () => {
    const res = await app(true).request('/api/portal/expense-breakdown?month=2026-10', { headers: resident });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ month: '2026-10', total: 1_000_000, empty: false });
    expect(body.items).toEqual([
      expect.objectContaining({ category: 'electricity', label: 'Elektrik', amount: 300_000, shareBp: 3000 }),
      expect.objectContaining({ category: 'other', label: 'Diğer', amount: 700_000, shareBp: 7000 }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/Ahmet|ABC|Temizlik Ltd|exp-/);
    expect((await app(true).request('/api/portal/expense-breakdown', { headers: manager })).status).toBe(403);
    expect((await app(true).request('/api/portal/expense-breakdown?month=2026-99', { headers: resident })).status).toBe(400);
  });
});
