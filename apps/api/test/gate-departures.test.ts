/**
 * Tasinmada kapi kayitlarinin pasife alinmasi (gate/departures.ts): uyeligi biten kullanicinin o
 * bolumdeki aktif gecisleri `revoked` (taşınma), araclari `inactive` olur; plaka dizini serbest
 * kalir. Idempotent (ikinci calisma yazmaz), denetimli, es zamanli degisiklikte yeniden dener,
 * kiraci izolasyonu ve aday secimi (bitis gunu sonuna kadar oturur, geriye 7 gun).
 */
import { describe, expect, it } from 'vitest';
import { DEPARTURE_REASON, createGateDepartures, departureCandidates } from '../src/modules/gate/departures.js';
import type { GateRepository } from '../src/modules/gate/repository.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { APT, APT2, DAY, ctxs, gateWorld } from './fakes/gateWorld.js';

const NEXT = '2026-11-28';
const SYSTEM = 'system-scheduler';

function setup() {
  const w = gateWorld();
  const departuresOf = (repo: GateRepository = w.fake.repo) =>
    createGateDepartures({ repo, memberships: { list: async (apt) => w.memberships.filter((m) => m.apartmentId === apt) }, now: w.now });
  return { w, departures: departuresOf(), departuresOf };
}

async function seed(w: ReturnType<typeof gateWorld>) {
  w.moveIn('co-u1', 'u1', '2026-01-01');
  const p1 = await w.pass(ctxs.tenant, { validUntil: '2026-11-30', entryMode: 'multi' });
  const p2 = await w.pass(ctxs.tenant, { validFrom: '2026-12-02', validUntil: '2026-12-03' });
  const used = await w.pass(ctxs.tenant);
  await w.service.passEntry(ctxs.guard, used.passId, { idempotencyKey: 'e-used' });
  const todayOnly = await w.pass(ctxs.tenant);
  const co = await w.pass({ apartmentId: APT, userId: 'co-u1', role: 'resident' });
  const other = await w.pass(ctxs.other, { unitId: 'u2' });
  const x = await w.pass(ctxs.residentApt2, { unitId: 'x1' });
  const { vehicle } = await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34 ABC 123' });
  const { vehicle: otherVehicle } = await w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '06 AB 456' });
  return { p1, p2, used, todayOnly, co, other, x, vehicle, otherVehicle };
}

const passOf = (w: ReturnType<typeof gateWorld>, apt: string, id: string) => w.fake.byPrefix(apt, `GPASS#${id}`)[0] as Record<string, unknown>;

describe('tasinmada gecis ve araclarin pasife alinmasi', () => {
  it('bitis gunu boyunca dokunulmaz; ertesi gun aktif gecisler iptal, arac pasif, plaka serbest; denetim kaydi', async () => {
    const { w, departures } = setup();
    const s = await seed(w);
    w.endsOn('tenant-u1', 'u1', DAY);
    // Bitis gunu: hala oturuyor (okuma kurali `endDate >= bugun`): aday yok, yazim yok.
    const writes = w.fake.writes.length;
    expect(await departures.sweep(APT, DAY, SYSTEM)).toEqual({ candidates: 0, passesRevoked: 0, vehiclesDeactivated: 0, failed: 0 });
    expect(w.fake.writes).toHaveLength(writes);

    w.at('2026-11-28T09:00:00.000Z');
    expect(await departures.sweep(APT, NEXT, SYSTEM)).toEqual({ candidates: 1, passesRevoked: 2, vehiclesDeactivated: 1, failed: 0 });
    for (const p of [s.p1, s.p2]) expect(passOf(w, APT, p.passId)).toMatchObject({ status: 'revoked', revokeReason: DEPARTURE_REASON, revokedBy: SYSTEM, revokedAt: '2026-11-28T09:00:00.000Z' });
    // Kullanilmis, suresi dolmus, ayni dairedeki diger sakinin ve baska bolumun gecisleri degismez.
    expect(passOf(w, APT, s.used.passId)).toMatchObject({ status: 'used' });
    expect(passOf(w, APT, s.todayOnly.passId)).toMatchObject({ status: 'active' });
    expect(passOf(w, APT, s.co.passId)).toMatchObject({ status: 'active' });
    expect(passOf(w, APT, s.other.passId)).toMatchObject({ status: 'active' });
    expect(w.fake.byPrefix(APT, `VEH#${s.vehicle.vehicleId}`)[0]).toMatchObject({ status: 'inactive', inactiveReason: DEPARTURE_REASON, updatedBy: SYSTEM, version: 2 });
    expect(w.fake.byPrefix(APT, `VEH#${s.otherVehicle.vehicleId}`)[0]).toMatchObject({ status: 'active' });
    expect(w.fake.byPrefix(APT, 'VPLATE#321CBA43')[0]).toMatchObject({ status: 'inactive', vehicleId: s.vehicle.vehicleId });
    const audits = w.fake.audits.filter((a) => a.action === 'gate.departure_release');
    expect(audits).toEqual([
      {
        apartmentId: APT,
        action: 'gate.departure_release',
        target: { type: 'membership', id: 'tenant-u1:u1' },
        actorId: SYSTEM,
        reason: DEPARTURE_REASON,
        details: { userId: 'tenant-u1', unitId: 'u1', passIds: [s.p1.passId, s.p2.passId], vehicleIds: [s.vehicle.vehicleId] },
      },
    ]);
    // Gorevli: iptal edilmis gecis; yonetici nedenini gorur.
    expect((await w.service.verifyPass(ctxs.guard, { token: s.p1.token })).pass).toMatchObject({ verdict: 'revoked', canEnter: false });
    expect((await w.service.listPasses(ctxs.mgr)).items.find((p) => p.passId === s.p1.passId)).toMatchObject({ status: 'revoked', revokeReason: DEPARTURE_REASON });
    expect((await w.service.listVehicles(ctxs.mgr)).items.find((v) => v.vehicleId === s.vehicle.vehicleId)).toMatchObject({ status: 'inactive', inactiveReason: DEPARTURE_REASON });
    // Plaka serbest: yeni sakin ayni plakayi devralma yoluna girmeden kaydeder.
    w.moveIn('new-u1', 'u1', NEXT);
    const fresh = await w.service.createVehicle({ apartmentId: APT, userId: 'new-u1', role: 'resident' }, { unitId: 'u1', plate: '34ABC123' });
    expect(fresh.vehicle).toMatchObject({ status: 'active', plate: '34ABC123' });
  });

  it('idempotent: ikinci tarama hicbir sey yazmaz ve denetlemez', async () => {
    const { w, departures } = setup();
    await seed(w);
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    // Tasinma dunden: bugun gecerli tek gunluk gecis de iptal edilir (p1, p2, bugunluk).
    expect(await departures.sweep(APT, DAY, SYSTEM)).toMatchObject({ candidates: 1, passesRevoked: 3, vehiclesDeactivated: 1 });
    const writes = w.fake.writes.length;
    const audits = w.fake.audits.length;
    expect(await departures.sweep(APT, DAY, SYSTEM)).toEqual({ candidates: 1, passesRevoked: 0, vehiclesDeactivated: 0, failed: 0 });
    expect(await departures.release(APT, { userId: 'tenant-u1', unitId: 'u1' }, DAY, SYSTEM)).toEqual({ passIds: [], vehicleIds: [] });
    expect(w.fake.writes).toHaveLength(writes);
    expect(w.fake.audits).toHaveLength(audits);
  });

  it('kiraci izolasyonu: tarama yalnizca kendi apartmaninin uyeliklerine ve kayitlarina dokunur', async () => {
    const { w, departures } = setup();
    const s = await seed(w);
    // Baska apartmandaki sakin tasindi: bu apartmanin taramasi onu gormez.
    for (const m of w.memberships) if (m.apartmentId === APT2) Object.assign(m, { status: 'inactive', endDate: '2026-11-26' });
    expect(await departures.sweep(APT, DAY, SYSTEM)).toMatchObject({ candidates: 0, passesRevoked: 0 });
    expect(passOf(w, APT2, s.x.passId)).toMatchObject({ status: 'active' });
    // Yanlis apartmanla cagrilan adim bu apartmanin kayitlarini bulamaz.
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    expect(await departures.release(APT2, { userId: 'tenant-u1', unitId: 'u1' }, DAY, SYSTEM)).toEqual({ passIds: [], vehicleIds: [] });
    expect(passOf(w, APT, s.p1.passId)).toMatchObject({ status: 'active' });
    // Kendi apartmaninda: yalnizca o apartmanin bolumune yazar.
    expect(await departures.sweep(APT2, DAY, SYSTEM)).toMatchObject({ candidates: 1, passesRevoked: 1 });
    expect(passOf(w, APT2, s.x.passId)).toMatchObject({ status: 'revoked', revokeReason: DEPARTURE_REASON });
    expect(passOf(w, APT, s.p1.passId)).toMatchObject({ status: 'active' });
    expect(w.fake.writes.every((wr) => wr.puts.every((p) => p.PK === `APT#${APT}` || p.PK === `APT#${APT2}`))).toBe(true);
  });

  it('es zamanli degisiklik (sakin ayni anda iptal etti): surum cakismasinda yeniden okuyup kalanlari pasife alir', async () => {
    const { w, departuresOf } = setup();
    const s = await seed(w);
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    let raced = false;
    const repo: GateRepository = {
      ...w.fake.repo,
      async write(apt, wr) {
        if (!raced && wr.audit?.action === 'gate.departure_release') {
          raced = true;
          // Yonetici ayni anda p1'i iptal eder (surum artar): ilk yazim kosulda reddedilir.
          await w.service.revokePass(ctxs.mgr, s.p1.passId, { version: 1 });
        }
        return w.fake.repo.write(apt, wr);
      },
    };
    const r = await departuresOf(repo).release(APT, { userId: 'tenant-u1', unitId: 'u1' }, DAY, SYSTEM);
    expect(r).toEqual({ passIds: [s.p2.passId, s.todayOnly.passId], vehicleIds: [s.vehicle.vehicleId] });
    expect(passOf(w, APT, s.p1.passId)).toMatchObject({ status: 'revoked', revokedBy: 'mgr' });
    expect(passOf(w, APT, s.p1.passId)).not.toHaveProperty('revokeReason');
  });
});

describe('aday secimi', () => {
  const m = (extra: Partial<UnitMembership>) =>
    ({ userId: 'u', unitId: 'b1', apartmentId: APT, relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01', ...extra }) as UnitMembership;
  it('son 7 gunde biten / degisen ve bugun oturmayan uyelikler; gelecekteki ve oturanlar aday degil', () => {
    const list = [
      m({ userId: 'ended-yesterday', endDate: '2026-11-26' }),
      m({ userId: 'ends-today', endDate: DAY }),
      m({ userId: 'ended-long-ago', endDate: '2026-09-01', status: 'inactive', updatedAt: '2026-09-01T10:00:00.000Z' }),
      m({ userId: 'cancelled-now', status: 'inactive', updatedAt: '2026-11-27T08:00:00.000Z' }),
      m({ userId: 'owner-rented', relation: 'owner', residesInUnit: false, updatedAt: '2026-11-25T08:00:00.000Z' }),
      m({ userId: 'owner-away-long', relation: 'owner', residesInUnit: false, updatedAt: '2026-01-01T08:00:00.000Z' }),
      m({ userId: 'future', startDate: '2026-12-01', updatedAt: '2026-11-27T08:00:00.000Z' }),
      m({ userId: 'other-apt', apartmentId: APT2, endDate: '2026-11-26' }),
    ];
    expect(departureCandidates(list, APT, DAY).map((c) => c.userId)).toEqual(['ended-yesterday', 'cancelled-now', 'owner-rented']);
  });
});
