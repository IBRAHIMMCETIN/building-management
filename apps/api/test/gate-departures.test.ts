/**
 * Tasinmada kapi kayitlarinin pasife alinmasi (gate/departures.ts): uyeligi biten kullanicinin o
 * bolumdeki aktif gecisleri `revoked` (taşınma), araclari `inactive` olur; plaka dizini serbest
 * kalir. Idempotent (ikinci calisma yazmaz), denetimli, es zamanli degisiklikte yeniden dener,
 * kiraci izolasyonu ve aday secimi (bitis gunu sonuna kadar oturur, geriye 7 gun).
 */
import { describe, expect, it } from 'vitest';
import { CLOSURE_GRACE_DAYS, DEPARTURE_REASON, createGateDepartures, departureCandidates } from '../src/modules/gate/departures.js';
import type { GateRepository } from '../src/modules/gate/repository.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { APT, APT2, DAY, ctxs, gateWorld } from './fakes/gateWorld.js';

const NEXT = '2026-11-28';
const SYSTEM = 'system-scheduler';

function setup(opts: { codes?: string[] } = {}) {
  const w = gateWorld(opts);
  const metrics: { metrics: Record<string, number>; props?: Record<string, unknown> }[] = [];
  const errors: string[] = [];
  const departuresOf = (repo: GateRepository = w.fake.repo) =>
    createGateDepartures({
      repo,
      memberships: { list: async (apt) => w.memberships.filter((m) => m.apartmentId === apt) },
      now: w.now,
      metrics: { emit: (m, props) => metrics.push({ metrics: m, ...(props ? { props } : {}) }) },
      log: { error: (line: string) => errors.push(line) },
    });
  return { w, departures: departuresOf(), departuresOf, metrics, errors };
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

describe('buyuk kayit kumesi ve hata', () => {
  it('40+ kayit parcalara bolunur; ikinci parcada surum cakismasi: yeniden okuyup kalanlari yazar, cift kayit yok', async () => {
    const A = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    const { w, departuresOf } = setup({ codes: Array.from({ length: 60 }, (_, i) => `K7M2P${A[i % 31]}${A[Math.floor(i / 31)]}X`) });
    const passes = [];
    for (let i = 0; i < 45; i++) passes.push(await w.pass(ctxs.tenant, { guestName: `Misafir ${i}`, validUntil: '2026-11-29', entryMode: 'multi' }));
    const { vehicle } = await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34 ABC 123' });
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    let writes = 0;
    const raced = passes[42]!;
    const repo: GateRepository = {
      ...w.fake.repo,
      async write(apt, wr) {
        if (wr.audit?.action === 'gate.departure_release' && ++writes === 2) {
          // Ikinci parca yazilmadan once yonetici bu parcadaki bir gecisi iptal eder.
          await w.service.revokePass(ctxs.mgr, raced.passId, { version: 1 });
        }
        return w.fake.repo.write(apt, wr);
      },
    };
    const r = await departuresOf(repo).release(APT, { userId: 'tenant-u1', unitId: 'u1' }, DAY, SYSTEM);
    expect(r.passIds).toHaveLength(44);
    expect(new Set(r.passIds).size).toBe(44);
    expect(r.passIds).not.toContain(raced.passId);
    expect(r.vehicleIds).toEqual([vehicle.vehicleId]);
    const audits = w.fake.audits.filter((a) => a.action === 'gate.departure_release');
    // Parca 1 (40 gecis) + yeniden denemedeki tek parca (4 gecis + arac); reddedilen parca denetlenmez.
    expect(audits.map((a) => (a.details as { passIds: string[] }).passIds.length)).toEqual([40, 4]);
    for (const wr of w.fake.writes.filter((x) => x.puts.some((p) => String(p.SK).startsWith('GPASS#') && p.revokeReason))) expect(wr.puts.length).toBeLessThanOrEqual(40);
    for (const p of passes) expect(passOf(w, APT, p.passId)).toMatchObject({ status: 'revoked' });
    expect(passOf(w, APT, raced.passId)).toMatchObject({ revokedBy: 'mgr' });
  });

  it('bir adayin hatasi digerlerini durdurmaz: kisi verisi olmayan log + GateDepartureFailed metrigi', async () => {
    const { w, departuresOf, metrics, errors } = setup();
    await seed(w);
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    w.moveOut('owner-u2', 'u2', '2026-11-26');
    const repo: GateRepository = {
      ...w.fake.repo,
      async query(apt, q) {
        if ((q.prefix ?? q.from ?? '').includes('#u1#')) throw new Error('throttled');
        return w.fake.repo.query(apt, q);
      },
    };
    expect(await departuresOf(repo).sweep(APT, DAY, SYSTEM)).toMatchObject({ candidates: 2, failed: 1, vehiclesDeactivated: 1 });
    expect(metrics).toEqual([{ metrics: { GateDepartureFailed: 1 }, props: { msg: 'gate_departure_failed', apartmentId: APT, unitId: 'u1' } }]);
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0] as string)).toEqual({ msg: 'gate_departure_failed', apartmentId: APT, unitId: 'u1', error: 'Error' });
    expect(errors[0]).not.toContain('tenant-u1');
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

  it('cari kapamayla biten uyelik: bitis (veya kaydin degistigi gun) + 3 gun gecmeden aday degil (geri alma payi)', () => {
    const closed = (extra: Partial<UnitMembership>) => m({ userId: 'closed', status: 'inactive', endedByClosureId: 'cl-1', ...extra } as Partial<UnitMembership>);
    const at = (day: string, list: UnitMembership[]) => departureCandidates(list, APT, day).map((c) => c.userId);
    const list = [closed({ endDate: '2026-11-26', updatedAt: '2026-11-26T08:00:00.000Z' })];
    expect(CLOSURE_GRACE_DAYS).toBe(3);
    expect(at('2026-11-27', list)).toEqual([]);
    expect(at('2026-11-29', list)).toEqual([]);
    expect(at('2026-11-30', list)).toEqual(['closed']);
    // Geriye tarihli kapama (bitis 20 gun once) bugun kaydedildi: pay kaydin degistigi gunden sayilir.
    const backdated = [closed({ endDate: '2026-11-07', updatedAt: '2026-11-27T08:00:00.000Z' })];
    expect(at('2026-11-27', backdated)).toEqual([]);
    expect(at('2026-12-01', backdated)).toEqual(['closed']);
    // Kapama geri alindi (uyelik yeniden aktif, isaret kalkti): aday degil.
    expect(at('2026-11-30', [m({ userId: 'closed', updatedAt: '2026-11-28T08:00:00.000Z' })])).toEqual([]);
  });
});

describe('aninda adim (MEMBERSHIP_ENDED -> releaseNow)', () => {
  const trigger = { trigger: 'membership_ended' as const, eventId: 'MEMBERSHIP_ENDED:tenant-u1:u1:2' };
  const target = { userId: 'tenant-u1', unitId: 'u1' };

  it('bitis gecmis: gece taramasini beklemeden ayni kuralla pasife alir; denetimde tetikleyici; tekrar zararsiz', async () => {
    const { w, departures } = setup();
    const s = await seed(w);
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    const r = await departures.releaseNow(APT, target, DAY, SYSTEM, trigger);
    expect(r).toMatchObject({ status: 'released', vehicleIds: [s.vehicle.vehicleId] });
    expect(r.status === 'released' && [...r.passIds].sort()).toEqual([s.p1.passId, s.p2.passId, s.todayOnly.passId].sort());
    expect(w.fake.byPrefix(APT, `VEH#${s.vehicle.vehicleId}`)[0]).toMatchObject({ status: 'inactive', inactiveReason: DEPARTURE_REASON });
    expect(w.fake.byPrefix(APT, 'VPLATE#321CBA43')[0]).toMatchObject({ status: 'inactive' });
    expect(w.fake.audits.filter((a) => a.action === 'gate.departure_release').at(-1)).toMatchObject({ actorId: SYSTEM, details: { userId: 'tenant-u1', unitId: 'u1', ...trigger } });
    // Ayni bolumdeki diger sakin ve baska bolum etkilenmez.
    expect(passOf(w, APT, s.co.passId)).toMatchObject({ status: 'active' });
    expect(passOf(w, APT, s.other.passId)).toMatchObject({ status: 'active' });
    // SQS tekrar teslimi ve gece taramasi: yazim yok.
    const writes = w.fake.writes.length;
    expect(await departures.releaseNow(APT, target, DAY, SYSTEM, trigger)).toEqual({ status: 'released', passIds: [], vehicleIds: [] });
    expect(await departures.sweep(APT, DAY, SYSTEM)).toMatchObject({ passesRevoked: 0, vehiclesDeactivated: 0 });
    expect(w.fake.writes).toHaveLength(writes);
  });

  it('sonuc gece taramasiyla ayni (ayni baslangic, iki ayri dunya)', async () => {
    const a = setup();
    const b = setup();
    await seed(a.w);
    await seed(b.w);
    a.w.moveOut('tenant-u1', 'u1', '2026-11-26');
    b.w.moveOut('tenant-u1', 'u1', '2026-11-26');
    const now = await a.departures.releaseNow(APT, target, DAY, SYSTEM);
    const swept = await b.departures.sweep(APT, DAY, SYSTEM);
    expect(now.status === 'released' ? [now.passIds.length, now.vehicleIds.length] : []).toEqual([swept.passesRevoked, swept.vehiclesDeactivated]);
    const statuses = (w: typeof a.w) =>
      w.fake.byPrefix(APT, '').flatMap((i) => {
        const x = i as { entityType?: string; status?: string; guestName?: string; plate?: string; unitId?: string; createdBy?: string };
        return x.entityType === 'GATE_PASS' || x.entityType === 'GATE_VEHICLE' ? [`${x.entityType}|${x.unitId}|${x.createdBy ?? ''}|${x.plate ?? ''}|${x.status}`] : [];
      }).sort();
    expect(statuses(a.w)).toEqual(statuses(b.w));
  });

  it('bitis bugun (hala oturur) ve cari kapama payi: yazmaz, nedeni doner; baska apartmanla cagrida bulamaz', async () => {
    const { w, departures } = setup();
    await seed(w);
    w.endsOn('tenant-u1', 'u1', DAY);
    const writes = w.fake.writes.length;
    expect(await departures.releaseNow(APT, target, DAY, SYSTEM)).toEqual({ status: 'skipped', reason: 'resides' });
    for (const m of w.memberships) if (m.userId === 'tenant-u1') Object.assign(m, { status: 'inactive', endDate: '2026-11-26', endedByClosureId: 'cl-1', updatedAt: '2026-11-27T08:00:00.000Z' });
    expect(await departures.releaseNow(APT, target, DAY, SYSTEM)).toEqual({ status: 'skipped', reason: 'closure_grace' });
    expect(await departures.releaseNow(APT2, target, DAY, SYSTEM)).toEqual({ status: 'skipped', reason: 'not_departed' });
    expect(w.fake.writes).toHaveLength(writes);
    // Pay dolunca gece taramasi birakir (kural ayni).
    expect((await departures.sweep(APT, '2026-12-01', SYSTEM)).candidates).toBe(1);
  });
});
