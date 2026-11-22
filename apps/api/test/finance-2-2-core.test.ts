/**
 * Finans 2.2 - defter cekirdegi (saf): hedefli kapama (`settles`), tazminat tabani (`feeBase`),
 * avans mahsubunun kaynakta avans tuketmesi, taksit tablosu ve temerrut kurali, denetim kontrolu.
 */
import { describe, expect, it } from 'vitest';
import { toKurus } from '../src/modules/core/types.js';
import { checkSettlements } from '../src/modules/finance/audit.js';
import { computeLateFee } from '../src/modules/finance/lateFee.js';
import { holdersOf, isSamePerson } from '../src/modules/finance/offsets.js';
import { DEFAULT_PLAN_RULE, addMonths, buildInstallments, detectDefault, splitEven } from '../src/modules/finance/plans.js';
import { allocate, feeInputsOf, linesOfAccount, readSubledger } from '../src/modules/finance/subledger.js';
import type { Account, Transaction, TransactionLine } from '../src/modules/finance/types.js';

const ACC = 'recv-u1-occupant';
let seq = 0;
function tx(kind: Transaction['kind'], date: string, lines: TransactionLine[], extra: Partial<Transaction> = {}): Transaction {
  const transactionId = extra.transactionId ?? `t${String(++seq).padStart(3, '0')}`;
  return {
    PK: 'APT#apt-1',
    SK: `TX#${transactionId}`,
    entityType: 'TRANSACTION',
    transactionId,
    siteId: 'apt-1',
    kind,
    date,
    description: kind,
    lines,
    totalAmount: toKurus(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
    createdAt: `${date}T00:00:00.000Z`,
    createdBy: 'test',
    ...extra,
  };
}
const debit = (amount: number, accountId = ACC): TransactionLine => ({ accountId, side: 'debit', amount: toKurus(amount), unitId: 'u1', liableParty: 'occupant' });
const credit = (amount: number, settles?: { chargeId: string; amount: number }[], accountId = ACC): TransactionLine => ({
  accountId,
  side: 'credit',
  amount: toKurus(amount),
  unitId: 'u1',
  liableParty: 'occupant',
  ...(settles ? { settles: settles.map((s) => ({ chargeId: s.chargeId, amount: toKurus(s.amount) })) } : {}),
});
const income = (amount: number): TransactionLine => ({ accountId: 'income-dues', side: 'credit', amount: toKurus(amount) });
const cash = (amount: number): TransactionLine => ({ accountId: 'cash', side: 'debit', amount: toKurus(amount) });
const dues = (id: string, date: string, dueDate: string, amount: number) => tx('dues_charge', date, [debit(amount), income(amount)], { transactionId: id, dueDate });
const payment = (date: string, amount: number, settles?: { chargeId: string; amount: number }[]) => tx('payment', date, [cash(amount), credit(amount, settles)]);

describe('hedefli kapama (settles) ve FIFO uyumu', () => {
  it('hedefli tutar once kendi kalemine; havuz FIFO secilmeyen kalemlerde aynen calisir', () => {
    const txs = [dues('sep', '2026-09-01', '2026-09-10', 100000), dues('oct', '2026-10-01', '2026-10-10', 100000), payment('2026-10-15', 50000, [{ chargeId: 'oct', amount: 30000 }])];
    const sub = readSubledger(linesOfAccount(ACC, txs));
    expect(sub.settlements).toEqual([expect.objectContaining({ chargeId: 'oct', amount: 30000 })]);
    expect(sub.credits.map((c) => c.amount)).toEqual([20000]);
    const { all, advance } = allocate(sub, '2026-11-01');
    expect(all.map((c) => [c.id, c.paid, c.remaining])).toEqual([
      ['sep', 20000, 80000],
      ['oct', 30000, 70000],
    ]);
    expect(advance).toBe(0);
  });

  it('settles yoksa sonuc eskisiyle ayni; bilinmeyen kaleme hedefli tutar havuza duser', () => {
    const base = [dues('a', '2026-09-01', '2026-09-10', 100000), dues('b', '2026-10-01', '2026-10-10', 100000)];
    const plain = allocate(readSubledger(linesOfAccount(ACC, [...base, payment('2026-10-15', 130000)])), '2026-11-01');
    const unknown = allocate(readSubledger(linesOfAccount(ACC, [...base, payment('2026-10-15', 130000, [{ chargeId: 'yok', amount: 50000 }])])), '2026-11-01');
    expect(unknown.all.map((c) => [c.id, c.paid])).toEqual(plain.all.map((c) => [c.id, c.paid]));
    expect(plain.all.map((c) => c.paid)).toEqual([100000, 30000]);
  });

  it('yapilandirma islemi: kalemleri kapatir, taksitleri <islem>_<n> kimligi ve feeBase ile acar', () => {
    const r = tx(
      'restructure',
      '2026-11-05',
      [credit(200000, [{ chargeId: 'sep', amount: 100000 }, { chargeId: 'oct', amount: 100000 }]), debit(200000)],
      {
        transactionId: 'rs1',
        plan: {
          planId: 'p1',
          role: 'open',
          items: [
            { no: 1, description: 'T1', dueDate: '2026-12-10', amount: toKurus(100000), feeBase: toKurus(80000) },
            { no: 2, description: 'T2', dueDate: '2027-01-10', amount: toKurus(100000), feeBase: toKurus(80000) },
          ],
        },
      },
    );
    const txs = [dues('sep', '2026-09-01', '2026-09-10', 100000), dues('oct', '2026-10-01', '2026-10-10', 100000), r];
    const sub = readSubledger(linesOfAccount(ACC, txs));
    expect(sub.balance).toBe(200000);
    const { open } = allocate(sub, '2026-11-05');
    expect(open.map((c) => [c.id, c.remaining, c.feeBase, c.plan])).toEqual([
      ['rs1_1', 100000, 80000, { planId: 'p1', no: 1 }],
      ['rs1_2', 100000, 80000, { planId: 'p1', no: 2 }],
    ]);
    // Tazminat girdileri: taksitlerin tabani tutardan kucuk -> feeBase tasinir.
    const fee = feeInputsOf(sub);
    expect(fee.charges.find((c) => c.id === 'rs1_1')).toMatchObject({ amount: 100000, feeBase: 80000 });
    expect(fee.settlements.map((s) => s.chargeId).sort()).toEqual(['oct', 'sep']);
  });
});

describe('kistelyevm: hedefli kapama ve tazminat tabani', () => {
  const charge = { id: 'a', dueDate: '2026-01-10', amount: 100000 };
  it('settlements/feeBase yoksa sonuc degismez', () => {
    expect(computeLateFee({ charges: [charge], credits: [], monthlyBasisPoints: 500, asOf: '2026-02-09' }).fee).toBe(5000);
  });
  it('hedefli kapama o kalemin tazminatini kapama gunu durdurur', () => {
    const r = computeLateFee({ charges: [charge], credits: [], settlements: [{ chargeId: 'a', date: '2026-01-25', amount: 100000 }], monthlyBasisPoints: 500, asOf: '2026-02-09' });
    expect(r.fee).toBe(2500);
    expect(r.overduePrincipal).toBe(0);
  });
  it('tazminat yalnizca anapara payina (feeBase) isler; odemeler once anapara payini kapatir', () => {
    expect(computeLateFee({ charges: [{ ...charge, feeBase: 40000 }], credits: [], monthlyBasisPoints: 500, asOf: '2026-02-09' }).fee).toBe(2000);
    // 30.000 odeme 15. gunde: 30.000 x 15 + 10.000 x 30 kurus-gun.
    const r = computeLateFee({ charges: [{ ...charge, feeBase: 40000 }], credits: [{ date: '2026-01-25', amount: 30000 }], monthlyBasisPoints: 500, asOf: '2026-02-09' });
    expect(r.principalDays).toBe(750000n);
    expect(r.fee).toBe(1250);
  });
});

describe('avans mahsubu kaynakta avansi tuketir', () => {
  it('mahsup borcu kalem degil; en yeni alacaktan duser, tazminat zamanlamasi korunur', () => {
    const src = 'recv-u1-owner';
    const lines = (a: number) => ({ accountId: src, unitId: 'u1', liableParty: 'owner' as const, amount: toKurus(a) });
    const txs = [
      tx('dues_charge', '2026-09-01', [{ ...lines(100000), side: 'debit' }, income(100000)], { transactionId: 'd1', dueDate: '2026-09-10' }),
      tx('payment', '2026-09-05', [cash(30000), { ...lines(30000), side: 'credit' }]),
      tx('payment', '2026-09-08', [cash(120000), { ...lines(120000), side: 'credit' }]),
      tx('offset', '2026-10-01', [{ ...lines(50000), side: 'debit' }, credit(50000)], { transactionId: 'of1', offsetId: 'o1' }),
    ];
    const sub = readSubledger(linesOfAccount(src, txs));
    expect(sub.charges.map((c) => c.id)).toEqual(['d1']);
    expect(sub.credits.map((c) => c.amount)).toEqual([30000, 70000]);
    expect(allocate(sub, '2026-10-02')).toMatchObject({ advance: 0, open: [] });
    expect(sub.balance).toBe(0);
    // Hedef: mahsup alacagi normal tahsilat gibi.
    expect(readSubledger(linesOfAccount(ACC, txs)).credits).toEqual([expect.objectContaining({ amount: 50000, txKind: 'offset' })]);
  });

  it('havuz yetmezse (tahsilat sonradan iptal) kalan kisim tazminatsiz borc kalemi olur', () => {
    const src = 'recv-u1-owner';
    const l = (side: 'debit' | 'credit', a: number) => ({ accountId: src, side, unitId: 'u1', liableParty: 'owner' as const, amount: toKurus(a) });
    const p = tx('payment', '2026-09-05', [cash(50000), l('credit', 50000)]);
    const rev = tx('reversal', '2026-10-05', [l('debit', 50000), { accountId: 'cash', side: 'credit', amount: toKurus(50000) }], { reversalOf: p.transactionId });
    const txs = [p, tx('offset', '2026-10-01', [l('debit', 50000), credit(50000)], { transactionId: 'of2', offsetId: 'o2' }), rev];
    const sub = readSubledger(linesOfAccount(src, txs));
    expect(sub.charges).toEqual([expect.objectContaining({ id: 'of2', amount: 50000, feeBearing: false, dueDate: '2026-10-01' })]);
    expect(sub.balance).toBe(50000);
  });
});

describe('taksit tablosu ve temerrut kurali', () => {
  it('esit bolme kurus kaybetmez; artan kurus ilk taksitlere', () => {
    expect(splitEven(1000, 3)).toEqual([334, 333, 333]);
    expect(splitEven(213667, 4)).toEqual([53417, 53417, 53417, 53416]);
    const items = buildInstallments(100001, 50000, 3, '2026-12-15', 'Yapılandırma');
    expect(items.map((i) => [i.no, i.dueDate, i.amount, i.feeBase])).toEqual([
      [1, '2026-12-15', 33334, 16667],
      [2, '2027-01-15', 33334, 16667],
      [3, '2027-02-15', 33333, 16666],
    ]);
    expect(items.reduce((s, i) => s + i.amount, 0)).toBe(100001);
    expect(items[0]?.description).toBe('Yapılandırma - Taksit 1/3');
  });

  it('ay sonu vadeler kisa aylara cekilir', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2024-01-31', 1)).toBe('2024-02-29');
    expect(addMonths('2026-01-31', 13)).toBe('2027-02-28');
    expect(addMonths('2026-11-30', 2)).toBe('2027-01-30');
  });

  it('ardisik veya toplam geciken taksit esigi', () => {
    const rule = DEFAULT_PLAN_RULE;
    expect(rule).toEqual({ consecutive: 2, total: 3, graceDays: 7, autoAccelerate: false });
    expect(detectDefault([], rule)).toBe(false);
    expect(detectDefault([1], rule)).toBe(false);
    expect(detectDefault([1, 3], rule)).toBe(false);
    expect(detectDefault([2, 3], rule)).toBe(true);
    expect(detectDefault([1, 3, 5], rule)).toBe(true);
    expect(detectDefault([4], { ...rule, consecutive: 1, total: 5 })).toBe(true);
  });
});

describe('ayni kisi kontrolu (karar 5)', () => {
  const acc = (over: Partial<Account>): Account => ({ PK: 'p', SK: 's', entityType: 'ACCOUNT', siteId: 'apt-1', type: 'receivable', name: 'x', status: 'active', balance: toKurus(0), createdAt: '', createdBy: '', updatedAt: '', updatedBy: '', version: 1, ...over }) as Account;
  const m = (userId: string, relation: 'owner' | 'tenant', residesInUnit: boolean) => ({ userId, apartmentId: 'apt-1', unitId: 'u1', relation, residesInUnit, status: 'active' as const, startDate: '2026-01-01' });

  it('ana cari: o gun o tarafta kayitli uyeler; paydas/ayrilan cari: kendi sahibi', () => {
    const members = [m('own', 'owner', true), m('ten', 'tenant', true), m('own2', 'owner', false)];
    expect(holdersOf(acc({ accountId: 'recv-u1-occupant', unitId: 'u1', liableParty: 'occupant' }), members, '2026-06-01')).toEqual(['own', 'ten']);
    expect(holdersOf(acc({ accountId: 'recv-u1-owner', unitId: 'u1', liableParty: 'owner' }), members, '2026-06-01')).toEqual(['own', 'own2']);
    expect(holdersOf(acc({ accountId: 'recv-u1-owner-habc', unitId: 'u1', liableParty: 'owner', coOwner: { userId: 'own2' } }), members, '2026-06-01')).toEqual(['own2']);
    expect(holdersOf(acc({ accountId: 'recv-u1-occupant-cX', unitId: 'u1', liableParty: 'occupant', holder: { userIds: ['old'], periodEnd: '2026-03-01' } }), members, '2026-06-01')).toEqual(['old']);
  });

  it('kaynagin tum sahipleri hedefte olmali', () => {
    expect(isSamePerson(['a'], ['a', 'b'])).toBe(true);
    expect(isSamePerson(['a', 'b'], ['a'])).toBe(false);
    expect(isSamePerson([], ['a'])).toBe(false);
  });
});

describe('denetim: hedefli kapama tutarliligi', () => {
  it('gecerli kayitlar bulgu uretmez; satiri asan, bilinmeyen ve fazla kapatilan kalem bulgudur', () => {
    const base = [dues('sep', '2026-09-01', '2026-09-10', 100000)];
    expect(checkSettlements({ transactions: [...base, payment('2026-09-15', 100000, [{ chargeId: 'sep', amount: 100000 }])] })).toEqual([]);

    const over = tx('payment', '2026-09-15', [cash(50000), credit(50000, [{ chargeId: 'sep', amount: 60000 }])]);
    expect(checkSettlements({ transactions: [...base, over] })).toEqual([expect.objectContaining({ code: 'settlement_invalid', detail: 'settles_exceeds_line' })]);

    const unknown = payment('2026-09-15', 50000, [{ chargeId: 'yok', amount: 50000 }]);
    expect(checkSettlements({ transactions: [...base, unknown] })).toEqual([expect.objectContaining({ code: 'settlement_invalid', detail: 'unknown_charge:yok' })]);

    const twice = [payment('2026-09-15', 80000, [{ chargeId: 'sep', amount: 80000 }]), payment('2026-09-16', 80000, [{ chargeId: 'sep', amount: 80000 }])];
    expect(checkSettlements({ transactions: [...base, ...twice] })).toEqual([expect.objectContaining({ code: 'settlement_invalid', detail: 'over_settled:sep', expected: 100000, actual: 160000 })]);
  });
});
