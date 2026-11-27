/**
 * Guvenlik kapisi (2): misafir gecisi (rastgele QR jetonu + kisa kod, gecerlilik, tek / cok giris,
 * iptal, kullanildi, suresi doldu, tek girislikte yaris), kurye kaydi ve sakin onayi, kapi gunlugu
 * (yonetici tarih filtresi, gorevli dun + bugun, sakin yalnizca kendi bolumu), kiraci izolasyonu ve
 * DynamoDB deposunun kosullu yazimlari.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { codeHash, tokenHash } from '../src/modules/gate/model.js';
import { GateConflictError, createGateRepository, decodeCursor, encodeCursor } from '../src/modules/gate/repository.js';
import { APT, DAY, T0, ctxs, gateWorld } from './fakes/gateWorld.js';

describe('misafir gecisi', () => {
  it('sakin olusturur: rastgele jeton + kisa kod; QR jetonunda kisisel veri yok; dizin anahtari jetonun ozeti', async () => {
    const w = gateWorld();
    const p = await w.pass(ctxs.tenant, { validUntil: '2026-11-29', entryMode: 'multi', plate: '34 kl 42', note: 'Akşam 7 gibi' });
    expect(p).toMatchObject({ unitLabel: 'A Blok · Daire 5', guestName: 'Mehmet Misafir', validFrom: DAY, validUntil: '2026-11-29', entryMode: 'multi', plate: '34KL42', status: 'active', verdict: 'valid', mine: true, canRevoke: true, entryCount: 0, inside: false });
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(p.shortCode).toMatch(/^[2-9A-HJKMNP-Z]{8}$/);
    expect(p.token).not.toContain('Mehmet');
    const tokenIdx = w.fake.byPrefix(APT, 'GPTOK#');
    expect(tokenIdx.map((i) => i.SK)).toEqual([`GPTOK#${tokenHash(p.token as string)}`]);
    expect(tokenIdx[0]).toMatchObject({ passId: p.passId, ttl: Math.floor(Date.parse('2026-12-06T21:00:00.000Z') / 1000) });
    expect(w.fake.byPrefix(APT, 'GPCODE#')[0]).toMatchObject({ SK: `GPCODE#${codeHash(APT, p.shortCode as string)}`, passId: p.passId });
    // Jeton ve kod kayitta acik tutulmaz: yalnizca ozetler.
    const stored = w.fake.byPrefix(APT, 'GPASS#')[0] as Record<string, unknown>;
    expect(stored).not.toHaveProperty('token');
    expect(stored).not.toHaveProperty('shortCode');
    const everything = JSON.stringify([...w.fake.items.values()]);
    expect(everything).not.toContain(p.token as string);
    expect(everything).not.toContain(p.shortCode as string);
    expect(stored).toMatchObject({ tokenHash: tokenHash(p.token as string), codeHash: codeHash(APT, p.shortCode as string) });
    // Ayni daireyi paylasan sakin gorur (jetonsuz), baska daire ve oturmayan malik gormez.
    const listed = (await w.service.listPasses(ctxs.tenant)).items;
    expect(listed.map((x) => x.passId)).toEqual([p.passId]);
    expect(listed[0]).not.toHaveProperty('token');
    expect(listed[0]).toMatchObject({ canRotate: true });
    expect((await w.service.listPasses(ctxs.other)).items).toEqual([]);
    expect((await w.service.listPasses(ctxs.owner)).items).toEqual([]);
    // Yonetici jeton / kod gormez.
    const mgr = (await w.service.listPasses(ctxs.mgr)).items[0];
    expect(mgr).toMatchObject({ passId: p.passId, guestName: 'Mehmet Misafir' });
    expect(mgr).not.toHaveProperty('token');
    expect(mgr).not.toHaveProperty('shortCode');
  });

  it('dogrulama kurallari ve idempotent olusturma; kisa kod cakismasinda yeni kod', async () => {
    const w = gateWorld({ codes: ['K7M2PQ4X', 'K7M2PQ4X', 'ABCD2345'] });
    const body = { idempotencyKey: 'pk-1', unitId: 'u1', guestName: 'Ayşe', validFrom: DAY, entryMode: 'single' };
    const first = await w.service.createPass(ctxs.tenant, body);
    expect((await w.service.createPass(ctxs.tenant, body)).replayed).toBe(true);
    await expect(w.service.createPass(ctxs.tenant, { ...body, guestName: 'Başka' })).rejects.toMatchObject({ code: 'conflict' });
    const second = await w.service.createPass(ctxs.tenant, { ...body, idempotencyKey: 'pk-2' });
    expect([first.pass.shortCode, second.pass.shortCode]).toEqual(['K7M2PQ4X', 'ABCD2345']);
    const bad = (extra: Record<string, unknown>) => w.service.createPass(ctxs.tenant, { ...body, idempotencyKey: w.key(), ...extra });
    await expect(bad({ validFrom: '2026-11-26' })).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ validUntil: '2026-11-26' })).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ validUntil: '2026-12-28' })).rejects.toMatchObject({ message: expect.stringContaining('31 gün') });
    await expect(bad({ validFrom: '2027-03-01' })).rejects.toMatchObject({ field: 'validFrom' });
    await expect(bad({ entryMode: 'often' })).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ guestName: 'A' })).rejects.toBeInstanceOf(ValidationError);
    await expect(bad({ unitId: 'u2' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createPass(ctxs.owner, { ...body, idempotencyKey: 'pk-9' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createPass(ctxs.guard, { ...body, idempotencyKey: 'pk-9' })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gorevli QR jetonu veya kisa kodla gorur: misafir, ev sahibi bolum, gecerlilik; sakin kimligi ve jeton yok', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const byToken = (await w.service.verifyPass(ctxs.guard, { token: p.token })).pass;
    expect(byToken).toMatchObject({ passId: p.passId, guestName: 'Mehmet Misafir', unitLabel: 'A Blok · Daire 5', verdict: 'valid', canEnter: true, canExit: false, entryMode: 'single' });
    for (const field of ['token', 'shortCode', 'createdBy', 'mine', 'createdByRole']) expect(byToken).not.toHaveProperty(field);
    const code = `${(p.shortCode as string).slice(0, 4).toLowerCase()}-${(p.shortCode as string).slice(4)}`;
    expect((await w.service.verifyPass(ctxs.guard, { code })).pass.passId).toBe(p.passId);
    await expect(w.service.verifyPass(ctxs.guard, { code: 'ZZZZ2222' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.verifyPass(ctxs.guard, { token: 'x'.repeat(24) })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.verifyPass(ctxs.guard, { token: '../../etc' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.verifyPass(ctxs.guard, { code: 'short' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.verifyPass(ctxs.guard, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.verifyPass(ctxs.tenant, { token: p.token })).rejects.toMatchObject({ code: 'forbidden' });
    // Kiraci izolasyonu: baska apartmanin gorevlisi gecerli jetonla da bulamaz.
    await expect(w.service.verifyPass(ctxs.guardApt2, { token: p.token })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.verifyPass(ctxs.guardApt2, { code: p.shortCode })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('tek girislik: giris -> kullanildi, ikinci giris reddedilir; cikis kaydedilir; ayni anahtarla tekrar tek kayit', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const entry = await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-1' });
    expect(entry.pass).toMatchObject({ verdict: 'used', inside: true, entryCount: 1, canEnter: false, canExit: true });
    expect(entry.log).toMatchObject({ direction: 'entry', kind: 'guest', unitLabel: 'A Blok · Daire 5', visitorName: 'Mehmet Misafir', passId: p.passId });
    // Cift dokunma: ayni anahtar, ikinci kayit yok.
    expect((await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'e-1' })).replayed).toBe(true);
    await expect(w.service.passEntry(ctxs.guard2, p.passId, { idempotencyKey: 'e-2' })).rejects.toMatchObject({ code: 'pass_used', httpStatus: 409 });
    const exit = await w.service.passExit(ctxs.guard, p.passId, { idempotencyKey: 'x-1' });
    expect(exit.pass).toMatchObject({ inside: false, canExit: false });
    await expect(w.service.passExit(ctxs.guard, p.passId, { idempotencyKey: 'x-2' })).rejects.toMatchObject({ code: 'not_inside' });
    expect(w.fake.byPrefix(APT, 'GLOG#').map((e) => e.direction)).toEqual(['entry', 'exit']);
    expect(w.fake.byPrefix(APT, 'GLOGU#u1#')).toHaveLength(2);
    // Kullanilan gecisin jetonu sakine artik donmez.
    const mine = (await w.service.listPasses(ctxs.tenant)).items[0];
    expect(mine).toMatchObject({ verdict: 'used', canRevoke: false });
    expect(mine).not.toHaveProperty('token');
  });

  it('tek girislik yaris: iki gorevli ayni anda okutursa kosullu yazimla yalnizca biri girer', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const results = await Promise.allSettled([
      w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: 'race-a' }),
      w.service.passEntry(ctxs.guard2, p.passId, { idempotencyKey: 'race-b' }),
      w.service.passEntry(ctxs.mgr, p.passId, { idempotencyKey: 'race-c' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2 - 1);
    expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(['pass_used', 'pass_used']);
    expect(w.fake.byPrefix(APT, 'GLOG#')).toHaveLength(1);
    expect(w.fake.byPrefix(APT, `GPASS#${p.passId}`)[0]).toMatchObject({ entryCount: 1, status: 'used' });
  });

  it('cok girisli: gecerlilik boyunca tekrar girer; suresi dolunca ve baslamadan once reddedilir', async () => {
    const w = gateWorld();
    const multi = await w.pass(ctxs.tenant, { entryMode: 'multi', validFrom: '2026-11-28', validUntil: '2026-11-29' });
    await expect(w.service.passEntry(ctxs.guard, multi.passId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'pass_not_yet_valid' });
    w.at('2026-11-28T08:00:00.000Z');
    await w.service.passEntry(ctxs.guard, multi.passId, { idempotencyKey: w.key() });
    // Kati kural: cikis kaydedilmeden ikinci giris yok.
    expect((await w.service.verifyPass(ctxs.guard, { token: multi.token })).pass).toMatchObject({ verdict: 'valid', canEnter: false, canExit: true, message: expect.stringContaining('önce çıkışını') });
    await expect(w.service.passEntry(ctxs.guard2, multi.passId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'already_inside', httpStatus: 409 });
    await w.service.passExit(ctxs.guard, multi.passId, { idempotencyKey: w.key() });
    const again = await w.service.passEntry(ctxs.guard, multi.passId, { idempotencyKey: w.key() });
    expect(again.pass).toMatchObject({ entryCount: 2, verdict: 'valid', canEnter: false, inside: true });
    expect(w.fake.byPrefix(APT, 'GLOG#').map((e) => e.direction)).toEqual(['entry', 'exit', 'entry']);
    // 30.11 00:30 Istanbul: suresi doldu; iceride kalan misafirin cikisi yine kaydedilir.
    w.at('2026-11-29T21:30:00.000Z');
    expect((await w.service.verifyPass(ctxs.guard, { token: multi.token })).pass).toMatchObject({ verdict: 'expired', message: 'Bu geçişin süresi doldu', canEnter: false, canExit: true });
    await expect(w.service.passEntry(ctxs.guard, multi.passId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'pass_expired' });
    await w.service.passExit(ctxs.guard, multi.passId, { idempotencyKey: w.key() });
    expect((await w.service.listPasses(ctxs.tenant, { status: 'past' })).items).toHaveLength(1);
    expect((await w.service.listPasses(ctxs.tenant, { status: 'active' })).items).toHaveLength(0);
  });

  it('gecis sahibi tasininca gorevli reddeder; yeni kiraci onceki sakinin gecislerini gormez / yonetemez', async () => {
    const w = gateWorld();
    const p = await w.pass(ctxs.tenant, { entryMode: 'multi', validUntil: '2026-11-30' });
    w.moveOut('tenant-u1', 'u1', '2026-11-26');
    const seen = (await w.service.verifyPass(ctxs.guard, { token: p.token })).pass;
    expect(seen).toMatchObject({ verdict: 'host_left', message: 'Geçiş sahibi artık bu dairede oturmuyor', canEnter: false });
    await expect(w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'pass_host_left', message: 'Geçiş sahibi artık bu dairede oturmuyor' });
    expect((await w.service.listPasses(ctxs.mgr)).items[0]).toMatchObject({ verdict: 'host_left' });
    // Tasinan sakin artik bolume erisemez; yeni kiraci eski gecisi (misafir adi dahil) hic gormez.
    expect((await w.service.listPasses(ctxs.tenant)).items).toEqual([]);
    w.moveIn('new-tenant', 'u1', '2026-11-28');
    w.at('2026-11-28T09:00:00.000Z');
    const newTenant = { apartmentId: APT, userId: 'new-tenant', role: 'resident' };
    expect((await w.service.listPasses(newTenant)).items).toEqual([]);
    await expect(w.service.revokePass(newTenant, p.passId, { version: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.rotatePass(newTenant, p.passId, { version: 1 })).rejects.toMatchObject({ code: 'not_found' });
    // Yeni kiracinin kendi gecisi normal calisir.
    const own = await w.pass(newTenant, { validFrom: '2026-11-28' });
    expect((await w.service.verifyPass(ctxs.guard, { code: own.shortCode })).pass.verdict).toBe('valid');
  });

  it('devir gunu: onceki sakinin ayni gun olusan gecis, kurye ve kapi kayitlari yeni sakine gorunmez (zaman damgasi)', async () => {
    const w = gateWorld();
    const old = await w.pass();
    const oldCourier = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1', company: 'Getir' })).courier;
    await w.service.passEntry(ctxs.guard, old.passId, { idempotencyKey: w.key() });
    // Ayni gun devir: eski kiraci bugun son gun (hala oturuyor), yeni kiracinin uyeligi 10:00'da yazildi.
    w.endsOn('tenant-u1', 'u1', '2026-11-27');
    w.moveIn('new-tenant', 'u1', '2026-11-27', '2026-11-27T10:00:00.000Z');
    const newTenant = { apartmentId: APT, userId: 'new-tenant', role: 'resident' };
    w.at('2026-11-27T11:00:00.000Z');
    expect((await w.service.listPasses(newTenant)).items).toEqual([]);
    expect((await w.service.listCouriers(newTenant)).items).toEqual([]);
    await expect(w.service.respondCourier(newTenant, oldCourier.courierId, { version: 1, decision: 'approve' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.listLog(newTenant)).items).toEqual([]);
    // Eski kiraci devir gunu yeni gecis olustursa da yeni sakin gormez (ayni gun, baska uye).
    const late = await w.pass(ctxs.tenant, { guestName: 'Geç Misafir' });
    expect((await w.service.listPasses(newTenant)).items).toEqual([]);
    await expect(w.service.revokePass(newTenant, late.passId, { version: 1 })).rejects.toMatchObject({ code: 'not_found' });
    // Uyelikten sonra gelen kurye ve yeni sakinin kendi gecisi gorunur.
    w.at('2026-11-27T12:00:00.000Z');
    const fresh = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1', company: 'Trendyol' })).courier;
    const own = await w.pass(newTenant, { guestName: 'Yeni Misafir' });
    expect((await w.service.listCouriers(newTenant)).items.map((c) => c.courierId)).toEqual([fresh.courierId]);
    expect((await w.service.listPasses(newTenant)).items.map((p) => p.passId)).toEqual([own.passId]);
  });

  it('Yeni QR olustur: jeton ve kod yenilenir, eskileri calismaz; yalnizca yanitta doner', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const rotated = (await w.service.rotatePass(ctxs.tenant, p.passId, { version: 1 })).pass;
    expect(rotated.token).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(rotated.token).not.toBe(p.token);
    expect(rotated.shortCode).not.toBe(p.shortCode);
    await expect(w.service.verifyPass(ctxs.guard, { token: p.token })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.verifyPass(ctxs.guard, { code: p.shortCode })).rejects.toMatchObject({ code: 'not_found' });
    expect((await w.service.verifyPass(ctxs.guard, { token: rotated.token })).pass.passId).toBe(p.passId);
    expect((await w.service.verifyPass(ctxs.guard, { code: rotated.shortCode })).pass.passId).toBe(p.passId);
    await expect(w.service.rotatePass(ctxs.tenant, p.passId, { version: 1 })).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.service.rotatePass(ctxs.guard, p.passId, { version: 2 })).rejects.toMatchObject({ code: 'forbidden' });
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: w.key() });
    await expect(w.service.rotatePass(ctxs.tenant, p.passId, { version: 3 })).rejects.toMatchObject({ code: 'invalid_state' });
    expect((await w.call('POST', `/api/portal/gate/passes/${p.passId}/rotate`, ctxs.guard, { version: 3 })).status).toBe(403);
  });

  it('iptal: sakin (kendi dairesi) veya yonetici (denetimli); iptal edilen gecis reddedilir', async () => {
    const w = gateWorld();
    const a = await w.pass();
    await expect(w.service.revokePass(ctxs.other, a.passId, { version: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.revokePass(ctxs.tenant, a.passId, { version: 7 })).rejects.toMatchObject({ code: 'conflict' });
    const revoked = await w.service.revokePass(ctxs.tenant, a.passId, { version: 1 });
    expect(revoked.pass).toMatchObject({ status: 'revoked', verdict: 'revoked', canRevoke: false });
    expect(revoked.pass).not.toHaveProperty('token');
    expect((await w.service.revokePass(ctxs.tenant, a.passId, { version: 1 })).pass.status).toBe('revoked');
    await expect(w.service.passEntry(ctxs.guard, a.passId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'pass_revoked', message: expect.stringContaining('iptal') });
    expect(w.fake.audits).toEqual([]);
    const b = await w.pass();
    await w.service.revokePass(ctxs.mgr, b.passId, { version: 1 });
    expect(w.fake.audits).toEqual([{ apartmentId: APT, action: 'gate.pass.revoke', target: { type: 'guest_pass', id: b.passId }, details: { unitId: 'u1' } }]);
    const c = await w.pass();
    await w.service.passEntry(ctxs.guard, c.passId, { idempotencyKey: w.key() });
    await expect(w.service.revokePass(ctxs.tenant, c.passId, { version: 2 })).rejects.toMatchObject({ code: 'invalid_state' });
  });
});

describe('kurye', () => {
  it('gorevli kaydeder, sakin onaylar, gorevli giris / cikis yazar; baska bolum goremez', async () => {
    const w = gateWorld();
    const body = { idempotencyKey: 'c-1', unitId: 'u1', company: 'Trendyol', note: 'Koli' };
    const { courier } = await w.service.createCourier(ctxs.guard, body);
    expect((await w.service.createCourier(ctxs.guard, body)).replayed).toBe(true);
    expect(courier).toMatchObject({ unitLabel: 'A Blok · Daire 5', status: 'waiting', company: 'Trendyol', canEnter: false, canCancel: true, canRespond: false });
    expect(courier.respondBy).toBe('2026-11-27T10:00:00.000Z');
    const mine = (await w.service.listCouriers(ctxs.tenant)).items;
    expect(mine).toMatchObject([{ courierId: courier.courierId, status: 'waiting', canRespond: true }]);
    expect(mine[0]).not.toHaveProperty('createdBy');
    expect((await w.service.listCouriers(ctxs.other)).items).toEqual([]);
    expect((await w.service.listCouriers(ctxs.owner)).items).toEqual([]);
    await expect(w.service.respondCourier(ctxs.other, courier.courierId, { version: 1, decision: 'approve' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(w.service.courierEntry(ctxs.guard, courier.courierId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'invalid_state', message: expect.stringContaining('henüz onaylamadı') });

    const approved = await w.service.respondCourier(ctxs.tenant, courier.courierId, { version: 1, decision: 'approve', note: 'Kapıya bıraksın' });
    expect(approved.courier).toMatchObject({ status: 'approved', responseNote: 'Kapıya bıraksın', canRespond: false });
    await expect(w.service.respondCourier(ctxs.tenant, courier.courierId, { version: 2, decision: 'decline' })).rejects.toMatchObject({ code: 'invalid_state' });
    const desk = (await w.service.listCouriers(ctxs.guard, { status: 'open' })).items[0];
    expect(desk).toMatchObject({ status: 'approved', canEnter: true });
    expect(desk).not.toHaveProperty('respondedBy');
    const entered = await w.service.courierEntry(ctxs.guard, courier.courierId, { idempotencyKey: 'ce-1' });
    expect(entered.courier).toMatchObject({ canEnter: false, canExit: true, canCancel: false });
    expect(entered.log).toMatchObject({ kind: 'courier', direction: 'entry', company: 'Trendyol', unitLabel: 'A Blok · Daire 5' });
    expect((await w.service.courierEntry(ctxs.guard, courier.courierId, { idempotencyKey: 'ce-1' })).replayed).toBe(true);
    await expect(w.service.courierEntry(ctxs.guard, courier.courierId, { idempotencyKey: 'ce-2' })).rejects.toMatchObject({ code: 'invalid_state' });
    await w.service.courierExit(ctxs.guard, courier.courierId, { idempotencyKey: 'cx-1' });
    await expect(w.service.courierExit(ctxs.guard, courier.courierId, { idempotencyKey: 'cx-2' })).rejects.toMatchObject({ code: 'not_inside' });
    expect((await w.service.listCouriers(ctxs.guard, { status: 'open' })).items).toEqual([]);
    expect(w.fake.byPrefix(APT, 'GLOG#').map((e) => [e.kind, e.direction])).toEqual([
      ['courier', 'entry'],
      ['courier', 'exit'],
    ]);
  });

  it('red ve gorevli kapatmasi; yanit suresi dolunca onaylanamaz; sakin kurye kaydedemez', async () => {
    const w = gateWorld();
    const a = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1' })).courier;
    await w.service.respondCourier(ctxs.tenant, a.courierId, { version: 1, decision: 'decline' });
    await expect(w.service.courierEntry(ctxs.guard, a.courierId, { idempotencyKey: w.key() })).rejects.toMatchObject({ message: 'Daire sakini kuryeyi reddetti' });
    const b = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1', company: 'Yemeksepeti' })).courier;
    const closed = await w.service.cancelCourier(ctxs.guard, b.courierId, { version: 1 });
    expect(closed.courier.status).toBe('cancelled');
    await expect(w.service.respondCourier(ctxs.tenant, b.courierId, { version: 2, decision: 'approve' })).rejects.toMatchObject({ message: 'Görevli bu kaydı kapattı' });
    const c = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1' })).courier;
    w.at('2026-11-27T10:00:01.000Z');
    expect((await w.service.listCouriers(ctxs.tenant)).items.find((x) => x.courierId === c.courierId)).toMatchObject({ expired: true, canRespond: false });
    await expect(w.service.respondCourier(ctxs.tenant, c.courierId, { version: 1, decision: 'approve' })).rejects.toMatchObject({ code: 'response_expired' });
    await expect(w.service.createCourier(ctxs.tenant, { idempotencyKey: w.key(), unitId: 'u1' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u9' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('onayin suresi var: onaydan 2 saat sonra kurye iceri alinamaz, acik listeden duser', async () => {
    const w = gateWorld();
    const c = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1', company: 'Getir' })).courier;
    await w.service.respondCourier(ctxs.tenant, c.courierId, { version: 1, decision: 'approve' });
    expect((await w.service.listCouriers(ctxs.guard, { status: 'open' })).items[0]).toMatchObject({ canEnter: true, approvalExpired: false, enterBy: '2026-11-27T11:00:00.000Z' });
    w.at('2026-11-27T11:00:01.000Z');
    expect((await w.service.listCouriers(ctxs.guard)).items[0]).toMatchObject({ canEnter: false, approvalExpired: true, canCancel: true });
    expect((await w.service.listCouriers(ctxs.guard, { status: 'open' })).items).toEqual([]);
    await expect(w.service.courierEntry(ctxs.guard, c.courierId, { idempotencyKey: w.key() })).rejects.toMatchObject({ code: 'approval_expired', httpStatus: 409 });
  });

  it('yeni sakin onceki sakinin kuryelerini ve kapi kayitlarini gormez (uyelik baslangici)', async () => {
    const w = gateWorld();
    const c = (await w.service.createCourier(ctxs.guard, { idempotencyKey: w.key(), unitId: 'u1' })).courier;
    const p = await w.pass();
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: w.key() });
    w.moveOut('tenant-u1', 'u1', '2026-11-27');
    w.moveIn('new-tenant', 'u1', '2026-11-28');
    w.at('2026-11-28T09:00:00.000Z');
    const newTenant = { apartmentId: APT, userId: 'new-tenant', role: 'resident' };
    expect((await w.service.listCouriers(newTenant)).items).toEqual([]);
    await expect(w.service.respondCourier(newTenant, c.courierId, { version: 1, decision: 'approve' })).rejects.toMatchObject({ code: 'not_found' });
    const log = await w.service.listLog(newTenant, { from: '2026-01-01' });
    expect(log).toMatchObject({ from: '2026-11-28', items: [] });
    // Yonetici donemin tamamini gorur.
    expect((await w.service.listLog(ctxs.mgr, { from: '2026-11-27', unitId: 'u1' })).items).toHaveLength(1);
  });
});

describe('kapi gunlugu', () => {
  async function seeded() {
    const w = gateWorld();
    const p = await w.pass();
    await w.service.passEntry(ctxs.guard, p.passId, { idempotencyKey: w.key() });
    await w.service.recordManual(ctxs.guard, { idempotencyKey: 'm-1', direction: 'entry', visitorName: 'Elektrikçi Hasan', unitId: 'u2', plate: '34 TT 1234', note: 'Sayaç' });
    w.at('2026-11-20T09:00:00.000Z');
    await w.service.recordManual(ctxs.mgr, { idempotencyKey: w.key(), direction: 'entry', visitorName: 'Bahçıvan' });
    w.at(T0);
    return w;
  }

  it('yonetici tarih / tur / bolum filtresiyle listeler, kaydi yapan gorevlinin adini gorur; sayfalama', async () => {
    const w = await seeded();
    const week = await w.service.listLog(ctxs.mgr);
    expect(week).toMatchObject({ from: '2026-11-21', to: DAY });
    expect(week.items.map((e) => e.visitorName)).toEqual(['Elektrikçi Hasan', 'Mehmet Misafir']);
    expect(week.items[0]).toMatchObject({ kind: 'manual', unitLabel: 'B Blok · Daire 12', plate: '34TT1234', plateDisplay: '34 TT 1234', recordedBy: 'guard-1', recordedByName: 'Ali Güvenlik' });
    const all = await w.service.listLog(ctxs.mgr, { from: '2026-11-01', to: DAY });
    expect(all.items.map((e) => e.visitorName)).toEqual(['Elektrikçi Hasan', 'Mehmet Misafir', 'Bahçıvan']);
    expect((await w.service.listLog(ctxs.mgr, { from: '2026-11-01', kind: 'guest' })).items.map((e) => e.kind)).toEqual(['guest']);
    expect((await w.service.listLog(ctxs.mgr, { from: '2026-11-01', unitId: 'u2' })).items.map((e) => e.visitorName)).toEqual(['Elektrikçi Hasan']);
    expect((await w.service.listLog(ctxs.mgr, { from: '2026-11-20', to: '2026-11-20' })).items.map((e) => e.visitorName)).toEqual(['Bahçıvan']);
    const page1 = await w.service.listLog(ctxs.mgr, { from: '2026-11-01', limit: '2' });
    expect(page1.items).toHaveLength(2);
    const page2 = await w.service.listLog(ctxs.mgr, { from: '2026-11-01', limit: '2', cursor: page1.nextCursor });
    expect(page2.items.map((e) => e.visitorName)).toEqual(['Bahçıvan']);
    await expect(w.service.listLog(ctxs.mgr, { from: '2026-11-30', to: DAY })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.listLog(ctxs.mgr, { kind: 'drone' })).rejects.toBeInstanceOf(ValidationError);
    await expect(w.service.listLog(ctxs.mgr, { cursor: 'bozuk!' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('gorevli yalnizca dun ve bugunu gorur; sakin yalnizca oturdugu bolumu, kaydedeni gormez', async () => {
    const w = await seeded();
    const guard = await w.service.listLog(ctxs.guard, { from: '2026-11-01' });
    expect(guard.from).toBe('2026-11-26');
    expect(guard.items.map((e) => e.visitorName)).toEqual(['Elektrikçi Hasan', 'Mehmet Misafir']);
    const tenant = await w.service.listLog(ctxs.tenant, { from: '2026-11-01' });
    expect(tenant.items.map((e) => e.visitorName)).toEqual(['Mehmet Misafir']);
    expect(tenant.items[0]).not.toHaveProperty('recordedBy');
    expect(tenant.items[0]).not.toHaveProperty('recordedByName');
    expect((await w.service.listLog(ctxs.other, { from: '2026-11-01' })).items.map((e) => e.visitorName)).toEqual(['Elektrikçi Hasan']);
    await expect(w.service.listLog(ctxs.tenant, { unitId: 'u2' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await w.service.listLog(ctxs.owner)).items).toEqual([]);
    await expect(w.service.listLog(ctxs.observer)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.listLog(ctxs.staff)).rejects.toMatchObject({ code: 'forbidden' });
    // Baska apartman: ayni bolumde (anahtarlar JWT apartmanindan) hicbir kayit yok.
    expect((await w.service.listLog(ctxs.guardApt2)).items).toEqual([]);
  });

  it('elle kayit: idempotent; gunluk yalnizca eklenir (kosul attribute_not_exists), silme / guncelleme yok', async () => {
    const w = await seeded();
    const body = { idempotencyKey: 'm-1', direction: 'entry', visitorName: 'Elektrikçi Hasan', unitId: 'u2', plate: '34 TT 1234', note: 'Sayaç' };
    expect((await w.service.recordManual(ctxs.guard, body)).replayed).toBe(true);
    await expect(w.service.recordManual(ctxs.guard, { ...body, visitorName: 'Başka' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(w.service.recordManual(ctxs.tenant, { ...body, idempotencyKey: 'm-2' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(w.service.recordManual(ctxs.guard, { ...body, idempotencyKey: 'm-3', direction: 'sideways' })).rejects.toBeInstanceOf(ValidationError);
    const logPuts = w.fake.writes.flatMap((wr) => wr.puts).filter((i) => String(i.SK).startsWith('GLOG'));
    // Her gunluk ogesi bir kez yazildi (ustune yazim yok).
    expect(new Set(logPuts.map((i) => i.SK)).size).toBe(logPuts.length);
    expect(logPuts.every((i) => !('ttl' in i))).toBe(true);
  });
});

describe('API (gecis + kurye)', () => {
  it('rol matrisi ve hata kodlari', async () => {
    const w = gateWorld();
    const created = await w.call('POST', '/api/portal/gate/passes', ctxs.tenant, { idempotencyKey: 'api-1', unitId: 'u1', guestName: 'Can', validFrom: DAY, entryMode: 'single' });
    expect(created.status).toBe(201);
    expect((await w.call('POST', '/api/portal/gate/passes', ctxs.tenant, { idempotencyKey: 'api-1', unitId: 'u1', guestName: 'Can', validFrom: DAY, entryMode: 'single' })).status).toBe(200);
    const token = created.json.pass.token as string;
    expect((await w.call('POST', '/api/portal/gate/passes', ctxs.guard, { idempotencyKey: 'api-2' })).status).toBe(403);
    expect((await w.call('POST', '/api/gate/passes/verify', ctxs.tenant, { token })).status).toBe(403);
    expect((await w.call('POST', '/api/gate/passes/verify', ctxs.observer, { token })).status).toBe(403);
    const verified = await w.call('POST', '/api/gate/passes/verify', ctxs.guard, { token });
    expect(verified.json.pass).toMatchObject({ guestName: 'Can', verdict: 'valid' });
    const id = verified.json.pass.passId as string;
    expect((await w.call('POST', `/api/gate/passes/${id}/entry`, ctxs.guard, { idempotencyKey: 'g-1' })).status).toBe(200);
    expect(await w.call('POST', `/api/gate/passes/${id}/entry`, ctxs.guard, { idempotencyKey: 'g-2' })).toMatchObject({ status: 409, json: { error: 'pass_used', message: 'Bu tek girişlik geçiş daha önce kullanıldı' } });
    expect((await w.call('POST', `/api/gate/passes/${id}/revoke`, ctxs.guard, { version: 2 })).status).toBe(403);
    expect((await w.call('POST', '/api/gate/passes/verify', ctxs.guardApt2, { token })).status).toBe(404);
    expect((await w.call('GET', '/api/gate/passes', ctxs.mgr)).json.items).toHaveLength(1);
    expect((await w.call('GET', '/api/gate/passes', ctxs.guard)).status).toBe(403);

    const courier = await w.call('POST', '/api/gate/couriers', ctxs.guard, { idempotencyKey: 'k-1', unitId: 'u1', company: 'Getir' });
    expect(courier.status).toBe(201);
    const cid = courier.json.courier.courierId as string;
    expect((await w.call('POST', `/api/portal/gate/couriers/${cid}/respond`, ctxs.guard, { version: 1, decision: 'approve' })).status).toBe(403);
    expect((await w.call('POST', `/api/portal/gate/couriers/${cid}/respond`, ctxs.other, { version: 1, decision: 'approve' })).status).toBe(404);
    expect((await w.call('POST', `/api/portal/gate/couriers/${cid}/respond`, ctxs.tenant, { version: 1, decision: 'approve' })).json.courier.status).toBe('approved');
    expect((await w.call('GET', '/api/portal/gate/log', ctxs.tenant)).json.items).toHaveLength(1);
    expect((await w.call('GET', '/api/gate/log', ctxs.guard)).json.items[0]).toMatchObject({ recordedByName: 'Ali Güvenlik' });
    expect((await w.call('GET', '/api/gate/log', ctxs.observer)).status).toBe(403);
    expect((await w.call('POST', '/api/gate/log', ctxs.guard, { idempotencyKey: 'l-1', direction: 'exit', visitorName: 'Can' })).status).toBe(201);
  });
});

describe('guvenlik kapisi deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const item = (sk: string) => ({ PK: `APT#${APT}`, SK: sk });

  it('kosullar ifadeye cevrilir; yalnizca Put (Delete yok); iptal nedeni ogeye gore', async () => {
    const repo = createGateRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.write(APT, {
      puts: [
        { item: item('GIDEM#k'), condition: { kind: 'new' }, reason: 'duplicate' },
        { item: item('GPASS#p'), condition: { kind: 'match', fields: { version: 3, status: 'active', entryCount: 0 } }, reason: 'version' },
        { item: item('VPLATE#321CBA43'), condition: { kind: 'new_or', fields: { status: 'inactive' } }, reason: 'plate' },
        { item: item('VEHU#u1#v'), condition: { kind: 'none' }, reason: 'exists' },
      ],
    });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((i) => Object.keys(i)[0])).toEqual(['Put', 'Put', 'Put', 'Put']);
    expect(items[0]?.Put?.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(items[1]?.Put).toMatchObject({
      ConditionExpression: 'attribute_exists(PK) AND #c0 = :c0 AND #c1 = :c1 AND #c2 = :c2',
      ExpressionAttributeNames: { '#c0': 'version', '#c1': 'status', '#c2': 'entryCount' },
      ExpressionAttributeValues: { ':c0': 3, ':c1': 'active', ':c2': 0 },
    });
    expect(items[2]?.Put?.ConditionExpression).toBe('attribute_not_exists(PK) OR (#c0 = :c0)');
    expect(items[3]?.Put?.ConditionExpression).toBeUndefined();

    ddb.on(TransactWriteCommand).callsFake((input: { TransactItems: unknown[] }) => {
      throw new TransactionCanceledException({ message: 'iptal', $metadata: {}, CancellationReasons: input.TransactItems.map((_, i) => ({ Code: i === 1 ? 'ConditionalCheckFailed' : 'None' })) });
    });
    const err = await repo.write(APT, { puts: [{ item: item('A#1'), condition: { kind: 'new' }, reason: 'duplicate' }, { item: item('B#1'), condition: { kind: 'new' }, reason: 'code' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateConflictError);
    expect(err).toMatchObject({ reason: 'code' });
    await expect(repo.write(APT, { puts: [{ item: { PK: 'APT#baska', SK: 'X#1' }, condition: { kind: 'new' }, reason: 'exists' }] })).rejects.toThrow(/Kiraci/);
  });

  it('gunluk araligi BETWEEN ile, en yeni once; imlec yalnizca SK tasir ve bu kiracinin bolumune baglanir', async () => {
    const repo = createGateRepository();
    ddb.on(QueryCommand).resolves({ Items: [item('GLOG#2026-11-27T09:00:00.000Z#a')], LastEvaluatedKey: item('GLOG#2026-11-27T09:00:00.000Z#a') });
    const page = await repo.query(APT, { from: 'GLOG#2026-11-20', to: 'GLOG#2026-11-28', desc: true, limit: 2 });
    const input = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ KeyConditionExpression: '#pk = :pk AND #sk BETWEEN :from AND :to', ScanIndexForward: false, Limit: 2, ExpressionAttributeValues: { ':pk': `APT#${APT}` } });
    expect(decodeCursor(page.cursor)).toBe('GLOG#2026-11-27T09:00:00.000Z#a');
    await repo.query(APT, { prefix: 'VPLATE#321', cursor: encodeCursor({ PK: 'APT#baska', SK: 'VPLATE#3210' }) });
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: `APT#${APT}`, SK: 'VPLATE#3210' });
  });
});
