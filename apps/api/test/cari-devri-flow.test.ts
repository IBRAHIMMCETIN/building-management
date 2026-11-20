/**
 * Cari devri - Asama 3: ayrilan cariden tahsilat, raporlar ve sakin tarafinda ayrim (uctan uca).
 *
 * Senaryo: kiraci A 31 Ekim'de cikar (borc ayrilan sakin carisine), kiraci B 1 Kasim'da girer.
 */
import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../src/events/publisher.js';
import { buildQuote } from '../src/modules/payments/quote.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { APT, MAIN, RATE, TL, cariWorld, manager, observer } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;

async function moveOutAndIn(w: W) {
  w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
  await w.charge('k-sep', 1000, '2026-09-01', '2026-09-10');
  await w.pay('p-sep', 400, '2026-09-20');
  await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
  w.setNow('2026-11-02');
  const closed = await w.call('POST', '/api/finance/units/u1/closures', manager, {
    idempotencyKey: 'close-0001',
    party: 'occupant',
    moveOutDate: '2026-10-31',
    userIds: ['tenant-a'],
    reason: 'Kiracı taşındı',
  });
  expect(closed.status).toBe(201);
  w.member('tenant-b', { relation: 'tenant', startDate: '2026-11-01' });
  await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10');
  return closed.json.closure as { closureId: string; targetAccountId: string; debt: number };
}

const payBody = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'pay-former-1',
  unitId: 'u1',
  amount: TL(300),
  method: 'cash',
  paidAt: '2026-11-03',
  payerName: 'Ayşe (eski kiracı)',
  ...over,
});

describe('ayrilan cariden tahsilat', () => {
  it('accountId ile: makbuz kesilir, ayrilan cari azalir, ana cari ve yeni kiraci etkilenmez', async () => {
    const w = cariWorld();
    const c = await moveOutAndIn(w);
    w.setNow('2026-11-03');
    const r = await w.call('POST', '/api/finance/payments', manager, payBody({ accountId: c.targetAccountId }));
    expect(r.status).toBe(201);
    expect(r.json.payment).toMatchObject({
      unitId: 'u1',
      liableParty: 'occupant',
      receivableAccountId: c.targetAccountId,
      receiptNumber: 'MKB-000002',
      amount: TL(300),
    });
    expect(r.json.transaction.description).toBe('Tahsilat - Daire 5 (ayrılan sakin)');
    expect((await w.acc(c.targetAccountId))!.balance).toBe(c.debt - TL(300));
    expect((await w.acc(MAIN))!.balance).toBe(TL(1000));

    // Ayni anahtar ayni sonuc; ana cariye ayni anahtarla farkli istek 409.
    expect((await w.call('POST', '/api/finance/payments', manager, payBody({ accountId: c.targetAccountId }))).status).toBe(200);
    expect((await w.call('POST', '/api/finance/payments', manager, payBody({ liableParty: 'occupant' }))).status).toBe(409);
  });

  it('dogrulama: baska dairenin / taraf uyusmayan / alacak olmayan hesap reddedilir; ana cari kimligi normal tahsilattir', async () => {
    const w = cariWorld();
    const c = await moveOutAndIn(w);
    const post = (over: Record<string, unknown>) => w.call('POST', '/api/finance/payments', manager, payBody({ idempotencyKey: `pay-${Math.random().toString(36).slice(2, 10)}`, ...over }));
    expect((await post({ accountId: 'cash' })).json.field).toBe('accountId');
    expect((await post({ accountId: 'yok-hesap' })).json.field).toBe('accountId');
    expect((await post({ accountId: c.targetAccountId, unitId: 'u2' })).json.field).toBe('accountId');
    expect((await post({ accountId: c.targetAccountId, liableParty: 'owner' })).json.field).toBe('liableParty');
    expect((await post({})).json.field).toBe('liableParty');
    const main = await post({ accountId: MAIN, paidAt: '2026-11-02' });
    expect(main.status).toBe(201);
    expect(main.json.payment.receivableAccountId).toBeUndefined();
  });

  it('bildirim: ayrilan cariye tahsilat dairenin bugunku sakinine gitmez', () => {
    const base = { eventId: 'e1', apartmentId: APT, occurredAt: '2026-11-03T10:00:00Z', actorId: 'mgr-1', groupKey: 'u1' };
    const payload = { paymentId: 'p', transactionId: 't', receiptNumber: 'MKB-1', unitId: 'u1', liableParty: 'occupant' as const, amount: TL(300), method: 'cash', paidAt: '2026-11-03' };
    const tenantB = {
      PK: 'x',
      SK: 'y',
      entityType: 'UNIT_MEMBERSHIP' as const,
      userId: 'tenant-b',
      apartmentId: APT,
      unitId: 'u1',
      relation: 'tenant' as const,
      residesInUnit: true,
      status: 'active' as const,
      startDate: '2026-11-01',
      createdAt: '',
      createdBy: '',
      updatedAt: '',
      updatedBy: '',
      version: 1,
    };
    const ev = (p: object) => ({ ...base, type: 'PAYMENT_RECEIVED', payload: p }) as unknown as DomainEvent;
    expect(buildNotifications(ev(payload), [tenantB], new Map(), '2026-11-03')).toHaveLength(1);
    expect(buildNotifications(ev({ ...payload, receivableAccountId: 'recv-u1-occupant-cX' }), [tenantB], new Map(), '2026-11-03')).toEqual([]);
  });
});

describe('sakin tarafinda ayrim (portal + online odeme teklifi)', () => {
  it('yeni kiraci yalnizca kendi borcunu, tazminatini ve makbuzlarini gorur; eski kiracinin erisimi kapanir', async () => {
    const w = cariWorld();
    const c = await moveOutAndIn(w);
    w.setNow('2026-11-03');
    await w.call('POST', '/api/finance/payments', manager, payBody({ accountId: c.targetAccountId }));
    w.setNow('2026-11-20');
    const b = { apartmentId: APT, userId: 'tenant-b', role: 'resident' as const };

    const summary = await w.portal.getMySummary(b);
    // Yalnizca Kasim aidati; tazminat 10 Kasim -> 20 Kasim (10 gun): 1000 x %5 x 10/30
    expect(summary).toMatchObject({
      debt: TL(1000),
      totalCharged: TL(1000),
      totalPaid: 0,
      accruedLateFee: TL(1000 * 0.05 * 10 / 30),
      oldestOverdueDueDate: '2026-11-10',
      openCount: 1,
    });
    expect(summary.lastPayment).toBeUndefined();

    const dues = await w.portal.getMyDues(b);
    expect(dues.items.map((i) => [i.description, i.remaining])).toEqual([['Aidat 2026-11', TL(1000)]]);
    expect((await w.portal.getMyReceipts(b)).items).toEqual([]);
    const statement = await w.portal.getMyStatement(b);
    expect(JSON.stringify(statement)).not.toMatch(/Cari kapama|Devreden|ayrılan/);

    const payable = await w.portal.getPayableLedgers(b);
    const quote = buildQuote({
      ledgers: payable.ledgers.map((l) => ({ party: l.party, entries: l.entries })),
      txById: payable.txById,
      today: payable.today,
      lateFeeMonthlyBasisPoints: payable.lateFeeMonthlyBasisPoints,
    });
    expect(quote.totalDue).toBe(TL(1000) + TL(1000 * 0.05 * 10 / 30));
    expect(quote.parties[0]!.items.map((i) => i.description)).toEqual(['Aidat 2026-11']);

    // Eski kiraci: uyeligi 31 Ekim'de bitti.
    await expect(w.portal.getMySummary({ apartmentId: APT, userId: 'tenant-a', role: 'resident' as const })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('cikis gunu eski kiracinin ekraninda borc kapanmis gorunur (devredildi)', async () => {
    const w = cariWorld();
    await moveOutAndIn(w);
    w.setNow('2026-10-31');
    const a = await w.portal.getMySummary({ apartmentId: APT, userId: 'tenant-a', role: 'resident' as const });
    expect(a).toMatchObject({ balance: 0, debt: 0, openCount: 0, accruedLateFee: 0 });
  });
});

describe('raporlar: ayrilan cariler', () => {
  it('former-accounts: sahip, donem, bakiye, gecikme ve son tahsilat; ozet ve aidat durumu ayrimi', async () => {
    const w = cariWorld();
    const c = await moveOutAndIn(w);
    w.setNow('2026-11-03');
    await w.call('POST', '/api/finance/payments', manager, payBody({ accountId: c.targetAccountId }));
    w.setNow('2026-11-20');

    const r = await w.call('GET', '/api/finance/former-accounts', observer);
    expect(r.status).toBe(200);
    expect(r.json.items).toEqual([
      expect.objectContaining({
        accountId: c.targetAccountId,
        unitId: 'u1',
        unitNumber: '5',
        liableParty: 'occupant',
        closureId: c.closureId,
        holder: { userIds: ['tenant-a'], periodStart: '2026-03-01', periodEnd: '2026-10-31' },
        balance: c.debt - TL(300),
        debt: c.debt - TL(300),
        oldestUnpaidDueDate: '2026-09-10',
        lastPaymentDate: '2026-11-03',
        // Kistelyevm: 31 Eki -> 3 Kas 1.600 TL (3 gun), odemeden sonra 1.300 TL (17 gun).
        lateFee: TL(((1600 * 3 + 1300 * 17) * 0.05) / 30),
      }),
    ]);
    expect(r.json.items[0].overdue).toBe(c.debt - TL(300));

    const summary = await w.call('GET', '/api/finance/summary', observer);
    expect(summary.json).toMatchObject({ formerReceivables: c.debt - TL(300), formerDebtorCount: 1 });
    expect(summary.json.receivables).toBe(c.debt - TL(300) + TL(1000));

    const dues = await w.call('GET', '/api/finance/dues-status', observer);
    const u1 = dues.json.items.find((i: { unitId: string }) => i.unitId === 'u1');
    expect(u1.occupant).toMatchObject({ balance: TL(1000), oldestUnpaidDueDate: '2026-11-10' });
    expect(u1.former).toMatchObject({ balance: c.debt - TL(300) });

    // Borcu kapanan ayrilan cari varsayilan listede yok, ?all=true ile var.
    w.setNow('2026-11-21');
    await w.call('POST', '/api/finance/payments', manager, payBody({ idempotencyKey: 'pay-former-2', accountId: c.targetAccountId, amount: c.debt - TL(300), paidAt: '2026-11-21' }));
    expect((await w.call('GET', '/api/finance/former-accounts', observer)).json.items).toEqual([]);
    expect((await w.call('GET', '/api/finance/former-accounts?all=true', observer)).json.items).toHaveLength(1);
    expect((await w.call('GET', '/api/finance/former-accounts', { userId: 'x', role: 'resident', apartmentId: APT })).status).toBe(403);
  });

  it('tazminat gorevi ayrilan cariyi de kesinlestirir; yeni kiracinin tazminati yalnizca kendi borcundan', async () => {
    const w = cariWorld();
    const c = await moveOutAndIn(w);
    w.setNow('2026-12-01');
    const res = await w.finance.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    const by = Object.fromEntries(res.items.map((i) => [i.accountId, i.amount]));
    expect(by[MAIN]).toBe(TL(1000 * 0.05 * 20 / 30));
    expect(by[c.targetAccountId]).toBe(TL(1600 * 0.05));
  });
});
