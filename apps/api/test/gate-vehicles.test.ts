/**
 * Guvenlik kapisi (1): plaka normalizasyonu / Turk plaka bicimi, kisa kod, gecis karari; arac kaydi
 * (sakin yalnizca oturdugu bolum, aktif plaka tekil, bolum basina sinir, yonetici denetimi) ve
 * gorevli plaka sorgusu (tam / sondan eslesme, en az veri). Rol matrisi ve kiraci izolasyonu API'den.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../src/modules/core/validation.js';
import {
  SHORT_CODE_ALPHABET,
  addDays,
  daySpan,
  codeHash,
  formatPlate,
  hostLeft,
  indexTtl,
  isTurkishPlate,
  istanbulDay,
  istanbulDayStart,
  newShortCode,
  normalizePlate,
  normalizeShortCode,
  passActions,
  passVerdict,
  plateQuery,
  reversePlate,
  tokenHash,
} from '../src/modules/gate/model.js';
import { MAX_VEHICLES_PER_UNIT } from '../src/modules/gate/types.js';
import { APT, ctxs, gateWorld } from './fakes/gateWorld.js';

describe('plaka ve kod kurallari (saf)', () => {
  it('plaka normalizasyonu: bosluk, tire, nokta, kucuk harf ve Turkce i', () => {
    expect(normalizePlate('34 ABC 123')).toBe('34ABC123');
    expect(normalizePlate(' 06-ab.1234 ')).toBe('06AB1234');
    expect(normalizePlate('35 ı 4567')).toBe('35I4567');
    expect(normalizePlate('35 İ 4567')).toBe('35I4567');
    expect(normalizePlate('34abc12')).toBe('34ABC12');
  });

  it('Turk plaka bicimi: il kodu 01-81, harf sayisina gore rakam sayisi, Q/W/X ve Turkce harf yok', () => {
    for (const ok of ['34ABC123', '34ABC12', '06AB1234', '06AB123', '35A1234', '35A12345', '01A1234', '81ZZ999']) expect(isTurkishPlate(ok)).toBe(true);
    for (const bad of ['00ABC123', '82AB123', '34ABCD12', '34A123', '34AB12', '34ABC1234', '34ABC1', '34QA123', '34WX123', '34ÇA123', 'ABC123', '34ABC', '3ABC123']) expect(isTurkishPlate(bad)).toBe(false);
    expect(formatPlate('34ABC123')).toBe('34 ABC 123');
    expect(formatPlate('06AB1234')).toBe('06 AB 1234');
    expect(formatPlate('DE12345')).toBe('DE12345');
    expect(reversePlate('34ABC123')).toBe('321CBA43');
  });

  it('arama girdisi: en az 3 harf/rakam, en fazla 9', () => {
    expect(plateQuery('c 123', 3)).toBe('C123');
    expect(plateQuery('12', 3)).toBeUndefined();
    expect(plateQuery('34 ABC 123 45', 3)).toBeUndefined();
    expect(plateQuery('12*3', 3)).toBeUndefined();
  });

  it('kisa kod: karisan karakter yok, modulo yanliligi yok, girdi normalize', () => {
    expect(SHORT_CODE_ALPHABET).not.toMatch(/[01ILO]/);
    const code = newShortCode();
    expect(code).toMatch(new RegExp(`^[${SHORT_CODE_ALPHABET}]{8}$`));
    // 248 ve ustu baytlar atilir (31'lik alfabe): yalnizca 255 gelen kaynakta ilerleme 2. turda.
    let calls = 0;
    expect(newShortCode((n) => new Uint8Array(n).fill(calls++ === 0 ? 255 : 0))).toBe('22222222');
    expect(normalizeShortCode('k7m2-pq4x')).toBe('K7M2PQ4X');
    expect(normalizeShortCode('K7M2 PQ4')).toBeUndefined();
    expect(normalizeShortCode('K7M2PQ40')).toBeUndefined();
    expect(tokenHash('abc')).toMatch(/^[a-f0-9]{64}$/);
    // Kisa kod apartmanla tuzlanir: ayni kod iki apartmanda farkli ozet.
    expect(codeHash('apt-1', 'K7M2PQ4X')).not.toBe(codeHash('apt-2', 'K7M2PQ4X'));
  });

  it('Istanbul takvimi ve dizin TTL', () => {
    expect(istanbulDay(new Date('2026-11-27T21:30:00.000Z'))).toBe('2026-11-28');
    expect(istanbulDayStart('2026-11-28')).toBe('2026-11-27T21:00:00.000Z');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(daySpan('2026-11-27', '2026-11-27')).toBe(1);
    expect(daySpan('2026-11-27', '2026-12-27')).toBe(31);
    // 30.11 bitisli gecisin dizini 01.12 + 7 gun = 08.12 Istanbul gece yarisi dusur.
    expect(new Date(indexTtl('2026-11-30', 7) * 1000).toISOString()).toBe('2026-12-07T21:00:00.000Z');
  });

  it('gecis karari: iptal > kullanildi > suresi doldu > baslamadi > gecerli; cikis iceride ise', () => {
    const p = { status: 'active' as const, validFrom: '2026-11-27', validUntil: '2026-11-28', inside: false };
    expect(passVerdict(p, '2026-11-27')).toBe('valid');
    expect(passVerdict(p, '2026-11-28')).toBe('valid');
    expect(passVerdict(p, '2026-11-29')).toBe('expired');
    expect(passVerdict(p, '2026-11-26')).toBe('not_yet_valid');
    expect(passVerdict({ ...p, status: 'used' }, '2026-11-29')).toBe('used');
    expect(passVerdict({ ...p, status: 'revoked' }, '2026-11-27')).toBe('revoked');
    expect(passActions({ inside: true }, 'revoked')).toEqual({ canEnter: false, canExit: true });
    expect(passActions({ inside: false }, 'valid')).toEqual({ canEnter: true, canExit: false });
    // Kati kural: iceride olan misafir (cok girisli de) cikis kaydedilmeden yeniden giremez.
    expect(passActions({ inside: true }, 'valid')).toEqual({ canEnter: false, canExit: true });
    expect(hostLeft('valid', false)).toBe('host_left');
    expect(hostLeft('not_yet_valid', false)).toBe('host_left');
    expect(hostLeft('expired', false)).toBe('expired');
    expect(hostLeft('valid', true)).toBe('valid');
  });
});

describe('arac kaydi', () => {
  it('sakin oturdugu bolume plaka ekler (normalize); oturmayan malik ve baska bolum reddedilir', async () => {
    const w = gateWorld();
    const { vehicle } = await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34 abc 123', note: 'Beyaz Fiat' });
    expect(vehicle).toMatchObject({ plate: '34ABC123', plateDisplay: '34 ABC 123', unitLabel: 'A Blok · Daire 5', status: 'active', note: 'Beyaz Fiat', version: 1 });
    expect(vehicle).not.toHaveProperty('createdBy');
    await expect(w.service.createVehicle(ctxs.tenant, { unitId: 'u2', plate: '34 ABD 123' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createVehicle(ctxs.owner, { unitId: 'u1', plate: '34 ABD 123' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34 ABCD 1' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.createVehicle(ctxs.guard, { unitId: 'u1', plate: '34 ABD 123' })).rejects.toMatchObject({ code: 'forbidden' });
    // Sakin denetim kaydi yazmaz; yalnizca yonetici islemleri denetlenir.
    expect(w.fake.audits).toEqual([]);
    expect((await w.service.listVehicles(ctxs.tenant)).items.map((v) => v.plate)).toEqual(['34ABC123']);
    expect((await w.service.listVehicles(ctxs.other)).items).toEqual([]);
    expect((await w.service.listVehicles(ctxs.owner)).items).toEqual([]);
  });

  it('aktif plaka apartmanda tekil; pasife alininca baska bolume kaydedilebilir; ayni anda iki kayitta biri kazanir', async () => {
    const w = gateWorld();
    const { vehicle } = await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34ABC123' });
    await expect(w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34 ABC 123' })).rejects.toMatchObject({ code: 'plate_taken', message: expect.stringContaining('bu bağımsız bölümde') });
    const taken = w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '34ABC123' });
    // Sakine diger bolumun hangisi oldugu soylenmez.
    await expect(taken).rejects.toMatchObject({ code: 'plate_taken', message: expect.stringContaining('yönetimle iletişime') });
    await w.service.updateVehicle(ctxs.tenant, vehicle.vehicleId, { version: 1, status: 'inactive' });
    const moved = await w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '34ABC123' });
    expect(moved.vehicle.unitId).toBe('u2');
    // Eski arac yeniden etkinlestirilemez: plaka artik u2'de aktif.
    await expect(w.service.updateVehicle(ctxs.tenant, vehicle.vehicleId, { version: 2, status: 'active' })).rejects.toMatchObject({ code: 'plate_taken' });

    const race = await Promise.allSettled([
      w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '06AB1234' }),
      w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '06AB1234' }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'plate_taken' } });
  });

  it(`bolum basina en fazla ${MAX_VEHICLES_PER_UNIT} aktif arac; pasif arac sayilmaz`, async () => {
    const w = gateWorld();
    const ids: string[] = [];
    for (let i = 0; i < MAX_VEHICLES_PER_UNIT; i++) ids.push((await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: `34AB${100 + i}` })).vehicle.vehicleId);
    await expect(w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34AB999' })).rejects.toMatchObject({ code: 'limit_reached' });
    await w.service.updateVehicle(ctxs.tenant, ids[0] as string, { version: 1, status: 'inactive' });
    await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34AB999' });
    await expect(w.service.updateVehicle(ctxs.tenant, ids[0] as string, { version: 2, status: 'active' })).rejects.toMatchObject({ code: 'limit_reached' });
  });

  it('yonetici tum bolumlere ekler / duzeltir (denetimli); sakin baskasinin aracina dokunamaz; surum kontrolu', async () => {
    const w = gateWorld();
    const { vehicle } = await w.service.createVehicle(ctxs.mgr, { unitId: 'u2', plate: '35 A 1234' });
    expect(w.fake.audits).toEqual([{ apartmentId: APT, action: 'gate.vehicle.create', target: { type: 'vehicle', id: vehicle.vehicleId }, details: { unitId: 'u2' } }]);
    await expect(w.service.updateVehicle(ctxs.tenant, vehicle.vehicleId, { version: 1, status: 'inactive' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.updateVehicle(ctxs.mgr, vehicle.vehicleId, { version: 9, note: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    const noted = await w.service.updateVehicle(ctxs.mgr, vehicle.vehicleId, { version: 1, note: 'Gri Renault' });
    expect(noted.vehicle).toMatchObject({ note: 'Gri Renault', version: 2 });
    expect(w.fake.audits.at(-1)).toMatchObject({ action: 'gate.vehicle.update', details: { unitId: 'u2', from: 'active', to: 'active', noteChanged: true } });
    await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34ABC123' });
    const all = await w.service.listVehicles(ctxs.mgr);
    expect(all.items.map((v) => [v.plate, v.unitLabel])).toEqual([
      ['34ABC123', 'A Blok · Daire 5'],
      ['35A1234', 'B Blok · Daire 12'],
    ]);
    expect((await w.service.listVehicles(ctxs.mgr, { unitId: 'u2' })).items).toHaveLength(1);
    expect((await w.service.listVehicles(ctxs.mgr, { q: 'abc' })).items).toHaveLength(1);
    // Var olmayan / pasif bolum.
    await expect(w.service.createVehicle(ctxs.mgr, { unitId: 'u9', plate: '34ABC124' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('arac: tasinma ve sinir (inceleme duzeltmeleri)', () => {
  it('sahibi tasinan arac gorevliye pasif gorunur, sinira sayilmaz; yeni sakin plakayi devralir', async () => {
    const w = gateWorld();
    const old = (await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34ABC123', note: 'Beyaz Fiat' })).vehicle;
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    const hit = (await w.service.lookupPlate(ctxs.guard, '34ABC123')).items[0];
    expect(hit).toMatchObject({ registered: true, active: false });
    // Yonetici listesinde isaretli.
    expect((await w.service.listVehicles(ctxs.mgr)).items[0]).toMatchObject({ vehicleId: old.vehicleId, status: 'active', ownerLeft: true });
    // Yeni kiraci: onceki sakinin aracini gormez, plakayi kendi adina kaydeder (devralma).
    w.moveIn('new-tenant', 'u1', '2026-11-28');
    w.at('2026-11-28T09:00:00.000Z');
    const newTenant = { apartmentId: APT, userId: 'new-tenant', role: 'resident' };
    expect((await w.service.listVehicles(newTenant)).items).toEqual([]);
    await expect(w.service.updateVehicle(newTenant, old.vehicleId, { version: 1, status: 'inactive' })).rejects.toMatchObject({ code: 'not_found' });
    const taken = (await w.service.createVehicle(newTenant, { unitId: 'u1', plate: '34 ABC 123' })).vehicle;
    expect((await w.service.lookupPlate(ctxs.guard, '34ABC123')).items[0]).toMatchObject({ active: true, unitLabel: 'A Blok · Daire 5' });
    expect(w.fake.items.get(`APT#${APT}|VEH#${old.vehicleId}`)).toMatchObject({ status: 'inactive', version: 2 });
    expect(w.fake.items.get(`APT#${APT}|VEH#${taken.vehicleId}`)).toMatchObject({ ownerUserId: 'new-tenant' });
    // Yonetici kaydinin sahibi yoktur: yonetim pasife alana kadar aktif kalir.
    const byMgr = (await w.service.createVehicle(ctxs.mgr, { unitId: 'u2', plate: '06AB1234' })).vehicle;
    expect(w.fake.items.get(`APT#${APT}|VEH#${byMgr.vehicleId}`)).not.toHaveProperty('ownerUserId');
  });

  it('bolum siniri es zamanli eklemede de asilmaz (VEHSLOT# surum kosulu)', async () => {
    const w = gateWorld();
    for (let i = 0; i < MAX_VEHICLES_PER_UNIT - 1; i++) await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: `34AB${100 + i}` });
    const race = await Promise.allSettled([
      w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34AB998' }),
      w.service.createVehicle(ctxs.mgr, { unitId: 'u1', plate: '34AB999' }),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'limit_reached' } });
    expect((await w.service.listVehicles(ctxs.tenant)).items.filter((v) => v.status === 'active')).toHaveLength(MAX_VEHICLES_PER_UNIT);
    expect(w.fake.items.get(`APT#${APT}|VEHSLOT#u1`)).toMatchObject({ version: MAX_VEHICLES_PER_UNIT });
  });
});

describe('gorevli plaka sorgusu', () => {
  it('tam ve sondan eslesme; yalnizca bolum, kayit durumu ve not doner (kisisel veri yok)', async () => {
    const w = gateWorld();
    const a = await w.service.createVehicle(ctxs.tenant, { unitId: 'u1', plate: '34ABC123', note: 'Beyaz Fiat' });
    await w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '06YZ123' });
    await w.service.createVehicle(ctxs.other, { unitId: 'u2', plate: '06YZ456' });
    const exact = await w.service.lookupPlate(ctxs.guard, '34 abc 123');
    expect(exact.query).toBe('34ABC123');
    expect(exact.items).toEqual([{ plate: '34ABC123', plateDisplay: '34 ABC 123', unitId: 'u1', unitLabel: 'A Blok · Daire 5', registered: true, active: true, exact: true, note: 'Beyaz Fiat' }]);
    const suffix = await w.service.lookupPlate(ctxs.guard, '123');
    expect(suffix.items.map((i) => i.plate).sort()).toEqual(['06YZ123', '34ABC123']);
    expect((await w.service.lookupPlate(ctxs.guard, 'Z456')).items.map((i) => i.unitLabel)).toEqual(['B Blok · Daire 12']);
    expect((await w.service.lookupPlate(ctxs.guard, '34ZZ999')).items).toEqual([]);
    // Pasif arac: kayitli ama aktif degil.
    await w.service.updateVehicle(ctxs.tenant, a.vehicle.vehicleId, { version: 1, status: 'inactive' });
    expect((await w.service.lookupPlate(ctxs.guard, '34ABC123')).items[0]).toMatchObject({ registered: true, active: false });
    await expect(w.service.lookupPlate(ctxs.guard, '12')).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.lookupPlate(ctxs.tenant, '34ABC123')).rejects.toMatchObject({ code: 'forbidden' });
    // Baska apartmanin gorevlisi bu apartmanin plakasini goremez (anahtarlar JWT apartmanindan).
    expect((await w.service.lookupPlate(ctxs.guardApt2, '34ABC123')).items).toEqual([]);
  });
});

describe('API rol matrisi', () => {
  it('gorevli / yonetici / sakin / denetci / bina gorevlisi; apartman claim zorunlu', async () => {
    const w = gateWorld();
    expect((await w.call('POST', '/api/portal/gate/vehicles', ctxs.tenant, { unitId: 'u1', plate: '34 ABC 123' })).status).toBe(201);
    expect((await w.call('GET', '/api/gate/plates?q=34ABC123', ctxs.guard)).json).toMatchObject({ items: [{ unitLabel: 'A Blok · Daire 5', active: true }] });
    expect((await w.call('GET', '/api/gate/plates?q=34ABC123', ctxs.mgr)).status).toBe(200);
    for (const ctx of [ctxs.tenant, ctxs.observer, ctxs.staff]) expect((await w.call('GET', '/api/gate/plates?q=34ABC123', ctx)).status).toBe(403);
    expect((await w.call('GET', '/api/gate/vehicles', ctxs.guard)).status).toBe(403);
    expect((await w.call('GET', '/api/gate/vehicles', ctxs.firm)).json.items).toHaveLength(1);
    expect((await w.call('POST', '/api/gate/vehicles', ctxs.guard, { unitId: 'u1', plate: '34ABC124' })).status).toBe(403);
    expect((await w.call('GET', '/api/portal/gate', ctxs.guard)).status).toBe(403);
    expect((await w.call('GET', '/api/portal/gate', ctxs.tenant)).json).toMatchObject({ units: [{ unitId: 'u1', label: 'A Blok · Daire 5' }], limits: { maxVehiclesPerUnit: MAX_VEHICLES_PER_UNIT } });
    expect((await w.call('GET', '/api/portal/gate', ctxs.owner)).json.units).toEqual([]);
    const dup = await w.call('POST', '/api/portal/gate/vehicles', ctxs.tenant, { unitId: 'u1', plate: '34ABC123' });
    expect(dup).toMatchObject({ status: 409, json: { error: 'plate_taken' } });
    const bad = await w.call('POST', '/api/portal/gate/vehicles', ctxs.tenant, { unitId: 'u1', plate: 'ABC' });
    expect(bad).toMatchObject({ status: 400, json: { error: 'validation_error', field: 'plate' } });
    const noApt = await w.call('GET', '/api/gate/plates?q=123', { apartmentId: '', userId: 'guard-1', role: 'security_guard' });
    expect(noApt.status).toBe(403);
    const units = await w.call('GET', '/api/gate/units?q=a blok', ctxs.guard);
    expect(units.json.items).toEqual([
      { unitId: 'u1', label: 'A Blok · Daire 5' },
      { unitId: 'u3', label: 'A Blok · Daire 7' },
    ]);
  });
});
