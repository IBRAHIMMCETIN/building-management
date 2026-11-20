/**
 * Cari devri - Asama 1 (defter cekirdegi): kapama/acilis islemleri tum motorlarda ayni kurallarla
 * okunur. Kapama islemleri burada, Asama 2'deki kapama servisinin uretecegi bicimde elle kurulur.
 */
import { describe, expect, it } from 'vitest';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Unit, toKurus } from '../src/modules/core/types.js';
import { computeLateFee, feeLedgerFor, unpostedLateFee } from '../src/modules/finance/lateFee.js';
import { financeKeys, toLedgerEntries } from '../src/modules/finance/repository.js';
import { buildDueReminders, buildDuesStatus } from '../src/modules/finance/reports.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import {
  allocate,
  cancelledIn,
  feeInputsOf,
  linesOfAccount,
  readSubledger,
  transferItemId,
} from '../src/modules/finance/subledger.js';
import type { Account, Transaction, TransferItem } from '../src/modules/finance/types.js';
import { feeInputsFromEntries } from '../src/modules/payments/quote.js';
import { allocateOpenDues } from '../src/modules/portal/service.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-1';
const TL = (n: number) => toKurus(Math.round(n * 100));
const RATE = 500; // aylik %5
const MAIN = 'recv-u1-occupant';
const CLEARING = 'transfer-clearing';
const formerId = (closureId: string) => `${MAIN}-c${closureId}`;

function unit(id: string): Unit {
  const ts = '2026-08-01T00:00:00.000Z';
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: ts,
    createdBy: 'seed',
    updatedAt: ts,
    updatedBy: 'seed',
    version: 1,
  };
}

function world() {
  const fake = createFakeFinanceRepo();
  let n = 0;
  let now = new Date('2026-09-01T09:00:00.000Z');
  const units = [unit('u1')];
  const core = {
    getUnit: async (_apt: string, id: string) => units.find((u) => u.unitId === id),
    listUnits: async () => units,
    getSite: async () => ({ settings: { lateFeeMonthlyBasisPoints: RATE } }),
  } as unknown as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  const service = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${++n}` });
  const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
  const setNow = (iso: string) => {
    now = new Date(`${iso}T09:00:00.000Z`);
  };
  const txs = async () => (await fake.repo.listTransactions(APT)).items;
  const charge = (key: string, amount: number, date: string, dueDate: string, description: string) =>
    service.chargeUnit(ctx, { idempotencyKey: key, unitId: 'u1', liableParty: 'occupant', amount: TL(amount), date, dueDate, description });
  const pay = (key: string, amount: number, paidAt: string) =>
    service.recordPayment(ctx, { idempotencyKey: key, unitId: 'u1', liableParty: 'occupant', amount: TL(amount), method: 'cash', paidAt });
  const sub = async (accountId: string) => readSubledger(linesOfAccount(accountId, await txs()));
  const balanceOf = async (accountId: string) => (await fake.repo.getAccount(APT, accountId))?.balance;
  return { fake, service, ctx, setNow, txs, charge, pay, sub, balanceOf };
}

type W = ReturnType<typeof world>;

let seq = 0;
function txOf(over: Partial<Transaction> & Pick<Transaction, 'kind' | 'date' | 'lines'>): Transaction {
  const transactionId = over.transactionId ?? `${over.date.replaceAll('-', '')}-x${++seq}`;
  return {
    ...financeKeys.transaction(APT, transactionId),
    entityType: 'TRANSACTION',
    transactionId,
    siteId: APT,
    description: 'test',
    totalAmount: toKurus(over.lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
    createdAt: '2026-11-01T00:00:00.000Z',
    createdBy: 'mgr-1',
    ...over,
  };
}

/**
 * Asama 2 kapama servisinin uretecegi kayitlar (burada elle): kesim tarihine kadar islemis
 * tazminati kesinlestir, kaynak cariyi net bakiyesiyle kapat, hedefi kalemleriyle ac.
 */
async function close(w: W, opts: { closureId: string; cutoff: string; target: string; openDate?: string; source?: string }) {
  const source = opts.source ?? MAIN;
  await w.fake.repo.ensureAccounts([
    acct(CLEARING, { type: 'equity', name: 'Cari devir ara hesabı' }),
    ...(opts.target === source || opts.target.startsWith('recv-u1-owner') ? [] : [acct(opts.target, { closureId: opts.closureId })]),
    ...(opts.target === 'recv-u1-owner' ? [acct('recv-u1-owner', { liableParty: 'owner' })] : []),
  ]);
  const upTo = (await w.txs()).filter((t) => t.date <= opts.cutoff);
  const fee = unpostedLateFee(feeLedgerFor(source, upTo), RATE, opts.cutoff);
  const batch: Transaction[] = [];
  if (fee > 0) {
    batch.push(
      txOf({
        kind: 'late_fee',
        date: opts.cutoff,
        dueDate: opts.cutoff,
        description: 'Gecikme tazminatı (kapama)',
        lines: [
          { accountId: source, side: 'debit', amount: toKurus(fee), unitId: 'u1', liableParty: 'occupant' },
          { accountId: 'income-late-fee', side: 'credit', amount: toKurus(fee) },
        ],
      }),
    );
  }
  const sub = readSubledger(linesOfAccount(source, [...upTo, ...batch]));
  const net = sub.balance;
  const { open } = allocate(sub, opts.cutoff);
  const items: TransferItem[] = open.map((c) => ({
    sourceChargeId: c.id,
    category: c.lateFee ? 'late_fee' : 'principal',
    description: c.description,
    date: c.date,
    dueDate: c.dueDate,
    amount: c.remaining,
  }));
  const abs = toKurus(Math.abs(net));
  const debt = net > 0;
  const targetParty = opts.target.startsWith('recv-u1-owner') ? 'owner' : 'occupant';
  batch.push(
    txOf({
      kind: 'transfer',
      date: opts.cutoff,
      description: 'Cari kapama',
      transfer: { closureId: opts.closureId, role: 'close', cutoff: opts.cutoff },
      lines: [
        { accountId: source, side: debt ? 'credit' : 'debit', amount: abs, unitId: 'u1', liableParty: 'occupant' },
        { accountId: CLEARING, side: debt ? 'debit' : 'credit', amount: abs },
      ],
    }),
    txOf({
      kind: 'transfer',
      date: opts.openDate ?? opts.cutoff,
      description: 'Devir',
      transfer: { closureId: opts.closureId, role: 'open', ...(debt ? { items } : {}) },
      lines: [
        { accountId: opts.target, side: debt ? 'debit' : 'credit', amount: abs, unitId: 'u1', liableParty: targetParty },
        { accountId: CLEARING, side: debt ? 'credit' : 'debit', amount: abs },
      ],
    }),
  );
  await w.fake.repo.postBatch({ transactions: batch, idempotency: { id: `closure-${opts.closureId}`, fingerprint: 'x' } });
  return { fee, net, items, batch };
}

function acct(accountId: string, over: Partial<Account> = {}): Account {
  const ts = '2026-11-01T00:00:00.000Z';
  return {
    PK: `APT#${APT}`,
    SK: `ACCT#${accountId}`,
    entityType: 'ACCOUNT',
    accountId,
    siteId: APT,
    type: 'receivable',
    name: accountId,
    status: 'active',
    balance: toKurus(0),
    unitId: 'u1',
    liableParty: 'occupant',
    createdAt: ts,
    createdBy: 'seed',
    updatedAt: ts,
    updatedBy: 'seed',
    version: 1,
    ...over,
  };
}

/** Eski kiraci A: Eylul + Ekim aidati, Eylul'de 400 TL odeme, Eylul tazminati Ekim 1'de yazildi. */
async function tenantA(w: W) {
  await w.charge('k-sep', 1000, '2026-09-01', '2026-09-10', 'Eylül aidatı');
  await w.pay('p-sep', 400, '2026-09-20');
  await w.service.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
  await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10', 'Ekim aidatı');
}

describe('kistelyevm - tazminat baslangici (accrueFrom)', () => {
  it('devredilen anaparada tazminat vade degil devir tarihinden sonra isler; vade daha gecse vadeden', () => {
    const base = { credits: [], monthlyBasisPoints: 300, asOf: '2026-11-30' };
    // 1000 TL, vade 1 Ekim; devir 31 Ekim -> hedefte yalnizca Kasim (30 gun): %3.
    expect(computeLateFee({ ...base, charges: [{ id: 'a', dueDate: '2026-10-01', amount: 100_000, accrueFrom: '2026-10-31' }] }).fee).toBe(3_000);
    // Devir olmasaydi vadeden itibaren 60 gun.
    expect(computeLateFee({ ...base, charges: [{ id: 'a', dueDate: '2026-10-01', amount: 100_000 }] }).fee).toBe(6_000);
    // Vade devir tarihinden sonraysa vadeden itibaren (15 gun).
    expect(computeLateFee({ ...base, charges: [{ id: 'a', dueDate: '2026-11-15', amount: 100_000, accrueFrom: '2026-10-31' }] }).fee).toBe(1_500);
    // Gecikmis anapara vadeye gore sayilir (devir tarihine gore degil).
    expect(computeLateFee({ ...base, charges: [{ id: 'a', dueDate: '2026-10-01', amount: 100_000, accrueFrom: '2026-12-15' }] })).toMatchObject({
      fee: 0,
      overduePrincipal: 100_000,
    });
  });
});

describe('cari kapama - kiraci cikisi (borc ayrilan sakin carisine)', () => {
  it('kapama: kesime kadar tazminat kesinlesir, kalan kalemler orijinal vadeleriyle devredilir, ana cari sifirlanir', async () => {
    const w = world();
    await tenantA(w);
    const { fee, net, items } = await close(w, { closureId: 'C1', cutoff: '2026-10-31', target: formerId('C1') });

    expect(fee).toBeGreaterThan(0);
    expect(items.map((i) => [i.category, i.dueDate, i.amount])).toEqual([
      ['principal', '2026-09-10', TL(600)],
      ['principal', '2026-10-10', TL(1000)],
      // Eylul tazminati 1 Ekim'de yazildi, vadesi ayin 10'u.
      ['late_fee', '2026-10-10', expect.any(Number)],
      ['late_fee', '2026-10-31', fee],
    ]);
    expect(net).toBe(items.reduce((s, i) => s + i.amount, 0));
    expect(await w.balanceOf(MAIN)).toBe(0);
    expect(await w.balanceOf(formerId('C1'))).toBe(net);
    expect(await w.balanceOf(CLEARING)).toBe(0);

    // Ana cari: kesim oncesi hic dikkate alinmaz.
    const main = await w.sub(MAIN);
    expect(main).toMatchObject({ cutoff: '2026-10-31', charges: [], credits: [], balance: 0, postedFees: 0 });

    // Ayrilan sakin carisi: kalemler acilir, kimlikleri <islem>_<sira>, anapara devir tarihinden tazminat dogurur.
    const former = await w.sub(formerId('C1'));
    const openTx = (await w.txs()).find((t) => t.transfer?.role === 'open')!;
    expect(former.charges.map((c) => [c.id, c.lateFee, c.feeBearing, c.accrueFrom ?? null])).toEqual([
      [transferItemId(openTx.transactionId, 0), false, true, '2026-10-31'],
      [transferItemId(openTx.transactionId, 1), false, true, '2026-10-31'],
      [transferItemId(openTx.transactionId, 2), true, false, null],
      [transferItemId(openTx.transactionId, 3), true, false, null],
    ]);
    expect(transferItemId(openTx.transactionId, 0)).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    // Devredilen tazminat bu hesabin "yazilmis tazminati" sayilmaz (cift dusum olmaz).
    expect(former.postedFees).toBe(0);
  });

  it('yeni kiracinin donemi temiz: tazminat, aidat durumu, bakiye ve hatirlatma eski borca karismaz', async () => {
    const w = world();
    await tenantA(w);
    await close(w, { closureId: 'C1', cutoff: '2026-10-31', target: formerId('C1') });
    // Yeni kiraci B
    await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10', 'Kasım aidatı');

    w.setNow('2026-12-01');
    const oct = await w.service.postLateFees(APT, { period: '2026-10', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    expect(oct.count).toBe(0); // Ekim tazminati kapamada kesinlesti
    const nov = await w.service.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    const byAccount = Object.fromEntries(nov.items.map((i) => [i.accountId, i.amount]));
    // Ana cari: yalnizca B'nin Kasim aidati (10 Kasim -> 30 Kasim, 20 gun): 1000 x %5 x 20/30
    expect(byAccount[MAIN]).toBe(TL(1000 * 0.05 * 20 / 30));
    // Ayrilan cari: A'nin anaparasi 1.600 TL, 31 Ekim -> 30 Kasim (30 gun)
    expect(byAccount[formerId('C1')]).toBe(TL(1600 * 0.05));
    // Idempotency: ana cari eski anahtar bicimi, ayrilan cari hesap kimligiyle.
    expect(await w.fake.repo.getIdempotency(APT, 'lf-2026-11-u1-t')).toBeDefined();
    expect(await w.fake.repo.getIdempotency(APT, `lf-2026-11-${formerId('C1')}`)).toBeDefined();
    const again = await w.service.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    expect(again.count).toBe(0);

    // Daire bakiyesi: ana cariler; ayrilan cari ayri.
    const bal = await w.service.getUnitBalance(w.ctx, 'u1');
    expect(bal.occupant.balance).toBe(TL(1000) + byAccount[MAIN]!);
    expect(bal.former).toEqual([expect.objectContaining({ accountId: formerId('C1'), closureId: 'C1', balance: await w.balanceOf(formerId('C1')) })]);

    // Aidat durumu: daire durumu yalnizca B; eski borc `former`.
    const txs = await w.txs();
    const accounts = await w.fake.repo.listAccounts(APT);
    const recv = new Set(accounts.filter((a) => a.type === 'receivable').map((a) => a.accountId));
    const [u1] = buildDuesStatus([unit('u1')], txs, recv, '2026-12-01', RATE);
    // Kasim tazminati 1 Aralik'ta yazildi, vadesi 10 Aralik: henuz gecikmede degil.
    expect(u1!.occupant).toMatchObject({ charged: TL(1000) + byAccount[MAIN]!, paid: 0, overdue: TL(1000), oldestUnpaidDueDate: '2026-11-10' });
    expect(u1!.former).toMatchObject({ balance: await w.balanceOf(formerId('C1')), oldestUnpaidDueDate: '2026-09-10' });
    expect(u1!.balance).toBe(u1!.owner.balance + u1!.occupant.balance);

    // Hatirlatma: ayrilan carinin kalemleri bugunku sakine gitmez.
    const reminders = await w.service.dueReminders(APT, '2026-10-11');
    expect(reminders).toEqual([]);
    // (Kontrol: 10 Ekim vadeli kalemler - Ekim aidati + Eylul tazminati - ayrilan caride acik.)
    const oct10 = allocate(await w.sub(formerId('C1')), '2026-10-11').open.filter((c) => c.dueDate === '2026-10-10');
    expect(oct10).toHaveLength(2);
    expect(buildDueReminders(txs, new Set([formerId('C1')]), '2026-10-11')).toEqual([
      expect.objectContaining({ kind: 'overdue_1', dueDate: '2026-10-10', amount: oct10.reduce((s, c) => s + c.remaining, 0) }),
    ]);
  });

  it('portal ve online odeme teklifi: ayni kurallar (kalem kimlikleri, tazminat tabani)', async () => {
    const w = world();
    await tenantA(w);
    await close(w, { closureId: 'C1', cutoff: '2026-10-31', target: formerId('C1') });
    const txs = await w.txs();
    const txById = new Map(txs.map((t) => [t.transactionId, t]));
    const entries = txs.flatMap((t) => toLedgerEntries(t)).filter((e) => e.accountId === formerId('C1'));

    const { open, advance } = allocateOpenDues('occupant', entries, txById, '2026-11-30');
    const openTx = txs.find((t) => t.transfer?.role === 'open')!;
    expect(open.map((o) => [o.transactionId, o.remaining, o.lateFee ?? false])).toEqual([
      [transferItemId(openTx.transactionId, 0), TL(600), false],
      [transferItemId(openTx.transactionId, 1), TL(1000), false],
      [transferItemId(openTx.transactionId, 2), expect.any(Number), true],
      [transferItemId(openTx.transactionId, 3), expect.any(Number), true],
    ]);
    expect(advance).toBe(0);
    expect(unpostedLateFee(feeInputsFromEntries(entries, txById), RATE, '2026-11-30')).toBe(TL(1600 * 0.05));

    // Ana caride kesim oncesi tamamen gizli (ayni gun bile).
    const mainEntries = txs.flatMap((t) => toLedgerEntries(t)).filter((e) => e.accountId === MAIN);
    expect(allocateOpenDues('occupant', mainEntries, txById, '2026-10-31')).toEqual({ open: [], advance: 0 });
  });

  it('ayrilan caride tahsilat once anaparayi kapatir (karar 2a); kapama ters kayitla geri alinirsa eski durum doner', async () => {
    const w = world();
    await tenantA(w);
    const before = readSubledger(linesOfAccount(MAIN, await w.txs()));
    const { batch } = await close(w, { closureId: 'C1', cutoff: '2026-10-31', target: formerId('C1') });

    // Ayrilan carisine 700 TL tahsilat (Asama 3'te tahsilat formundan; burada dogrudan).
    await w.fake.repo.postBatch({
      transactions: [
        txOf({
          kind: 'payment',
          date: '2026-11-15',
          lines: [
            { accountId: 'cash', side: 'debit', amount: TL(700) },
            { accountId: formerId('C1'), side: 'credit', amount: TL(700), unitId: 'u1', liableParty: 'occupant' },
          ],
        }),
      ],
      idempotency: { id: 'pay-former', fingerprint: 'x' },
    });
    const { open } = allocate(await w.sub(formerId('C1')), '2026-11-30');
    expect(open.map((o) => [o.dueDate, o.remaining, o.lateFee])).toEqual([
      ['2026-10-10', TL(900), false],
      ['2026-10-10', expect.any(Number), true],
      ['2026-10-31', expect.any(Number), true],
    ]);

    // Kapamanin geri alinmasi: kapama/acilis islemleri ters kayitla iptal (tazminat yerinde kalir).
    const [closeTx, openTx] = batch.filter((t) => t.kind === 'transfer');
    const reversals = [closeTx!, openTx!].map((t) =>
      txOf({ kind: 'reversal', date: '2026-11-20', reversalOf: t.transactionId, lines: t.lines.map((l) => ({ ...l, side: l.side === 'debit' ? 'credit' : 'debit' })) }),
    );
    const all = [...(await w.txs()), ...reversals];
    const restored = readSubledger(linesOfAccount(MAIN, all), cancelledIn(all));
    expect(restored.cutoff).toBeUndefined();
    expect(restored.charges.map((c) => c.id)).toEqual(expect.arrayContaining(before.charges.map((c) => c.id)));
    expect(readSubledger(linesOfAccount(formerId('C1'), all), cancelledIn(all)).charges).toEqual([]);
  });
});

describe('cari kapama - diger senaryolar', () => {
  it('avans (fazla odeme): ana cariden cikar, hedefte alacak olarak durur; yeni kiraciya mahsup edilmez', async () => {
    const w = world();
    await w.charge('k-sep', 1000, '2026-09-01', '2026-09-10', 'Eylül aidatı');
    await w.pay('p-sep', 1500, '2026-09-05');
    const { net, items } = await close(w, { closureId: 'C2', cutoff: '2026-10-31', target: formerId('C2') });
    expect(net).toBe(-TL(500));
    expect(items).toEqual([]);
    await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10', 'Kasım aidatı');

    expect(allocate(await w.sub(MAIN), '2026-11-30')).toMatchObject({ advance: 0, open: [expect.objectContaining({ remaining: TL(1000), overdue: true })] });
    const former = await w.sub(formerId('C2'));
    expect(former).toMatchObject({ balance: -TL(500), charges: [] });
    expect(allocate(former, '2026-11-30').advance).toBe(TL(500));
    // Tazminat: yeni kiracinin Kasim borcu eski avansla kapanmis sayilmaz.
    expect(unpostedLateFee(feeInputsOf(await w.sub(MAIN)), RATE, '2026-11-30')).toBe(TL(1000 * 0.05 * 20 / 30));
  });

  it('oturan malik kiraya veriyor: sakin carisindeki borc malik carisine kalemleriyle gecer', async () => {
    const w = world();
    await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10', 'Ekim aidatı');
    await close(w, { closureId: 'C3', cutoff: '2026-10-31', target: 'recv-u1-owner' });
    const owner = await w.sub('recv-u1-owner');
    expect(owner.charges).toEqual([
      expect.objectContaining({ description: 'Ekim aidatı', dueDate: '2026-10-10', accrueFrom: '2026-10-31', feeBearing: true }),
      expect.objectContaining({ lateFee: true }),
    ]);
    expect(await w.balanceOf('recv-u1-owner')).toBe(owner.balance);
    expect(await w.balanceOf(MAIN)).toBe(0);
  });

  it('borcun ayni cariye yeni malik adina acilmasi: kesimden sonraki acilis tarihli kalemler gorunur', async () => {
    const w = world();
    await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10', 'Ekim aidatı');
    // Kaynak = hedef (yeni malik devraliyor); acilis yeni malikin baslangic gunu.
    await close(w, { closureId: 'C4', cutoff: '2026-10-31', target: MAIN, openDate: '2026-11-01' });
    const main = await w.sub(MAIN);
    expect(main.cutoff).toBe('2026-10-31');
    expect(main.charges.map((c) => [c.description, c.dueDate, c.amount])).toEqual([
      ['Ekim aidatı', '2026-10-10', TL(1000)],
      ['Gecikme tazminatı (kapama)', '2026-10-31', expect.any(Number)],
    ]);
    expect(main.balance).toBe(await w.balanceOf(MAIN));
  });

  it('kalem toplami satirla tutmazsa (bozuk kayit) satir tek kalem olarak okunur; bakiye korunur', () => {
    const t = txOf({
      kind: 'transfer',
      date: '2026-10-31',
      transfer: { closureId: 'Z', role: 'open', items: [{ sourceChargeId: 'a', category: 'principal', description: 'x', date: '2026-10-01', dueDate: '2026-10-10', amount: toKurus(10) }] },
      lines: [
        { accountId: 'recv-u9-occupant-cZ', side: 'debit', amount: toKurus(99), unitId: 'u9', liableParty: 'occupant' },
        { accountId: CLEARING, side: 'credit', amount: toKurus(99) },
      ],
    });
    const sub = readSubledger(linesOfAccount('recv-u9-occupant-cZ', [t]));
    expect(sub.charges).toEqual([expect.objectContaining({ id: t.transactionId, amount: 99, feeBearing: false })]);
    expect(sub.balance).toBe(99);
  });
});
