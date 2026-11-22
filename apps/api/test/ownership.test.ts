import { describe, expect, it } from 'vitest';
import type { Block, Site } from '../src/modules/core/types.js';
import { bankKeys, lineIdOf } from '../src/modules/finance/bank/keys.js';
import { createBankMatchService } from '../src/modules/finance/bank/matchService.js';
import type { BankLine } from '../src/modules/finance/bank/types.js';
import { FinanceError } from '../src/modules/finance/service.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { createFakeBankRepo } from './fakes/bankRepo.js';
import { coOwnerReceivableId, isCoOwnerReceivableId, isPrimaryReceivableId } from '../src/modules/finance/types.js';
import { allocateSelection, buildQuote } from '../src/modules/payments/quote.js';
import {
  addDays,
  applyMoves,
  buildVotingRoll,
  deriveFromMemberships,
  diffTables,
  effectiveRecord,
} from '../src/modules/ownership/register.js';
import {
  assertCompleteTable,
  isComplete,
  parseShare,
  splitAmountByShares,
  sumShares,
  toBps,
} from '../src/modules/ownership/shares.js';
import type { OwnershipRecord } from '../src/modules/ownership/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { APT, TL, manager, observer, ownershipWorld, unit } from './fakes/ownershipWorld.js';

const half = { numerator: 1, denominator: 2 };
const third = { numerator: 1, denominator: 3 };
const twoThirds = { numerator: 2, denominator: 3 };
const quarter = { numerator: 1, denominator: 4 };
const whole = { numerator: 1, denominator: 1 };

const H = (userId: string) => coOwnerReceivableId('u1', userId);
const resident = (userId: string) => ({ apartmentId: APT, userId, role: 'resident' as const });

// ---------------------------------------------------------------------------
// Saf: pay aritmetigi
// ---------------------------------------------------------------------------

describe('pay aritmetigi (kesir, bps, bolme)', () => {
  it('kesir sadelestirilir ve dogrulanir', () => {
    expect(parseShare({ numerator: 2, denominator: 4 })).toEqual(half);
    expect(() => parseShare({ numerator: 3, denominator: 2 })).toThrow(/paydadan buyuk/);
    expect(() => parseShare({ numerator: 0, denominator: 2 })).toThrow();
    expect(() => parseShare({ numerator: 1.5, denominator: 2 })).toThrow();
  });

  it('tamlik: toplam tam 1 (BigInt rasyonel)', () => {
    expect(isComplete([third, third, third])).toBe(true);
    expect(isComplete([half, third])).toBe(false);
    expect(sumShares([half, third])).toEqual({ numerator: 5, denominator: 6 });
    expect(() => assertCompleteTable([{ userId: 'a', share: half }, { userId: 'b', share: third }])).toThrow(/tam 1/);
    expect(() => assertCompleteTable([{ userId: 'a', share: half }, { userId: 'a', share: half }])).toThrow(/iki kez/);
  });

  it('bps yalnizca gosterim: toplam her zaman 10.000 (1/3 -> 3334 + 3333 + 3333)', () => {
    const bps = toBps([third, third, third]);
    expect(bps).toEqual([3334, 3333, 3333]);
    expect(bps.reduce((s, x) => s + x, 0)).toBe(10_000);
    expect(toBps([{ numerator: 1, denominator: 7 }, { numerator: 6, denominator: 7 }]).reduce((s, x) => s + x, 0)).toBe(10_000);
    expect(toBps([half, quarter, quarter])).toEqual([5000, 2500, 2500]);
  });

  it('tutar paylara kurus kaybi olmadan bolunur', () => {
    const parts = splitAmountByShares(100_001, [
      { userId: 'a', share: third },
      { userId: 'b', share: third },
      { userId: 'c', share: third },
    ]);
    expect(parts.map((p) => p.amount)).toEqual([33_334, 33_334, 33_333]);
    expect(parts.reduce((s, p) => s + p.amount, 0)).toBe(100_001);
    const uneven = splitAmountByShares(100_000, [
      { userId: 'a', share: third },
      { userId: 'b', share: twoThirds },
    ]);
    expect(uneven.map((p) => p.amount)).toEqual([33_333, 66_667]);
  });
});

// ---------------------------------------------------------------------------
// Saf: sicil yorumlama ve devir
// ---------------------------------------------------------------------------

const m = (userId: string, over: Partial<UnitMembership> = {}) =>
  ({ userId, unitId: 'u1', relation: 'owner', residesInUnit: false, status: 'active', startDate: '2026-01-01', ...over }) as UnitMembership;

describe('sicil yorumlama', () => {
  it('uyeliklerden ilk tablo: tek malik paysiz 1/1, eksik pay, toplam 1 degil', () => {
    expect(deriveFromMemberships([m('a')], 'u1', '2026-05-01')).toMatchObject({ status: 'complete', owners: [{ userId: 'a', share: whole }] });
    expect(deriveFromMemberships([m('a', { ownershipShare: half }), m('b')], 'u1', '2026-05-01')).toMatchObject({ status: 'incomplete' });
    const r = deriveFromMemberships([m('a', { ownershipShare: half }), m('b', { ownershipShare: third })], 'u1', '2026-05-01');
    expect(r).toMatchObject({ status: 'incomplete', total: { numerator: 5, denominator: 6 } });
    const ok = deriveFromMemberships([m('b', { ownershipShare: half, startDate: '2026-03-01' }), m('a', { ownershipShare: half })], 'u1', '2026-05-01');
    expect(ok).toMatchObject({ status: 'complete', validFrom: '2026-03-01', owners: [{ userId: 'a' }, { userId: 'b' }] });
    expect(deriveFromMemberships([m('t', { relation: 'tenant', residesInUnit: true })], 'u1', '2026-05-01')).toEqual({ status: 'no_owner' });
  });

  it('gecerli kayit (validFrom, seq) sirasina gore', () => {
    const rec = (seq: number, validFrom: string, userId: string) => ({ unitId: 'u1', seq, validFrom, owners: [{ userId, share: whole }] }) as unknown as OwnershipRecord;
    const list = [rec(1, '2026-01-01', 'a'), rec(2, '2026-06-01', 'b'), rec(3, '2026-06-01', 'c')];
    expect(effectiveRecord(list, 'u1', '2026-05-31')?.owners[0]?.userId).toBe('a');
    expect(effectiveRecord(list, 'u1', '2026-06-01')?.owners[0]?.userId).toBe('c');
    expect(effectiveRecord(list, 'u1', '2025-12-31')).toBeUndefined();
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('kismi devir, tam satis ve miras kurallari', () => {
    const before = [
      { userId: 'a', share: half },
      { userId: 'b', share: half },
    ];
    const after = applyMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: quarter }], 'share_partial');
    expect(after).toEqual([
      { userId: 'a', share: quarter },
      { userId: 'b', share: half },
      { userId: 'c', share: quarter },
    ]);
    expect(diffTables(before, after)).toEqual({ exiting: [], entering: ['c'], changed: ['a'] });
    // Devredilen pay devredenin payini asamaz.
    expect(() => applyMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: twoThirds }], 'share_partial')).toThrow(/asiyor/);
    // Tam satista mevcut malik kalamaz.
    expect(() => applyMoves(before, [{ fromUserId: 'a', toUserId: 'c', share: half }], 'sale_full')).toThrow(/Tam satis/);
    expect(
      applyMoves(before, [
        { fromUserId: 'a', toUserId: 'n', share: half },
        { fromUserId: 'b', toUserId: 'n', share: half },
      ], 'sale_full'),
    ).toEqual([{ userId: 'n', share: whole }]);
    // Miras: tek murisin payinin tamami.
    expect(
      applyMoves(before, [
        { fromUserId: 'a', toUserId: 'h1', share: quarter },
        { fromUserId: 'a', toUserId: 'h2', share: quarter },
      ], 'inheritance'),
    ).toEqual([
      { userId: 'b', share: half },
      { userId: 'h1', share: quarter },
      { userId: 'h2', share: quarter },
    ]);
    expect(() => applyMoves(before, [{ fromUserId: 'a', toUserId: 'h1', share: quarter }], 'inheritance')).toThrow(/tamami/);
    expect(() => applyMoves(before, [{ fromUserId: 'x', toUserId: 'c', share: quarter }], 'share_partial')).toThrow(/malik degil/);
  });

  it('oy listesi: tek malik kendisi, paylida temsilci yoksa "temsilci yok" uyarisi', () => {
    const rec = { unitId: 'u1', seq: 1, validFrom: '2026-01-01', owners: [{ userId: 'a', share: half }, { userId: 'b', share: half }] } as unknown as OwnershipRecord;
    const u2 = unit('u2', '6');
    const roll = buildVotingRoll({ units: [unit('u1'), u2], heads: [], records: [rec], memberships: [m('z', { unitId: 'u2' })], day: '2026-05-01' });
    expect(roll.unitCount).toBe(2);
    const i1 = roll.items.find((i) => i.unitId === 'u1');
    expect(i1).toMatchObject({ vote: 1, source: 'register', landShare: { numerator: 1, denominator: 10 }, warnings: ['temsilci yok'] });
    expect(i1?.representativeUserId).toBeUndefined();
    expect(i1?.owners.map((o) => o.bps)).toEqual([5000, 5000]);
    expect(roll.items.find((i) => i.unitId === 'u2')).toMatchObject({ source: 'memberships', representativeUserId: 'z', warnings: [] });
    const withRep = buildVotingRoll({
      units: [unit('u1')],
      heads: [{ unitId: 'u1', representativeUserId: 'b' } as never],
      records: [rec],
      memberships: [],
      day: '2026-05-01',
    });
    expect(withRep.items[0]).toMatchObject({ representativeUserId: 'b', warnings: [] });
  });

  it('paydas alt carisi kimligi: ana ve ayrilan carilerden ayrisir', () => {
    const id = coOwnerReceivableId('u1', 'user-a');
    expect(id).toMatch(/^recv-u1-owner-h[0-9a-f]{10}$/);
    expect(id).toBe(coOwnerReceivableId('u1', 'user-a'));
    expect(isCoOwnerReceivableId(id, 'u1')).toBe(true);
    expect(isPrimaryReceivableId(id, 'u1', 'owner')).toBe(true);
    expect(isPrimaryReceivableId('recv-u1-owner', 'u1', 'owner')).toBe(true);
    expect(isPrimaryReceivableId('recv-u1-owner-cabc123', 'u1', 'owner')).toBe(false);
    expect(isPrimaryReceivableId(`${id}-cabc123`, 'u1', 'owner')).toBe(false);
    expect(isPrimaryReceivableId(id, 'u1', 'occupant')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Servis: sicil, gecis, faturalama modu
// ---------------------------------------------------------------------------

describe('mulkiyet sicili ve ilk gecis', () => {
  it('backfill: tam bilgili bolum kaydedilir, eksik olan atlanir ve sorun listesinde gorunur', async () => {
    const w = ownershipWorld();
    w.addUnit('u2', '6');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    w.member('x', { unitId: 'u2', ownershipShare: half });
    w.member('y', { unitId: 'u2' });

    const before = await w.ownership.issues(w.ctx);
    expect(before.items.map((i) => `${i.unitId}:${i.code}`).sort()).toEqual(['u1:no_representative', 'u1:not_registered', 'u2:incomplete_shares']);

    const r = await w.ownership.backfill(w.ctx);
    expect(r.created).toEqual([{ unitId: 'u1', owners: 2, validFrom: '2026-01-01' }]);
    expect(r.skipped).toEqual([{ unitId: 'u2', reason: 'Paylı mülkiyette her malikin payı girilmeli' }]);
    expect(w.head()).toMatchObject({ seq: 1, billing: 'joint', currentValidFrom: '2026-01-01', version: 1 });
    expect(w.records()).toHaveLength(1);
    // Tekrar calistirmak guvenli.
    expect((await w.ownership.backfill(w.ctx)).created).toEqual([]);

    const view = await w.ownership.getUnitOwnership(w.ctx, 'u1');
    expect(view).toMatchObject({ registered: true, billing: 'joint', current: { source: 'register', seq: 1 } });
    expect(view.current?.owners.map((o) => o.bps)).toEqual([5000, 5000]);
    expect(view.warnings).toContain('temsilci yok');
  });

  it('elle sicil: eksik hisseli bolum duzeltilir, uyelik paylari ayni yazimda guncellenir', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b');
    await expect(w.ownership.setRegister(w.ctx, 'u1', { owners: [{ userId: 'a', share: half }], validFrom: '2026-01-01', reason: 'tapu kaydi' })).rejects.toThrow(
      /tam 1/,
    );
    await expect(
      w.ownership.setRegister(w.ctx, 'u1', { owners: [{ userId: 'a', share: whole }], validFrom: '2026-01-01', reason: 'tapu kaydi' }),
    ).rejects.toThrow(/eksik: b/);
    const v = await w.ownership.setRegister(w.ctx, 'u1', {
      owners: [
        { userId: 'a', share: third },
        { userId: 'b', share: twoThirds },
      ],
      validFrom: '2026-01-01',
      reason: 'tapu kaydi',
    });
    expect(v.current?.owners.map((o) => [o.userId, o.bps])).toEqual([
      ['a', 3333],
      ['b', 6667],
    ]);
    expect(w.memberOf('a').ownershipShare).toEqual(third);
    expect(w.memberOf('b').ownershipShare).toEqual(twoThirds);
    // Surum korumasi.
    await expect(
      w.ownership.setRegister(w.ctx, 'u1', { owners: [{ userId: 'a', share: half }, { userId: 'b', share: half }], validFrom: '2026-02-01', reason: 'duzeltme', version: 0 }),
    ).rejects.toThrow(/surum/);
  });

  it('sicilli bolumde uyelikten pay degistirilemez; diger alanlar degisebilir', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.ownership.backfill(w.ctx);
    await expect(w.membershipService.update(w.ctx, 'a', 'u1', { version: w.memberOf('a').version, ownershipShare: third })).rejects.toThrow(/mülkiyet sicili/);
    const updated = await w.membershipService.update(w.ctx, 'a', 'u1', { version: w.memberOf('a').version, residesInUnit: true });
    expect(updated.residesInUnit).toBe(true);
    await expect(
      w.membershipService.create(w.ctx, { userId: 'c', unitId: 'u1', relation: 'owner', ownershipShare: quarter, startDate: '2026-09-01' }),
    ).rejects.toThrow(/mülkiyet sicili/);
  });

  it('faturalama moduna gecis: ortak malik carisi bakiyesi sifir olmali', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.charge('k-owner-001', 100, '2026-09-01', '2026-09-10');
    await expect(w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' })).rejects.toThrow(/bakiyesi sıfır değil/);
    await w.finance.recordPayment(w.ctx, { idempotencyKey: 'k-pay-0001', unitId: 'u1', liableParty: 'owner', amount: TL(100), method: 'cash', paidAt: '2026-09-02' });
    const v = await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    expect(v).toMatchObject({ billing: 'split', registered: true });
    // Ilk sicil ayni yazimda olustu.
    expect(w.records()).toHaveLength(1);
    expect(w.head()?.billing).toBe('split');
  });
});

// ---------------------------------------------------------------------------
// joint vs split: tahakkuk, gecikme faizi, portal, online odeme
// ---------------------------------------------------------------------------

describe('joint ve split faturalama', () => {
  it('joint: malik tahakkuku tek ortak cariye yazilir', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: third });
    w.member('b', { ownershipShare: twoThirds });
    await w.ownership.backfill(w.ctx);
    const r = await w.charge('k-joint-001', 1000, '2026-09-01', '2026-09-10');
    expect(r.transaction.lines.filter((l) => l.side === 'debit').map((l) => l.accountId)).toEqual(['recv-u1-owner']);
    expect(w.fake.balanceOf('recv-u1-owner')).toBe(TL(1000));
  });

  it('split: malik tahakkuku sicil paylariyla paydas alt carilerine kurus kaybi olmadan bolunur', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: third });
    w.member('b', { ownershipShare: twoThirds });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    const r = await w.charge('k-split-001', 1000.01, '2026-09-01', '2026-09-10');
    const debits = r.transaction.lines.filter((l) => l.side === 'debit');
    expect(debits.map((l) => [l.accountId, l.amount])).toEqual([
      [H('a'), 33_334],
      [H('b'), 66_667],
    ]);
    expect(r.transaction.totalAmount).toBe(100_001);
    expect(w.fake.balanceOf('recv-u1-owner')).toBe(0);
    expect((await w.acc(H('a')))?.coOwner).toEqual({ userId: 'a' });
    expect(w.fake.trialBalance()).toBe(0);
    // Sakin tarafi bolunmez.
    w.member('t', { relation: 'tenant', residesInUnit: true });
    const occ = await w.charge('k-split-occ1', 500, '2026-09-01', '2026-09-10', 'occupant');
    expect(occ.transaction.lines.filter((l) => l.side === 'debit').map((l) => l.accountId)).toEqual(['recv-u1-occupant']);
    // Daire bakiyesi: paydas carileri malik tarafinda, ayrilan cari degil.
    const bal = await w.finance.getUnitBalance(w.ctx, 'u1');
    expect(bal.owner.balance).toBe(100_001);
    expect(bal.coOwners?.map((c) => [c.userId, c.balance])).toEqual([
      ['a', 33_334],
      ['b', 66_667],
    ]);
    expect(bal.former).toBeUndefined();
    // Aidat durumu raporu malik tarafinda toplar.
    const status = await w.finance.duesStatus(w.ctx);
    expect(status.items[0]?.owner.balance).toBe(100_001);
    expect(status.items[0]?.former).toBeUndefined();
  });

  it('split: bos daire kuraliyla malike dusen sakin gideri de bolunur', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    const r = await w.charge('k-vacant-01', 200, '2026-09-01', '2026-09-10', 'occupant');
    expect(r.vacant).toBe(true);
    expect(r.transaction.lines.filter((l) => l.side === 'debit').map((l) => [l.accountId, l.amount])).toEqual([
      [H('a'), TL(100)],
      [H('b'), TL(100)],
    ]);
  });

  it('split: gecikme faizi paydas carisi basina islenir', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    await w.charge('k-lf-00001', 1000, '2026-09-01', '2026-09-05');
    // a kendi payini oder; b odemez.
    await w.finance.recordPayment(w.ctx, { idempotencyKey: 'k-lf-pay01', unitId: 'u1', accountId: H('a'), amount: TL(500), method: 'cash', paidAt: '2026-09-03' });
    w.setNow('2026-10-01');
    const r = await w.finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 5 });
    expect(r.items.map((i) => i.accountId)).toEqual([H('b')]);
    expect(r.items[0]?.amount).toBeGreaterThan(0);
  });

  it('split: portal paydasa yalnizca kendi carisini gosterir; online odeme paydas carisine yazilir', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: third });
    w.member('b', { ownershipShare: twoThirds });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    await w.charge('k-portal-01', 300, '2026-09-01', '2026-09-30');

    const data = await w.portal.getPayableLedgers(resident('a'));
    expect(data.ledgers).toHaveLength(1);
    expect(data.ledgers[0]).toMatchObject({ party: 'owner', accountId: H('a') });
    const quote = buildQuote({ ledgers: data.ledgers, txById: data.txById, today: data.today, lateFeeMonthlyBasisPoints: data.lateFeeMonthlyBasisPoints });
    expect(quote.totalDue).toBe(TL(100));
    const sel = allocateSelection(quote, { mode: 'total' });
    expect(sel.allocations).toMatchObject([{ liableParty: 'owner', accountId: H('a'), amount: TL(100) }]);

    // Niyet belgesi (surumlu) ve online tahsilat.
    w.fake.docs.set(`APT#${APT}|PI#intent-1`, { PK: `APT#${APT}`, SK: 'PI#intent-1', entityType: 'PAYMENT_INTENT', version: 1 });
    const paid = await w.finance.recordOnlinePayment(w.ctx, {
      intentId: 'intent-1',
      unitId: 'u1',
      paidAt: '2026-09-02',
      provider: 'fake',
      providerPaymentId: 'p-1',
      allocations: sel.allocations.map((a) => ({ liableParty: a.liableParty, ...(a.accountId ? { accountId: a.accountId } : {}), amount: a.amount, lateFee: a.lateFee })),
      intentUpdate: () => ({
        item: { PK: `APT#${APT}`, SK: 'PI#intent-1', version: 2 },
        expectedVersion: 1,
        label: 'intent',
      }),
    });
    expect(paid.payments[0]?.receivableAccountId).toBe(H('a'));
    expect(w.fake.balanceOf(H('a'))).toBe(0);
    expect(w.fake.balanceOf(H('b'))).toBe(TL(200));

    // Makbuz yalnizca odeyen paydasa gorunur.
    expect((await w.portal.getMyReceipts(resident('a'))).items).toHaveLength(1);
    expect((await w.portal.getMyReceipts(resident('b'))).items).toHaveLength(0);
    const sumB = await w.portal.getMySummary(resident('b'));
    expect(sumB).toBeDefined();
    const dataB = await w.portal.getPayableLedgers(resident('b'));
    expect(buildQuote({ ledgers: dataB.ledgers, txById: dataB.txById, today: dataB.today, lateFeeMonthlyBasisPoints: 0 }).totalDue).toBe(TL(200));
  });

  it('online odeme: hedef cari dairenin guncel alt carisi olmali', async () => {
    const w = ownershipWorld();
    w.member('a');
    await expect(
      w.finance.recordOnlinePayment(w.ctx, {
        intentId: 'intent-x',
        unitId: 'u1',
        paidAt: '2026-09-02',
        provider: 'fake',
        providerPaymentId: 'p-x',
        allocations: [{ liableParty: 'owner', accountId: 'recv-u1-owner-cabc123', amount: TL(10), lateFee: TL(0) }],
        intentUpdate: () => ({ item: { PK: `APT#${APT}`, SK: 'PI#intent-x', version: 2 }, expectedVersion: 1, label: 'intent' }),
      }),
    ).rejects.toThrow(/guncel alt carisi/);
  });
});

// ---------------------------------------------------------------------------
// Mulk / hisse devri
// ---------------------------------------------------------------------------

describe('mulk ve hisse devri', () => {
  it('joint kismi devir: sicil ve uyelikler degisir, cari degismez; geri alinir', async () => {
    const w = ownershipWorld('2026-10-15');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.charge('k-pj-0001', 1000, '2026-09-01', '2026-09-10');

    const preview = await w.ownership.previewTransfer(w.ctx, 'u1', {
      kind: 'share_partial',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
    });
    expect(preview).toMatchObject({ entering: ['c'], exiting: [], changed: ['a'], closures: [] });
    expect(preview.after.map((o) => [o.userId, o.bps])).toEqual([
      ['a', 2500],
      ['b', 5000],
      ['c', 2500],
    ]);

    const { transfer, replayed } = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-partial-1',
      kind: 'share_partial',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      reason: 'kismi satis tapu',
    });
    expect(replayed).toBe(false);
    expect(transfer).toMatchObject({ initialSeq: 1, recordSeq: 2, closures: [], billing: 'joint' });
    expect(w.records().map((r) => [r.seq, r.validFrom, r.source])).toEqual([
      [1, '2026-01-01', 'backfill'],
      [2, '2026-10-01', 'transfer'],
    ]);
    expect(w.memberOf('a').ownershipShare).toEqual(quarter);
    expect(w.memberOf('c')).toMatchObject({ relation: 'owner', startDate: '2026-10-01', ownershipShare: quarter, status: 'active' });
    expect(w.fake.balanceOf('recv-u1-owner')).toBe(TL(1000));

    // Idempotency: ayni anahtar ayni govde -> replay; farkli govde -> 409.
    const again = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-partial-1',
      kind: 'share_partial',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      reason: 'kismi satis tapu',
    });
    expect(again.replayed).toBe(true);
    await expect(
      w.ownership.createTransfer(w.ctx, 'u1', {
        idempotencyKey: 'xfer-partial-1',
        kind: 'share_partial',
        effectiveDate: '2026-10-02',
        moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
        reason: 'kismi satis tapu',
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    // Ayni gun veya oncesine yeni devir yazilamaz.
    await expect(
      w.ownership.createTransfer(w.ctx, 'u1', {
        idempotencyKey: 'xfer-early-01',
        kind: 'share_partial',
        effectiveDate: '2026-10-01',
        moves: [{ fromUserId: 'b', toUserId: 'c', share: quarter }],
        reason: 'erken devir',
      }),
    ).rejects.toThrow(/son sicil kaydından/);

    const rev = await w.ownership.reverseTransfer(w.ctx, transfer.transferId, { reason: 'yanlis giris' });
    expect(rev.status).toBe('reversed');
    expect(w.records().at(-1)).toMatchObject({ seq: 3, source: 'reversal', owners: [{ userId: 'a', share: half }, { userId: 'b', share: half }] });
    expect(w.memberOf('a').ownershipShare).toEqual(half);
    expect(w.memberOf('c').status).toBe('inactive');
    await expect(w.ownership.reverseTransfer(w.ctx, transfer.transferId, { reason: 'ikinci kez' })).rejects.toThrow(/zaten/);
  });

  it('split: paydasin tam cikisi yalnizca onun alt carisini kapatir (ayrilan carisi); geri alinir', async () => {
    const w = ownershipWorld('2026-09-01');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    await w.charge('k-ex-00001', 1000, '2026-09-01', '2026-09-30');
    w.setNow('2026-10-15');

    const { transfer, warnings } = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-exit-001',
      kind: 'share_partial',
      effectiveDate: '2026-10-10',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: half }],
      reason: 'payini satti',
    });
    expect(warnings.some((x) => x.includes('Kısmi devirde'))).toBe(true);
    expect(transfer.closures).toHaveLength(1);
    const c = transfer.closures[0]!;
    expect(c).toMatchObject({ userIds: ['a'], sourceAccountId: H('a'), debtTo: 'former' });
    expect(c.targetAccountId).toBe(`${H('a')}-c${c.closureId}`);
    expect(c.lateFee).toBeGreaterThan(0);
    expect(c.debt).toBe(TL(500) + c.lateFee);
    expect(w.fake.balanceOf(H('a'))).toBe(0);
    expect((await w.acc(H('a')))?.closedThrough).toBe('2026-10-09');
    expect(w.fake.balanceOf(c.targetAccountId as string)).toBe(c.debt);
    expect(w.fake.balanceOf(H('b'))).toBe(TL(500));
    expect(w.memberOf('a').endDate).toBe('2026-10-09');
    expect(w.memberOf('c')).toMatchObject({ startDate: '2026-10-10', ownershipShare: half });
    // Kapama kaydi devre bagli; tek basina geri alinamaz.
    const closure = w.closureDocs().find((d) => d.closureId === c.closureId)!;
    expect(closure.ownershipTransferId).toBe(transfer.transferId);
    await expect(w.closures.reverse(w.ctx, c.closureId, { reason: 'tek basina' })).rejects.toThrow(/devri geri alin/);
    // Ayrilan cari raporda ayri, daire malik tarafinda degil.
    const bal = await w.finance.getUnitBalance(w.ctx, 'u1');
    expect(bal.former?.map((f) => f.accountId)).toEqual([c.targetAccountId]);
    expect(bal.owner.balance).toBe(TL(500));

    // Devirden sonraki tahakkuk yeni paylarla (b, c).
    const next = await w.charge('k-ex-00002', 100, '2026-10-15', '2026-10-30');
    expect(next.transaction.lines.filter((l) => l.side === 'debit').map((l) => l.accountId)).toEqual([H('b'), H('c')]);

    const rev = await w.ownership.reverseTransfer(w.ctx, transfer.transferId, { reason: 'satis iptal' });
    expect(rev.reversal?.transactionIds.length).toBeGreaterThanOrEqual(2);
    expect(w.fake.balanceOf(c.targetAccountId as string)).toBe(0);
    expect(w.fake.balanceOf(H('a'))).toBe(TL(500) + c.lateFee);
    expect((await w.acc(H('a')))?.closedThrough).toBeUndefined();
    expect(w.memberOf('a').endDate).toBeUndefined();
    expect(w.memberOf('c').status).toBe('inactive');
    expect(w.closureDocs().find((d) => d.closureId === c.closureId)?.status).toBe('reversed');
    expect(w.fake.trialBalance()).toBe(0);
  });

  it('split: borc yeni malike (devralanin alt carisine) devredilebilir; payi birden cok kisiye giderse reddedilir', async () => {
    const w = ownershipWorld('2026-09-01');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
    await w.charge('k-no-00001', 400, '2026-09-01', '2026-09-30');
    w.setNow('2026-10-20');
    await expect(
      w.ownership.createTransfer(w.ctx, 'u1', {
        idempotencyKey: 'xfer-newown-0',
        kind: 'share_partial',
        effectiveDate: '2026-10-10',
        moves: [
          { fromUserId: 'a', toUserId: 'c', share: quarter },
          { fromUserId: 'a', toUserId: 'd', share: quarter },
        ],
        debtTo: 'new_owner',
        reason: 'iki aliciya satis',
      }),
    ).rejects.toThrow(/tek bir kişiye/);

    const { transfer } = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-newown-1',
      kind: 'share_partial',
      effectiveDate: '2026-10-10',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: half }],
      debtTo: 'new_owner',
      reason: 'borcuyla birlikte satis',
    });
    const c = transfer.closures[0]!;
    expect(c).toMatchObject({ debtTo: 'new_owner', targetAccountId: H('c') });
    expect(w.fake.balanceOf(H('c'))).toBe(c.debt);
    expect((await w.acc(H('c')))?.coOwner).toEqual({ userId: 'c' });
    // Devralanin portalinda devreden borc kalemleri orijinal vadesiyle gorunur.
    const data = await w.portal.getPayableLedgers(resident('c'));
    expect(data.ledgers[0]?.accountId).toBe(H('c'));
  });

  it('joint tam satis: ortak cari kapanir, borc ayni cariye yeni malik adina acilir', async () => {
    const w = ownershipWorld('2026-09-01');
    w.member('o');
    await w.charge('k-sf-00001', 300, '2026-09-01', '2026-09-10');
    w.setNow('2026-10-05');
    const { transfer } = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-salefull1',
      kind: 'sale_full',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'o', toUserId: 'n', share: whole }],
      debtTo: 'new_owner',
      residents: ['n'],
      reason: 'tapu satisi',
    });
    expect(transfer.closures).toHaveLength(1);
    const c = transfer.closures[0]!;
    expect(c).toMatchObject({ sourceAccountId: 'recv-u1-owner', targetAccountId: 'recv-u1-owner', debtTo: 'new_owner' });
    expect((await w.acc('recv-u1-owner'))?.closedThrough).toBe('2026-09-30');
    expect(w.fake.balanceOf('recv-u1-owner')).toBe(TL(300) + c.lateFee);
    expect(w.memberOf('o').endDate).toBe('2026-09-30');
    expect(w.memberOf('n')).toMatchObject({ startDate: '2026-10-01', ownershipShare: whole, residesInUnit: true });
    expect(w.records().at(-1)?.owners).toEqual([{ userId: 'n', share: whole }]);
    // Kilitli doneme kayit yazilamaz.
    await expect(w.charge('k-sf-00002', 10, '2026-09-15', '2026-09-20')).rejects.toBeInstanceOf(FinanceError);
  });

  it('joint: borcun yeni malike devri yalnizca tum malikler cikarken secilebilir', async () => {
    const w = ownershipWorld('2026-10-05');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    await expect(
      w.ownership.createTransfer(w.ctx, 'u1', {
        idempotencyKey: 'xfer-jnew-001',
        kind: 'share_partial',
        effectiveDate: '2026-10-01',
        moves: [{ fromUserId: 'a', toUserId: 'c', share: half }],
        debtTo: 'new_owner',
        reason: 'gecersiz secim',
      }),
    ).rejects.toThrow(/tüm malikler/);
  });

  it('miras: murisin payi mirascilara gecer; joint caride kapama yok, uyari var', async () => {
    const w = ownershipWorld('2026-10-05');
    w.member('d', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    const { transfer, warnings } = await w.ownership.createTransfer(w.ctx, 'u1', {
      idempotencyKey: 'xfer-inherit1',
      kind: 'inheritance',
      effectiveDate: '2026-10-01',
      moves: [
        { fromUserId: 'd', toUserId: 'h1', share: quarter },
        { fromUserId: 'd', toUserId: 'h2', share: quarter },
      ],
      reason: 'veraset ilami',
    });
    expect(transfer.after).toEqual([
      { userId: 'b', share: half },
      { userId: 'h1', share: quarter },
      { userId: 'h2', share: quarter },
    ]);
    expect(transfer.closures).toEqual([]);
    expect(warnings.some((x) => x.includes('Ortak malik carisinde'))).toBe(true);
    expect(w.memberOf('d').endDate).toBe('2026-09-30');
    expect(w.memberOf('h1')).toMatchObject({ ownershipShare: quarter, startDate: '2026-10-01' });
  });

  it('dogrulamalar: eksik hisse, gelecek tarih, kiraci kaydi olan devralan', async () => {
    const w = ownershipWorld('2026-10-05');
    w.member('a', { ownershipShare: half });
    w.member('b');
    const body = (over: Record<string, unknown> = {}) => ({
      idempotencyKey: 'xfer-valid-01',
      kind: 'share_partial',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      reason: 'dogrulama',
      ...over,
    });
    await expect(w.ownership.createTransfer(w.ctx, 'u1', body())).rejects.toThrow(/hisse bilgisi eksik/);
    await w.ownership.setRegister(w.ctx, 'u1', { owners: [{ userId: 'a', share: half }, { userId: 'b', share: half }], validFrom: '2026-01-01', reason: 'tapu kaydi', version: 0 });
    await expect(w.ownership.createTransfer(w.ctx, 'u1', body({ effectiveDate: '2026-11-01' }))).rejects.toThrow(/bugünden sonra/);
    w.member('c', { relation: 'tenant', residesInUnit: true, startDate: '2026-02-01' });
    await expect(w.ownership.createTransfer(w.ctx, 'u1', body())).rejects.toThrow(/başka türde/);
  });
});

// ---------------------------------------------------------------------------
// Temsilci, oy listesi ve HTTP
// ---------------------------------------------------------------------------

describe('temsilci, oy listesi ve API', () => {
  it('temsilci secilmemisse "temsilci yok"; secilince oy listesinde temsilci', async () => {
    const w = ownershipWorld();
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    let roll = await w.ownership.votingRoll(w.ctx);
    expect(roll.items[0]).toMatchObject({ warnings: ['temsilci yok'] });
    await expect(w.ownership.setRepresentative(w.ctx, 'u1', { userId: 'x' })).rejects.toThrow(/paydaslarindan/);
    await w.ownership.setRepresentative(w.ctx, 'u1', { userId: 'b' });
    roll = await w.ownership.votingRoll(w.ctx);
    expect(roll.items[0]).toMatchObject({ representativeUserId: 'b', warnings: [], source: 'register' });
    expect(w.head()?.version).toBe(1);
  });

  it('HTTP: observer okur, yazamaz; yonetici devir yapar', async () => {
    const w = ownershipWorld('2026-10-05');
    w.member('a', { ownershipShare: half });
    w.member('b', { ownershipShare: half });
    const get = await w.call('GET', '/api/ownership/units/u1', observer);
    expect(get.status).toBe(200);
    expect(get.json.current.owners).toHaveLength(2);
    const body = {
      idempotencyKey: 'xfer-http-0001',
      kind: 'share_partial',
      effectiveDate: '2026-10-01',
      moves: [{ fromUserId: 'a', toUserId: 'c', share: quarter }],
      reason: 'http devir',
    };
    expect((await w.call('POST', '/api/ownership/units/u1/transfers', observer, body)).status).toBe(403);
    const pv = await w.call('POST', '/api/ownership/units/u1/transfers/preview', manager, body);
    expect(pv.status).toBe(200);
    const created = await w.call('POST', '/api/ownership/units/u1/transfers', manager, body);
    expect(created.status).toBe(201);
    expect(created.json.transfer.PK).toBeUndefined();
    const replay = await w.call('POST', '/api/ownership/units/u1/transfers', manager, body);
    expect(replay.status).toBe(200);
    expect((await w.call('GET', '/api/ownership/units/u1/transfers', observer)).json.items).toHaveLength(1);
    expect((await w.call('GET', '/api/ownership/voting-roll', observer)).status).toBe(200);
    expect((await w.call('GET', '/api/ownership/issues', observer)).status).toBe(200);
    const bad = await w.call('POST', '/api/ownership/units/u1/transfers', manager, { ...body, idempotencyKey: 'xfer-http-0002', moves: [] });
    expect(bad.status).toBe(400);
    expect((await w.call('POST', `/api/ownership/transfers/${created.json.transfer.transferId}/reverse`, manager, { reason: 'geri al' })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Banka eslestirmesi ve bildirimler (split bolum)
// ---------------------------------------------------------------------------

async function splitWorld() {
  const w = ownershipWorld('2026-09-01');
  w.member('a', { ownershipShare: half });
  w.member('b', { ownershipShare: half });
  await w.ownership.setBilling(w.ctx, 'u1', { mode: 'split', reason: 'paydaslar ayri' });
  return w;
}

describe('banka eslestirmesi: split bolumde paydas carisi', () => {
  async function bankWorld() {
    const w = await splitWorld();
    await w.charge('k-bank-0001', 200, '2026-09-01', '2026-09-30');
    const bank = createFakeBankRepo(w.fake.docs as unknown as Map<string, Record<string, unknown>>);
    const core = {
      getSite: async () => ({ siteId: APT, settings: { lateFeeMonthlyBasisPoints: 500 } }) as unknown as Site,
      getUnit: async (_a: string, id: string) => w.units.find((u) => u.unitId === id),
      listUnits: async () => w.units,
      listBlocks: async () => [{ blockId: 'b1', name: 'A Blok', status: 'active' }] as unknown as Block[],
    };
    const match = createBankMatchService({
      repo: bank.repo,
      finance: w.finance,
      accounts: w.fake.repo,
      ledger: w.portalRepo,
      core,
      memberships: { list: async (apt: string) => w.memberships.list(apt, {}) },
      people: {
        list: async () =>
          [
            { userId: 'a', fullName: 'Ayşe Yılmaz' },
            { userId: 'b', fullName: 'Bora Kaya' },
          ] as never,
      },
      portal: w.portal,
      ownership: w.reader,
      documents: undefined,
      now: w.now,
    });
    const seedLine = (fp: string, over: Partial<BankLine> = {}): BankLine => {
      const date = over.date ?? '2026-09-02';
      const l = {
        ...bankKeys.line(APT, 'bank', date, fp),
        entityType: 'BANK_LINE',
        lineId: lineIdOf(date, fp),
        apartmentId: APT,
        bankAccountId: 'bank',
        statementId: '20260902-00000000-0000-4000-8000-00000000aaaa',
        sourceRow: 5,
        date,
        direction: 'in',
        amount: TL(100),
        description: 'HAVALE AIDAT ODEMESI',
        counterpartyName: 'AYŞE YILMAZ',
        fingerprint: fp,
        fingerprintVersion: 1,
        status: 'unmatched',
        createdAt: '2026-09-02T09:00:00.000Z',
        createdBy: 'mgr-1',
        version: 1,
        ...over,
      } as unknown as BankLine;
      bank.items.set(`${l.PK}|${l.SK}`, structuredClone(l) as unknown as Record<string, unknown>);
      return l;
    };
    return { w, match, bank, seedLine };
  }
  const mctx = { apartmentId: APT, userId: 'mgr-1', role: 'apartment_manager' as const };

  it('adaylar: paydas carileri sahipleriyle, bakiyesiz ortak malik carisi onerilmez', async () => {
    const { match } = await bankWorld();
    const { items } = await match.targets(mctx);
    const owners = items.filter((i) => i.liableParty === 'owner');
    expect(owners.map((i) => i.accountId).sort()).toEqual([H('a'), H('b')].sort());
    const a = owners.find((i) => i.accountId === H('a'));
    expect(a).toMatchObject({ partyLabel: 'Kat maliki (paydaş)', former: false, holderNames: ['Ayşe Yılmaz'], openBalance: TL(100) });
  });

  it('oneri ve eslestirme paydas carisine yazilir; portal referans kodu paydas carisine aittir', async () => {
    const { w, match, seedLine } = await bankWorld();
    const l = seedLine('a'.repeat(24));
    const sug = await match.suggestions(mctx, l.lineId, { bankAccountId: 'bank' });
    expect(sug.suggestions[0]?.allocations.map((x) => x.accountId)).toEqual([H('a')]);
    await match.match(mctx, l.lineId, { bankAccountId: 'bank', expectedVersion: 1, allocations: [{ accountId: H('a'), amount: TL(100) }] });
    expect(w.fake.balanceOf(H('a'))).toBe(0);
    expect(w.fake.balanceOf(H('b'))).toBe(TL(100));
    const pay = [...w.fake.payments.values()][0];
    expect(pay?.receivableAccountId).toBe(H('a'));
    // Makbuz yalnizca paydasa.
    expect((await w.portal.getMyReceipts(resident('a'))).items).toHaveLength(1);
    expect((await w.portal.getMyReceipts(resident('b'))).items).toHaveLength(0);

    const ref = await match.paymentReference(resident('b'));
    expect(ref.references).toHaveLength(1);
    const targets = await match.targets(mctx);
    expect(targets.items.find((i) => i.accountId === H('b'))?.refCode).toBe(ref.references[0]?.code);
  });
});

describe('bildirimler: split bolumde paydasa ozel tutar', () => {
  const day = '2026-09-11';

  it('tahakkuk olayi paydas kalemlerine acilir; her paydas yalnizca kendi payini alir', async () => {
    const w = await splitWorld();
    await w.charge('k-ntf-0001', 300.01, '2026-09-01', '2026-09-10');
    const ev = w.fake.events('DUE_GENERATED').at(-1)!;
    expect(ev.payload.items.map((i) => [i.userId, i.amount])).toEqual([
      ['a', 15_001],
      ['b', 15_000],
    ]);
    const members = await w.memberships.list(APT, {});
    const notes = buildNotifications(ev, members, new Map(), day);
    expect(notes.map((n) => [n.userId, n.data.amount]).sort()).toEqual([
      ['a', 15_001],
      ['b', 15_000],
    ]);
  });

  it('toplu tahakkuk ozeti paydas basina', async () => {
    const w = await splitWorld();
    await w.finance.chargeBulk(w.ctx, {
      idempotencyKey: 'k-bulk-0001',
      liableParty: 'owner',
      totalAmount: TL(100),
      distributionKey: 'equal',
      date: '2026-09-01',
      dueDate: '2026-09-10',
      description: 'Demirbas',
    });
    const ev = w.fake.events('DUES_BATCH_SUMMARY').at(-1)!;
    expect(ev.payload.items.map((i) => [i.userId, i.amount])).toEqual([
      ['a', TL(50)],
      ['b', TL(50)],
    ]);
    const notes = buildNotifications(ev, await w.memberships.list(APT, {}), new Map(), day);
    expect(notes.map((n) => [n.userId, n.data.total]).sort()).toEqual([
      ['a', TL(50)],
      ['b', TL(50)],
    ]);
  });

  it('borc hatirlatmasi ve gecikme tazminati olaylari paydas carilerini kapsar', async () => {
    const w = await splitWorld();
    await w.charge('k-rem-0001', 200, '2026-09-01', '2026-09-10');
    await w.finance.recordPayment(w.ctx, { idempotencyKey: 'k-rem-pay1', unitId: 'u1', accountId: H('a'), amount: TL(100), method: 'cash', paidAt: '2026-09-05' });
    const reminders = await w.finance.dueReminders(APT, day);
    expect(reminders).toEqual([{ unitId: 'u1', liableParty: 'owner', kind: 'overdue_1', dueDate: '2026-09-10', amount: TL(100), userId: 'b' }]);
    const notes = buildNotifications(
      {
        eventId: 'DUES_REMINDER:x',
        type: 'DUES_REMINDER',
        version: 1,
        occurredAt: '2026-09-11T06:00:00.000Z',
        apartmentId: APT,
        actorId: 'system',
        groupKey: APT,
        payload: { date: day, items: reminders.map((r) => ({ ...r, amount: TL(r.amount / 100) })) },
      },
      await w.memberships.list(APT, {}),
      new Map(),
      day,
    );
    expect(notes.map((n) => n.userId)).toEqual(['b']);

    w.setNow('2026-10-01');
    await w.finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    const lf = w.fake.events('LATE_FEE_POSTED');
    expect(lf.flatMap((e) => e.payload.items.map((i) => i.userId))).toEqual(['b']);
  });
});
