/**
 * Cari kapama <-> daire uyelikleri (Daireler ekrani).
 *
 * Hata: kapama ayrilan uyeligin yalnizca `endDate`'ini cikis tarihine cekiyordu; uyelik `active`
 * kaldigi ve bitis tarihi dahil sayildigi icin cikis bugunse daire listesinde kiraci "aktif",
 * daire "Dolu" gorunuyordu. Geri alma ise uyelikleri hic geri yuklemiyordu.
 *
 * Duzeltme: kapama ayrilan uyeligi `inactive` + `endDate = D` + `endedByClosureId` yapar;
 * geri alma ayni atomik yazimda onceki haline dondurur.
 */
import { describe, expect, it } from 'vitest';
import { occupancyOn } from '../src/modules/finance/occupancy.js';
import { cariWorld, manager } from './fakes/cariWorld.js';

type W = ReturnType<typeof cariWorld>;
type Current = { userId: string; unitId: string; relation: 'owner' | 'tenant'; residesInUnit: boolean; isCurrent: boolean; status: string };

/** Daireler ekraninin girdisi ve web'deki (unitRows.buildUnitRows) doluluk kurali. */
async function unitsScreen(w: W) {
  const r = await w.call('GET', '/api/memberships?current=true', manager);
  expect(r.status).toBe(200);
  const items = (r.json.items as Current[]).filter((m) => m.unitId === 'u1' && m.isCurrent && m.status === 'active');
  return {
    tenants: items.filter((m) => m.relation === 'tenant').map((m) => m.userId),
    owners: items.filter((m) => m.relation === 'owner').map((m) => m.userId),
    occupancy: items.some((m) => m.residesInUnit) ? 'Dolu' : 'Boş',
  };
}

const closeBody = (over: Record<string, unknown> = {}) => ({
  idempotencyKey: 'close-0001',
  party: 'occupant',
  moveOutDate: '2026-11-20',
  userIds: ['tenant-a'],
  reason: 'Kiracı taşındı',
  ...over,
});

describe('kapama sonrasi daire listesi', () => {
  it('kiraci cikisi (cikis bugun): kiraci listeden duser, daire Boş; geri alininca Dolu', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    await w.charge('k-nov', 1000, '2026-11-01', '2026-11-10');
    expect(await unitsScreen(w)).toEqual({ tenants: ['tenant-a'], owners: ['owner-1'], occupancy: 'Dolu' });

    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody());
    expect(c.status).toBe(201);
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'inactive', endDate: '2026-11-20', endedByClosureId: c.json.closure.closureId });
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: ['owner-1'], occupancy: 'Boş' });

    const r = await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Yanlış daire seçildi' });
    expect(r.status).toBe(200);
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'active' });
    expect(w.memberOf('tenant-a').endDate).toBeUndefined();
    expect(w.memberOf('tenant-a').endedByClosureId).toBeUndefined();
    expect(await unitsScreen(w)).toEqual({ tenants: ['tenant-a'], owners: ['owner-1'], occupancy: 'Dolu' });
  });

  it('kapamadan once belirlenmis bitis tarihi geri almada korunur', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01', endDate: '2026-12-31' });
    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody());
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'inactive', endDate: '2026-11-20' });
    await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Geri alındı' });
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'active', endDate: '2026-12-31' });
  });

  it('oturan malik kiraya veriyor: malik kalir ama oturmuyor, daire Boş; geri alininca Dolu', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: true, startDate: '2025-01-01' });
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: ['owner-1'], occupancy: 'Dolu' });

    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody({ userIds: ['owner-1'] }));
    expect(c.status).toBe(201);
    expect(w.memberOf('owner-1')).toMatchObject({ status: 'active', residesInUnit: false });
    expect(w.memberOf('owner-1').endDate).toBeUndefined();
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: ['owner-1'], occupancy: 'Boş' });

    await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Kiralama iptal' });
    expect(w.memberOf('owner-1')).toMatchObject({ status: 'active', residesInUnit: true });
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: ['owner-1'], occupancy: 'Dolu' });
  });

  it('satis (malik carisi): eski malik aktif malik olarak gorunmez; geri alininca doner', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody({ party: 'owner', userIds: ['owner-1'], reason: 'Daire satıldı' }));
    expect(c.status).toBe(201);
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: [], occupancy: 'Boş' });
    await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Satış iptal' });
    expect(await unitsScreen(w)).toEqual({ tenants: [], owners: ['owner-1'], occupancy: 'Boş' });
  });

  it('kapama sonrasi elle degistirilmis uyelige geri almada dokunulmaz', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody());
    // Yonetici uyeligi elle yeniden duzenledi (kapama izi yok, farkli bitis tarihi).
    const m = w.memberOf('tenant-a');
    w.member('tenant-a', { ...m, endedByClosureId: undefined, status: 'inactive', endDate: '2026-11-15', version: m.version + 1 });
    const r = await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Geri alındı' });
    expect(r.status).toBe(200);
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'inactive', endDate: '2026-11-15' });
  });

  it('bu duzeltmeden onceki kapamalar (uyelik aktif, bitis = cikis) de geri yuklenir', async () => {
    const w = cariWorld('2026-11-20');
    w.member('owner-1', { relation: 'owner', residesInUnit: false, startDate: '2025-01-01' });
    w.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    const c = await w.call('POST', '/api/finance/units/u1/closures', manager, closeBody());
    const m = w.memberOf('tenant-a');
    // Eski davranisin biraktigi kayit.
    w.member('tenant-a', { ...m, endedByClosureId: undefined, status: 'active', endDate: '2026-11-20' });
    await w.call('POST', `/api/finance/closures/${c.json.closure.closureId}/reverse`, manager, { reason: 'Geri alındı' });
    expect(w.memberOf('tenant-a')).toMatchObject({ status: 'active' });
    expect(w.memberOf('tenant-a').endDate).toBeUndefined();
  });
});

describe('gecmise donuk doluluk', () => {
  it('kapamayla pasiflesen uyelik cikis gunune kadar dolu sayilir; elle pasiflestirilen sayilmaz', () => {
    const base = { unitId: 'u1', relation: 'tenant' as const, residesInUnit: true, startDate: '2026-03-01', endDate: '2026-10-31' };
    const owner = { unitId: 'u1', relation: 'owner' as const, residesInUnit: false, startDate: '2025-01-01', status: 'active' as const };
    expect(occupancyOn([owner, { ...base, status: 'inactive', endedByClosureId: 'c1' }], 'u1', '2026-10-15')).toBe('occupied');
    expect(occupancyOn([owner, { ...base, status: 'inactive', endedByClosureId: 'c1' }], 'u1', '2026-11-01')).toBe('vacant');
    expect(occupancyOn([owner, { ...base, status: 'inactive' }], 'u1', '2026-10-15')).toBe('vacant');
  });
});
