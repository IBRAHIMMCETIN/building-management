/**
 * Cari devri - Asama 2: kapama servisi ve API (onizleme, atomik yazim, kilit, geri alma).
 */
import { describe, expect, it } from 'vitest';
import { toKurus } from '../src/modules/core/types.js';
import { planClosure } from '../src/modules/finance/closures.js';
import { linesOfAccount, readSubledger } from '../src/modules/finance/subledger.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { APT, MAIN, OWNER, RATE, TL, cariWorld, manager, observer, resident } from './fakes/cariWorld.js';

const setup = cariWorld;

type S = ReturnType<typeof cariWorld>;

/** Kiraci A: Eylul + Ekim aidati, Eylul'de 400 TL odeme. */
async function tenantA(s: S) {
  s.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
  await s.charge('k-sep', 1000, '2026-09-01', '2026-09-10');
  await s.pay('p-sep', 400, '2026-09-20');
  await s.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
  s.setNow('2026-11-05');
}

const body = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'close-0001',
  party: 'occupant',
  moveOutDate: '2026-10-31',
  userIds: ['tenant-a'],
  reason: 'Kiracı taşındı',
  ...over,
});

describe('cari kapama - onizleme', () => {
  it('acik kalemler, kesime kadar tazminat, uyelik degisikligi ve hedef secenekleri; hicbir sey yazmaz', async () => {
    const s = setup();
    await tenantA(s);
    const before = (await s.txs()).length;
    const r = await s.call('GET', '/api/finance/units/u1/closures/preview?party=occupant&moveOutDate=2026-10-31');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      unitId: 'u1',
      party: 'occupant',
      sourceAccountId: MAIN,
      lateFeeMonthlyBasisPoints: RATE,
      memberships: [{ userId: 'tenant-a', relation: 'tenant', change: 'ended' }],
      targets: { debt: ['former', 'owner'], advance: ['refund', 'former', 'owner'] },
      warnings: [],
    });
    expect(r.json.items.map((i: any) => [i.category, i.dueDate, i.amount])).toEqual([
      ['principal', '2026-09-10', TL(600)],
      ['principal', '2026-10-10', TL(1000)],
      ['late_fee', '2026-10-31', r.json.lateFee],
    ]);
    expect(r.json.debt).toBe(TL(1600) + r.json.lateFee);
    expect((await s.txs()).length).toBe(before);
  });

  it('cikis sonrasi alacak kaydi ve dairede kalan sakin uyarilir; gelecek tarih reddedilir', async () => {
    const s = setup();
    await tenantA(s);
    s.member('roommate', { relation: 'tenant', startDate: '2026-05-01' });
    await s.pay('p-late', 100, '2026-11-02');
    const r = await s.call('GET', '/api/finance/units/u1/closures/preview?party=occupant&moveOutDate=2026-10-31&userIds=tenant-a');
    expect(r.json.later).toEqual({ charges: 0, credits: 1, creditAmount: TL(100) });
    expect(r.json.warnings).toEqual([expect.stringMatching(/1 alacak kaydi/), expect.stringMatching(/kalan baska sakin/)]);
    expect((await s.call('GET', '/api/finance/units/u1/closures/preview?party=occupant&moveOutDate=2026-12-01')).status).toBe(400);
  });
});

describe('cari kapama - kiraci cikisi', () => {
  it('tek atomik yazim: tazminat + kapama + acilis + kapama kaydi + uyelik bitisi; ana cari kilitlenir', async () => {
    const s = setup();
    await tenantA(s);
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, body());
    expect(r.status).toBe(201);
    const c = r.json.closure;
    expect(c).toMatchObject({
      unitId: 'u1',
      party: 'occupant',
      moveOutDate: '2026-10-31',
      debtTo: 'former',
      status: 'completed',
      targetAccountId: `${MAIN}-c${c.closureId}`,
      membershipChanges: [{ userId: 'tenant-a', change: 'ended' }],
      reason: 'Kiracı taşındı',
    });
    expect(c).not.toHaveProperty('PK');
    expect(c.items).toHaveLength(3);
    expect(s.fake.batches.at(-1)!.transactions.map((t) => [t.kind, t.transfer?.role])).toEqual([
      ['late_fee', undefined],
      ['transfer', 'close'],
      ['transfer', 'open'],
    ]);

    const main = await s.acc(MAIN);
    const former = await s.acc(c.targetAccountId);
    expect(main).toMatchObject({ balance: 0, closedThrough: '2026-10-31' });
    expect(former).toMatchObject({
      balance: c.debt,
      closureId: c.closureId,
      liableParty: 'occupant',
      holder: { userIds: ['tenant-a'], periodStart: '2026-03-01', periodEnd: '2026-10-31' },
      name: 'Daire 5 - Ayrılan sakin (31.10.2026)',
    });
    expect((await s.acc('transfer-clearing'))!.balance).toBe(0);
    expect(s.memberOf('tenant-a')).toMatchObject({ endDate: '2026-10-31', version: 2 });
    expect(readSubledger(linesOfAccount(MAIN, await s.txs())).balance).toBe(0);

    // Listeleme / tekil okuma
    const list = await s.call('GET', '/api/finance/units/u1/closures', observer);
    expect(list.json.items.map((x: any) => x.closureId)).toEqual([c.closureId]);
    expect((await s.call('GET', `/api/finance/closures/${c.closureId}`, observer)).json.closureId).toBe(c.closureId);
  });

  it('idempotent: ayni anahtar ayni sonucu doner, farkli istekle 409', async () => {
    const s = setup();
    await tenantA(s);
    const a = await s.call('POST', '/api/finance/units/u1/closures', manager, body());
    const b = await s.call('POST', '/api/finance/units/u1/closures', manager, body());
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ replayed: true, closure: { closureId: a.json.closure.closureId } });
    expect((await s.call('POST', '/api/finance/units/u1/closures', manager, body({ reason: 'Baska gerekce' }))).status).toBe(409);
    // Ayni tarihe ikinci kapama (yeni anahtarla) reddedilir.
    const again = await s.call('POST', '/api/finance/units/u1/closures', manager, body({ idempotencyKey: 'close-0002', userIds: [] }));
    expect(again.status).toBe(422);
  });

  it('kilit: kapatilan doneme tahsilat/tahakkuk yazilamaz, ters kayit yapilamaz; sonrasi serbest', async () => {
    const s = setup();
    await tenantA(s);
    const closed = (await s.call('POST', '/api/finance/units/u1/closures', manager, body())).json.closure;

    const late = await s.call('POST', '/api/finance/payments', manager, { idempotencyKey: 'pay-lock-1', unitId: 'u1', liableParty: 'occupant', amount: TL(50), method: 'cash', paidAt: '2026-10-31' });
    expect(late.status).toBe(409);
    expect(late.json.message).toMatch(/2026-10-31 tarihine kadar kapatildi/);
    const dues = await s.call('POST', '/api/finance/dues', manager, { idempotencyKey: 'dues-lock-1', unitId: 'u1', liableParty: 'occupant', amount: TL(50), date: '2026-10-15', dueDate: '2026-10-20', description: 'Geriye tarihli' });
    expect(dues.status).toBe(409);
    expect((await s.call('POST', '/api/finance/payments', manager, { idempotencyKey: 'pay-ok-1', unitId: 'u1', liableParty: 'occupant', amount: TL(50), method: 'cash', paidAt: '2026-11-01' })).status).toBe(201);

    const sep = (await s.txs()).find((t) => t.kind === 'dues_charge' && t.date === '2026-09-01')!;
    const rev = await s.call('POST', `/api/finance/transactions/${sep.transactionId}/reversal`, manager, { reason: 'Hatali' });
    expect(rev.status).toBe(422);
    expect(rev.json.message).toMatch(/devredildigi caride/);
    const transfer = (await s.txs()).find((t) => t.transactionId === closed.transactionIds.open)!;
    expect((await s.call('POST', `/api/finance/transactions/${transfer.transactionId}/reversal`, manager, { reason: 'Hatali' })).status).toBe(422);

    // Kacirilmis Eylul tazminat gorevi kapamadan sonra calissa bile hata vermez, yazmaz.
    const sepFees = await s.finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    expect(sepFees.items.filter((i) => i.accountId === MAIN)).toEqual([]);
  });
});

describe('cari kapama - diger senaryolar', () => {
  it('oturan malik kiraya veriyor: sakin carisi malik carisine; malik uyeligi surer, artik oturmuyor', async () => {
    const s = setup();
    s.member('owner-a', { relation: 'owner', residesInUnit: true, startDate: '2025-01-01' });
    await s.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
    s.setNow('2026-11-05');
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, body({ userIds: ['owner-a'], debtTo: 'owner', reason: 'Malik daireyi kiraya verdi' }));
    expect(r.status).toBe(201);
    expect(r.json.closure).toMatchObject({ targetAccountId: OWNER, membershipChanges: [{ userId: 'owner-a', change: 'not_resident' }] });
    expect(s.memberOf('owner-a')).toMatchObject({ residesInUnit: false, relation: 'owner' });
    expect(s.memberOf('owner-a').endDate).toBeUndefined();
    const owner = readSubledger(linesOfAccount(OWNER, await s.txs()));
    expect(owner.charges.map((c) => [c.description, c.dueDate])).toEqual([
      ['Aidat 2026-10', '2026-10-10'],
      ['Gecikme tazminatı (çıkış tarihine kadar)', '2026-10-31'],
    ]);
  });

  it('satis: borc yeni malike devredilirse ayni cari yeni malikin baslangic gunu acilir', async () => {
    const s = setup();
    s.member('owner-a', { relation: 'owner', residesInUnit: false, startDate: '2020-01-01' });
    await s.charge('k-cap', 5000, '2026-10-01', '2026-10-20', 'owner');
    s.setNow('2026-11-05');
    const ownerBody = body({ party: 'owner', userIds: ['owner-a'], debtTo: 'new_owner', newOwnerUserId: 'owner-b', reason: 'Daire satıldı' });
    // Yeni malik henuz eklenmemis
    expect((await s.call('POST', '/api/finance/units/u1/closures', manager, ownerBody)).json.field).toBe('newOwnerUserId');
    s.member('owner-b', { relation: 'owner', residesInUnit: false, startDate: '2026-11-01' });
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, { ...ownerBody, idempotencyKey: 'close-sale-2' });
    expect(r.status).toBe(201);
    expect(r.json.closure.targetAccountId).toBe(OWNER);
    const open = (await s.txs()).find((t) => t.transactionId === r.json.closure.transactionIds.open)!;
    expect(open.date).toBe('2026-11-01');
    const sub = readSubledger(linesOfAccount(OWNER, await s.txs()));
    expect(sub).toMatchObject({ cutoff: '2026-10-31' });
    expect(sub.charges[0]).toMatchObject({ dueDate: '2026-10-20', accrueFrom: '2026-11-01', amount: TL(5000) });
    expect(s.memberOf('owner-a').endDate).toBe('2026-10-31');
    // Malik tarafinda "malik carisine" hedefi yok.
    expect((await s.call('POST', '/api/finance/units/u1/closures', manager, { ...ownerBody, idempotencyKey: 'close-sale-3', debtTo: 'owner' })).json.field).toBe('debtTo');
  });

  it('avans iadesi: kasadan cikar, kasa yetersizse reddedilir; iade edilen kapama geri alinamaz', async () => {
    const s = setup();
    s.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    await s.charge('k-sep', 1000, '2026-09-01', '2026-09-10');
    await s.pay('p-sep', 1300, '2026-09-05');
    s.setNow('2026-11-05');
    // Kasada 1.300 var; 3.000 TL'lik ikinci odeme yok -> yeterli. Once bankadan dene (bos).
    const noFunds = await s.call('POST', '/api/finance/units/u1/closures', manager, body({ advanceTo: 'refund', refundAccountId: 'bank' }));
    expect(noFunds.status).toBe(422);
    expect(noFunds.json.error).toBe('insufficient_funds');
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, body({ idempotencyKey: 'close-refund', advanceTo: 'refund', refundAccountId: 'cash' }));
    expect(r.status).toBe(201);
    expect(r.json.closure).toMatchObject({ advance: TL(300), debt: 0, transactionIds: { close: expect.any(String), refund: expect.any(String) } });
    expect((await s.acc('cash'))!.balance).toBe(TL(1000));
    expect((await s.acc(MAIN))!.balance).toBe(0);
    const rev = await s.call('POST', `/api/finance/closures/${r.json.closure.closureId}/reverse`, manager, { reason: 'Yanlış kapama' });
    expect(rev.status).toBe(422);
  });

  it('bakiye sifirsa islem yazilmaz; kilit ve kapama kaydi yine yazilir', async () => {
    const s = setup();
    s.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    await s.charge('k-sep', 1000, '2026-09-01', '2026-09-10');
    await s.pay('p-sep', 1000, '2026-09-05');
    s.setNow('2026-11-05');
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, body());
    expect(r.status).toBe(201);
    expect(r.json.closure).toMatchObject({ debt: 0, advance: 0, transactionIds: {} });
    expect(r.json.closure.targetAccountId).toBeUndefined();
    expect((await s.acc(MAIN))!.closedThrough).toBe('2026-10-31');
    // Geri alma: islem yok, kilit kalkar.
    const rev = await s.call('POST', `/api/finance/closures/${r.json.closure.closureId}/reverse`, manager, { reason: 'Yanlış tarih' });
    expect(rev.status).toBe(200);
    expect((await s.acc(MAIN))!.closedThrough).toBeUndefined();
  });
});

describe('cari kapama - geri alma', () => {
  it('ayrilan caride hareket yoksa: kapama/acilis (ve sistem tazminatlari) ters kayitla iptal, kilit kalkar, tazminat kalir', async () => {
    const s = setup();
    await tenantA(s);
    const c = (await s.call('POST', '/api/finance/units/u1/closures', manager, body())).json.closure;
    // Ayrilan carisine 1 Aralik'ta tazminat gorevi yazdi.
    s.setNow('2026-12-01');
    const fees = await s.finance.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: RATE, dueDayOfMonth: 10 });
    expect(fees.items.some((i) => i.accountId === c.targetAccountId)).toBe(true);

    const r = await s.call('POST', `/api/finance/closures/${c.closureId}/reverse`, manager, { reason: 'Yanlış tarih girildi' });
    expect(r.status).toBe(200);
    expect(r.json.closure).toMatchObject({ status: 'reversed', reversal: { by: 'mgr-1', reason: 'Yanlış tarih girildi', transactionIds: expect.any(Array) } });
    expect(r.json.closure.reversal.transactionIds).toHaveLength(3);
    expect((await s.acc(c.targetAccountId))!.balance).toBe(0);
    const main = await s.acc(MAIN);
    expect(main!.closedThrough).toBeUndefined();
    // Ana cari: Eylul 600 + Ekim 1000 + kapamada kesinlesen tazminat geri geldi.
    expect(main!.balance).toBe(TL(1600) + c.lateFee);
    expect(readSubledger(linesOfAccount(MAIN, await s.txs())).cutoff).toBeUndefined();
    // Uyelik geri alinmaz (bilgi): yonetici gerekirse daireler ekranindan duzeltir.
    expect(s.memberOf('tenant-a').endDate).toBe('2026-10-31');
    expect((await s.call('POST', `/api/finance/closures/${c.closureId}/reverse`, manager, { reason: 'Tekrar deneme' })).status).toBe(409);
  });

  it('ayrilan cariye tahsilat girildiyse geri alinamaz', async () => {
    const s = setup();
    await tenantA(s);
    const c = (await s.call('POST', '/api/finance/units/u1/closures', manager, body())).json.closure;
    await s.fake.repo.postBatch({
      transactions: [
        {
          PK: `APT#${APT}`,
          SK: 'TX#20261110-pf',
          entityType: 'TRANSACTION',
          transactionId: '20261110-pf',
          siteId: APT,
          kind: 'payment',
          date: '2026-11-10',
          description: 'Ayrılan sakin ödemesi',
          lines: [
            { accountId: 'cash', side: 'debit', amount: TL(100) },
            { accountId: c.targetAccountId, side: 'credit', amount: TL(100), unitId: 'u1', liableParty: 'occupant' },
          ],
          totalAmount: TL(100),
          createdAt: '2026-11-10T00:00:00.000Z',
          createdBy: 'mgr-1',
        } as Transaction,
      ],
      idempotency: { id: 'pf', fingerprint: 'x' },
    });
    const r = await s.call('POST', `/api/finance/closures/${c.closureId}/reverse`, manager, { reason: 'Yanlış kapama' });
    expect(r.status).toBe(422);
    expect(r.json.message).toMatch(/tahsilat/);
  });
});

describe('cari kapama - dogrulama ve yetki', () => {
  it('gerekce, gelecek tarih, uygun olmayan uyelik, bilinmeyen daire', async () => {
    const s = setup();
    await tenantA(s);
    const post = (b: Record<string, unknown>) => s.call('POST', '/api/finance/units/u1/closures', manager, body(b));
    expect((await post({ reason: 'kısa' })).json.field).toBe('reason');
    expect((await post({ moveOutDate: '2026-12-01' })).json.field).toBe('moveOutDate');
    expect((await post({ userIds: ['baskasi'] })).json.field).toBe('userIds');
    expect((await post({ debtTo: 'new_owner' })).json.field).toBe('debtTo');
    expect((await s.call('POST', '/api/finance/units/yok/closures', manager, body())).status).toBe(404);
  });

  it('yalnizca yonetici/yonetim firmasi yazar; denetci okur; sakin erisemez; baska apartman goremez', async () => {
    const s = setup();
    await tenantA(s);
    expect((await s.call('POST', '/api/finance/units/u1/closures', observer, body())).status).toBe(403);
    expect((await s.call('GET', '/api/finance/units/u1/closures/preview?party=occupant&moveOutDate=2026-10-31', observer)).status).toBe(403);
    expect((await s.call('GET', '/api/finance/units/u1/closures', resident)).status).toBe(403);
    expect((await s.call('GET', '/api/finance/units/u1/closures', null)).status).toBe(401);
    const c = (await s.call('POST', '/api/finance/units/u1/closures', manager, body())).json.closure;
    expect((await s.call('GET', `/api/finance/closures/${c.closureId}`, { ...manager, apartmentId: 'apt-2' })).status).toBe(404);
    expect((await s.call('POST', `/api/finance/closures/${c.closureId}/reverse`, observer, { reason: 'Yanlış kapama' })).status).toBe(403);
  });
});

describe('planClosure (saf)', () => {
  it('avans tazminattan kucukse devreden borc yalnizca farktir; kalem toplami net bakiyeye esittir', () => {
    const t = (id: string, kind: Transaction['kind'], date: string, side: 'debit' | 'credit', amount: number, dueDate?: string): Transaction => ({
      PK: `APT#${APT}`,
      SK: `TX#${id}`,
      entityType: 'TRANSACTION',
      transactionId: id,
      siteId: APT,
      kind,
      date,
      ...(dueDate ? { dueDate } : {}),
      description: id,
      lines: [
        { accountId: MAIN, side, amount: toKurus(amount), unitId: 'u1', liableParty: 'occupant' },
        { accountId: 'x', side: side === 'debit' ? 'credit' : 'debit', amount: toKurus(amount) },
      ],
      totalAmount: toKurus(amount),
      createdAt: '2026-01-01T00:00:00.000Z',
      createdBy: 'x',
    });
    // 1000 TL vade 1 Eylul, 30 Ekim'de 1010 TL odendi (60 gun gec): tazminat 100 TL > 10 TL avans.
    const plan = planClosure(MAIN, [t('20260801-a', 'dues_charge', '2026-08-01', 'debit', 100_000, '2026-09-01'), t('20261030-b', 'payment', '2026-10-30', 'credit', 101_000)], '2026-10-31', RATE);
    expect(plan.lateFee).toBeGreaterThan(1_000);
    expect(plan.net).toBe(plan.lateFee - 1_000);
    expect(plan.items).toEqual([expect.objectContaining({ category: 'late_fee', amount: plan.net })]);
  });
});
