/**
 * Cari devri - Asama 5: bos daire kurali.
 *
 * Tahakkuk tarihinde dairede kiraci veya oturan malik yoksa `occupant` gideri kat maliki carisine
 * yazilir. Uyelik kaydi hic yoksa kural uygulanmaz (veri eksik); malik tarafi istenen gidere
 * (demirbas) dokunulmaz.
 */
import { describe, expect, it } from 'vitest';
import { buildEvent } from '../src/events/publisher.js';
import { liablePartyFor, occupancyOn } from '../src/modules/finance/occupancy.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { APT, MAIN, OWNER, TL, cariWorld, manager } from './fakes/cariWorld.js';

const m = (over: Partial<UnitMembership>): UnitMembership =>
  ({
    userId: 'x',
    apartmentId: APT,
    unitId: 'u1',
    relation: 'tenant',
    residesInUnit: true,
    status: 'active',
    startDate: '2026-01-01',
    ...over,
  }) as UnitMembership;

describe('occupancyOn / liablePartyFor (saf)', () => {
  const owner = m({ userId: 'o', relation: 'owner', residesInUnit: false });

  it('kiraci veya oturan malik varsa dolu', () => {
    expect(occupancyOn([owner, m({ userId: 't' })], 'u1', '2026-05-01')).toBe('occupied');
    expect(occupancyOn([m({ userId: 'o', relation: 'owner', residesInUnit: true })], 'u1', '2026-05-01')).toBe('occupied');
  });

  it('yalnizca oturmayan malik varsa bos; hic uyelik yoksa bilinmiyor', () => {
    expect(occupancyOn([owner], 'u1', '2026-05-01')).toBe('vacant');
    expect(occupancyOn([], 'u1', '2026-05-01')).toBe('unknown');
    expect(occupancyOn([owner], 'u2', '2026-05-01')).toBe('unknown');
  });

  it('uyelik tarihleri dahil; pasif uyelik sayilmaz', () => {
    const leaving = m({ userId: 't', endDate: '2026-10-31' });
    const coming = m({ userId: 'n', startDate: '2026-12-01' });
    expect(occupancyOn([owner, leaving, coming], 'u1', '2026-10-31')).toBe('occupied');
    expect(occupancyOn([owner, leaving, coming], 'u1', '2026-11-01')).toBe('vacant');
    expect(occupancyOn([owner, leaving, coming], 'u1', '2026-12-01')).toBe('occupied');
    expect(occupancyOn([owner, m({ userId: 't', status: 'inactive' })], 'u1', '2026-05-01')).toBe('vacant');
  });

  it('yalnizca sakin tarafi ve yalnizca bos dairede yonlendirilir', () => {
    expect(liablePartyFor('occupant', 'vacant')).toEqual({ party: 'owner', vacant: true });
    expect(liablePartyFor('occupant', 'occupied')).toEqual({ party: 'occupant', vacant: false });
    expect(liablePartyFor('occupant', 'unknown')).toEqual({ party: 'occupant', vacant: false });
    expect(liablePartyFor('owner', 'vacant')).toEqual({ party: 'owner', vacant: false });
  });
});

describe('tekil tahakkuk', () => {
  it('bos dairede sakin gideri malik carisine yazilir ve isaretlenir', async () => {
    const w = cariWorld('2026-11-01', { vacancyRule: true });
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });

    const r = await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10');
    expect(r.liableParty).toBe('owner');
    expect(r.vacant).toBe(true);
    expect(r.transaction.vacant).toBe(true);
    expect(r.transaction.description).toBe('Aidat 2026-11 (daire boş - kat malikine)');
    expect(r.transaction.lines[0]).toMatchObject({ accountId: OWNER, side: 'debit', liableParty: 'owner', amount: TL(1000) });
    expect((await w.acc(OWNER))?.balance).toBe(TL(1000));
    expect(await w.acc(MAIN)).toBeUndefined();

    // Ayni anahtarla tekrar: kiraci sonradan girse de ayni kayit doner (cift yazim yok).
    w.member('tenant-n', { relation: 'tenant', startDate: '2026-11-01' });
    const again = await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10');
    expect(again).toMatchObject({ replayed: true, liableParty: 'owner', vacant: true });
    expect(again.transaction.transactionId).toBe(r.transaction.transactionId);
    expect((await w.acc(OWNER))?.balance).toBe(TL(1000));
  });

  it('kiraci veya oturan malik varken, uyelik hic yokken ya da malik gideri istenmisken degismez', async () => {
    const w = cariWorld('2026-11-01', { vacancyRule: true });
    const unknown = await w.charge('k-1', 100, '2026-09-01', '2026-09-10');
    expect(unknown).toMatchObject({ liableParty: 'occupant', vacant: false });

    w.member('owner-1', { relation: 'owner', residesInUnit: true, startDate: '2025-01-01' });
    expect(await w.charge('k-2', 100, '2026-10-01', '2026-10-10')).toMatchObject({ liableParty: 'occupant', vacant: false });

    const fixture = await w.charge('k-3', 500, '2026-10-01', '2026-10-10', 'owner');
    expect(fixture).toMatchObject({ liableParty: 'owner', vacant: false });
    expect(fixture.transaction.description).toBe('Aidat 2026-10');
    expect((await w.acc(MAIN))?.balance).toBe(TL(200));
  });

  it('uyelik deposu verilmemisse kural kapali (geriye uyumluluk)', async () => {
    const w = cariWorld('2026-11-01');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    expect(await w.charge('k-1', 100, '2026-11-01', '2026-11-10')).toMatchObject({ liableParty: 'occupant', vacant: false });
  });

  it('kiraci ayrildiktan sonraki bos ay malike, yeni kiraci geldikten sonra sakine; rapor ve HTTP yaniti', async () => {
    const w = cariWorld('2026-12-05', { vacancyRule: true });
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    w.member('tenant-a', { relation: 'tenant', startDate: '2026-01-01', endDate: '2026-10-31' });
    w.member('tenant-b', { relation: 'tenant', startDate: '2026-12-01' });
    await w.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
    const nov = await w.call('POST', '/api/finance/dues', manager, {
      idempotencyKey: 'k-nov',
      unitId: 'u1',
      liableParty: 'occupant',
      amount: TL(1000),
      date: '2026-11-01',
      dueDate: '2026-11-10',
      description: 'Kasım aidatı',
    });
    expect(nov.status).toBe(201);
    expect(nov.json).toMatchObject({ mode: 'single', transaction: { vacant: true } });
    await w.charge('k-dec', 1000, '2026-12-01', '2026-12-10');

    expect((await w.acc(MAIN))?.balance).toBe(TL(2000));
    expect((await w.acc(OWNER))?.balance).toBe(TL(1000));
    const dues = await w.call('GET', '/api/finance/dues-status', manager);
    const row = (dues.json.items as Array<Record<string, any>>).find((i) => i.unitId === 'u1');
    expect(row?.owner.balance).toBe(TL(1000));
    expect(row?.occupant.balance).toBe(TL(2000));
  });
});

describe('toplu tahakkuk', () => {
  function world() {
    const w = cariWorld('2026-11-01', { vacancyRule: true });
    w.addUnit('u2', '6');
    w.addUnit('u3', '7');
    w.member('tenant-1', { relation: 'tenant', startDate: '2026-01-01' });
    w.member('owner-2', { unitId: 'u2', relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    return w;
  }
  const body = { liableParty: 'occupant', totalAmount: TL(3000), distributionKey: 'equal', date: '2026-11-01', dueDate: '2026-11-10', description: 'Kasım aidatı' };

  it('onizleme: pay dagitimi ayni, bos daireler ve uyeligi olmayanlar raporlanir', async () => {
    const w = world();
    const p = await w.call('POST', '/api/finance/dues/preview', manager, body);
    expect(p.status).toBe(200);
    expect(p.json.items.map((i: Record<string, unknown>) => [i.unitId, i.amount, i.liableParty])).toEqual([
      ['u1', TL(1000), 'occupant'],
      ['u2', TL(1000), 'owner'],
      ['u3', TL(1000), 'occupant'],
    ]);
    expect(p.json.vacant).toEqual([{ unitId: 'u2', blockId: 'b1', number: '6' }]);
    expect(p.json.unknownOccupancy).toEqual([{ unitId: 'u3', blockId: 'b1', number: '7' }]);

    // Malik tarafi istenirse kural devre disi.
    const owner = await w.call('POST', '/api/finance/dues/preview', manager, { ...body, liableParty: 'owner' });
    expect(owner.json.vacant).toEqual([]);
    expect(owner.json.unknownOccupancy).toEqual([]);
  });

  it('kayit: her bolum dogru cariye; sonuc bos daireleri listeler', async () => {
    const w = world();
    const r = await w.call('POST', '/api/finance/dues', manager, { ...body, idempotencyKey: 'bulk-nov-1' });
    expect(r.status).toBe(201);
    expect(r.json.items.map((i: Record<string, unknown>) => [i.unitId, i.liableParty, i.vacant])).toEqual([
      ['u1', 'occupant', false],
      ['u2', 'owner', true],
      ['u3', 'occupant', false],
    ]);
    expect(r.json.vacant).toEqual([{ unitId: 'u2', blockId: 'b1', number: '6' }]);
    expect((await w.acc('recv-u2-owner'))?.balance).toBe(TL(1000));
    expect(await w.acc('recv-u2-occupant')).toBeUndefined();
    expect((await w.acc('recv-u3-occupant'))?.balance).toBe(TL(1000));

    const again = await w.call('POST', '/api/finance/dues', manager, { ...body, idempotencyKey: 'bulk-nov-1' });
    expect(again.status).toBe(200);
    expect(again.json.vacant).toEqual([{ unitId: 'u2', blockId: 'b1', number: '6' }]);
  });
});

describe('bildirim', () => {
  it('bos daire kalemi malike gider, sakin tarafindaki kisilere gitmez', () => {
    const event = buildEvent({
      eventId: 'DUE_GENERATED:b1:t1',
      type: 'DUE_GENERATED',
      apartmentId: APT,
      actorId: 'mgr-1',
      payload: {
        mode: 'bulk',
        date: '2026-11-01',
        dueDate: '2026-11-10',
        description: 'Kasım aidatı',
        liableParty: 'occupant',
        totalAmount: TL(2000),
        items: [
          { unitId: 'u1', amount: TL(1000), transactionId: 't1', liableParty: 'occupant' },
          { unitId: 'u2', amount: TL(1000), transactionId: 't2', liableParty: 'owner' },
        ],
      },
    });
    const members = [
      m({ userId: 'tenant-1', unitId: 'u1' }),
      m({ userId: 'owner-1', unitId: 'u1', relation: 'owner', residesInUnit: false }),
      m({ userId: 'owner-2', unitId: 'u2', relation: 'owner', residesInUnit: false }),
    ];
    const to = buildNotifications(event, members, new Map(), '2026-11-01').map((n) => n.userId).sort();
    expect(to).toEqual(['owner-2', 'tenant-1']);
  });
});
