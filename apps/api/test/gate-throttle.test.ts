/**
 * Guvenlik kapisi deneme siniri: QR / kisa kod dogrulamasi ve plaka aramasi icin kullanici ve
 * apartman basina sayac (15 dk sabit pencere, TTL), basarisiz kisa kodun agir sayilmasi, 429 +
 * Retry-After, pencere donunce acilma, kilitlenmenin denetimi ve metrigi, kiraci izolasyonu ve
 * DynamoDB kosullu UpdateItem bicimi.
 */
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createGateRepository } from '../src/modules/gate/repository.js';
import {
  FAILED_CODE_PENALTY,
  GateRateLimitError,
  THROTTLE_LIMITS,
  THROTTLE_WINDOW_SECONDS,
  createGateThrottle,
  crossed,
  retryAfterSeconds,
  throttleKeys,
  windowOf,
} from '../src/modules/gate/throttle.js';
import { createFakeGateRepo } from './fakes/gateRepo.js';
import { APT, APT2, T0, ctxs, gateWorld } from './fakes/gateWorld.js';

const lockouts = (audits: { action: string }[]) => audits.filter((a) => a.action === 'gate.lockout');

describe('pencere yardimcilari', () => {
  it('sabit 15 dk pencere, Retry-After pencere sonuna kadar (en az 1 sn), esigi ilk gecen yazim', () => {
    const now = Date.parse(T0) + 125_000;
    const w = windowOf(now);
    expect(w.end - w.start).toBe(THROTTLE_WINDOW_SECONDS);
    expect(w.start % THROTTLE_WINDOW_SECONDS).toBe(0);
    expect(w.start * 1000).toBeLessThanOrEqual(now);
    expect(retryAfterSeconds(now, w)).toBe(Math.ceil(w.end - now / 1000));
    expect(retryAfterSeconds(w.end * 1000, w)).toBe(1);
    expect(crossed(60, 1, 60)).toBe(true);
    expect(crossed(61, 1, 60)).toBe(false);
    expect(crossed(64, 6, 60)).toBe(true);
    expect(crossed(59, 6, 60)).toBe(false);
    expect(throttleKeys.user('verify', 'guard-1', w.start)).toBe(`GTHR#verify#U#guard-1#${w.start}`);
    expect(throttleKeys.apartment('plates', w.start)).toBe(`GTHR#plates#A#${w.start}`);
  });
});

describe('dogrulama deneme siniri (servis)', () => {
  it('basarisiz kisa kod agir sayilir: 10 hatali kod sonra gecerli kod da 429; kilitlenme bir kez denetlenir', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const failures = Math.ceil(THROTTLE_LIMITS.verify.user / (1 + FAILED_CODE_PENALTY));
    for (let i = 0; i < failures; i++) {
      await expect(w.service.verifyPass(ctxs.guard, { code: 'ZZZZ2222' })).rejects.toMatchObject({ code: 'not_found' });
    }
    const err = await w.service.verifyPass(ctxs.guard, { code: p.shortCode }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GateRateLimitError);
    expect(err).toMatchObject({ httpStatus: 429, kind: 'verify', scope: 'user' });
    expect((err as GateRateLimitError).retryAfterSeconds).toBeGreaterThan(0);
    expect((err as GateRateLimitError).retryAfterSeconds).toBeLessThanOrEqual(THROTTLE_WINDOW_SECONDS);
    // Kilitli istekler sayaci buyutmez; kilitlenme yalnizca esik gecilirken bir kez denetlenir.
    await expect(w.service.verifyPass(ctxs.guard, { token: p.token })).rejects.toBeInstanceOf(GateRateLimitError);
    const locks = lockouts(w.fake.audits);
    expect(locks).toHaveLength(1);
    expect(locks[0]).toMatchObject({ apartmentId: APT, target: { type: 'user', id: 'guard-1' }, details: { kind: 'verify', scope: 'user', role: 'security_guard', limit: THROTTLE_LIMITS.verify.user } });
    // Kullanici basina: ayni apartmandaki ikinci gorevli etkilenmez.
    expect((await w.service.verifyPass(ctxs.guard2, { code: p.shortCode })).pass.passId).toBe(p.passId);
  });

  it('basarili okumalar 1 puan: sinir kadar gecerli sorgu gecer, sonraki 429; pencere donunce acilir', async () => {
    const w = gateWorld();
    const p = await w.pass();
    for (let i = 0; i < THROTTLE_LIMITS.verify.user; i++) await w.service.verifyPass(ctxs.guard, { token: p.token });
    await expect(w.service.verifyPass(ctxs.guard, { token: p.token })).rejects.toMatchObject({ code: 'rate_limited' });
    const w0 = windowOf(Date.parse(T0));
    expect(w.fake.byPrefix(APT, `GTHR#verify#U#guard-1#${w0.start}`)[0]).toMatchObject({ count: THROTTLE_LIMITS.verify.user, ttl: w0.end + 3600, entityType: 'GATE_THROTTLE' });
    // Yeni pencere: yeni sayac, istek gecer (eski sayac TTL ile duser).
    w.at(new Date(w0.end * 1000 + 1000).toISOString());
    expect((await w.service.verifyPass(ctxs.guard, { token: p.token })).pass.passId).toBe(p.passId);
    expect(w.fake.byPrefix(APT, `GTHR#verify#U#guard-1#${w0.end}`)[0]).toMatchObject({ count: 1 });
  });

  it('dogrulama hatasi (bicimsiz kod) sayilmaz; bicimsiz QR jetonu hafif ceza (2 puan)', async () => {
    const w = gateWorld();
    await expect(w.service.verifyPass(ctxs.guard, { code: 'short' })).rejects.toMatchObject({ field: 'code' });
    expect(w.fake.hits).toEqual([]);
    await expect(w.service.verifyPass(ctxs.guard, { token: '../../etc' })).rejects.toMatchObject({ code: 'not_found' });
    const w0 = windowOf(Date.parse(T0));
    expect(w.fake.byPrefix(APT, throttleKeys.user('verify', 'guard-1', w0.start))[0]).toMatchObject({ count: 2 });
    // Apartman sayaci yalnizca ceza puani tasir (basarili / taban puan yok).
    expect(w.fake.byPrefix(APT, throttleKeys.apartment('verify', w0.start))[0]).toMatchObject({ count: 1 });
  });

  it('limiti asmis kullanici 429 aldikca apartman sayaci sabit kalir; diger gorevliler etkilenmez', async () => {
    const w = gateWorld();
    const p = await w.pass();
    const failures = Math.ceil(THROTTLE_LIMITS.verify.user / (1 + FAILED_CODE_PENALTY));
    for (let i = 0; i < failures; i++) await expect(w.service.verifyPass(ctxs.guard, { code: 'ZZZZ2222' })).rejects.toMatchObject({ code: 'not_found' });
    const w0 = windowOf(Date.parse(T0));
    const aptCount = () => (w.fake.byPrefix(APT, throttleKeys.apartment('verify', w0.start))[0] as { count?: number } | undefined)?.count ?? 0;
    const before = aptCount();
    expect(before).toBe(failures * FAILED_CODE_PENALTY);
    for (let i = 0; i < 50; i++) await expect(w.service.verifyPass(ctxs.guard, { code: 'ZZZZ2222' })).rejects.toMatchObject({ code: 'rate_limited', scope: 'user' });
    expect(aptCount()).toBe(before);
    expect((await w.service.verifyPass(ctxs.guard2, { code: p.shortCode })).pass.passId).toBe(p.passId);
  });

  it('cok gorevli, cok basarili okuma: apartman siniri hic tetiklenmez (yogun site kendini kilitlemez)', async () => {
    const w = gateWorld();
    const p = await w.pass();
    // 8 gorevli x 40 basarili okuma = 320 istek (eski apartman siniri 300'u asar), paralel gorevliler.
    const guards = Array.from({ length: 8 }, (_, i) => ({ apartmentId: APT, userId: `guard-x${i}`, role: 'security_guard' }));
    await Promise.all(guards.map(async (g) => {
      for (let i = 0; i < 40; i++) await w.service.verifyPass(g, { token: p.token });
    }));
    const w0 = windowOf(Date.parse(T0));
    expect(w.fake.byPrefix(APT, throttleKeys.apartment('verify', w0.start))).toEqual([]);
    expect(lockouts(w.fake.audits)).toEqual([]);
    expect((await w.service.verifyPass(ctxs.guard, { token: p.token })).pass.passId).toBe(p.passId);
  });

  it('HTTP: 429 + Retry-After basligi ve Turkce mesaj; plaka aramasi da sayilir', async () => {
    const w = gateWorld();
    for (let i = 0; i < Math.ceil(THROTTLE_LIMITS.verify.user / (1 + FAILED_CODE_PENALTY)); i++) {
      expect((await w.call('POST', '/api/gate/passes/verify', ctxs.guard, { code: 'ZZZZ2222' })).status).toBe(404);
    }
    const res = await w.call('POST', '/api/gate/passes/verify', ctxs.guard, { code: 'ZZZZ2222' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBe(res.json.retryAfterSeconds);
    expect(res.json).toMatchObject({ error: 'rate_limited', message: expect.stringContaining('dakika sonra') });
    // Plaka aramasi ayri sayac: dogrulama kilidi plaka aramasini kapatmaz.
    expect((await w.call('GET', '/api/gate/plates?q=34ABC', ctxs.guard)).status).toBe(200);
    const w0 = windowOf(Date.parse(T0));
    expect(w.fake.byPrefix(APT, throttleKeys.user('plates', 'guard-1', w0.start))[0]).toMatchObject({ count: 1 });
    // Kisa plaka sorgusu (dogrulama hatasi) sayilmaz.
    expect((await w.call('GET', '/api/gate/plates?q=34', ctxs.guard)).status).toBe(400);
    expect(w.fake.byPrefix(APT, throttleKeys.user('plates', 'guard-1', w0.start))[0]).toMatchObject({ count: 1 });
  });
});

describe('deneme siniri (sayac mantigi)', () => {
  const subject = (ctx: { apartmentId: string; userId: string; role: string }) => ctx;
  function limiter(limits: Parameters<typeof createGateThrottle>[0]['limits'] = { verify: { user: 20, apartment: 8 }, plates: { user: 3 } }) {
    const fake = createFakeGateRepo();
    let now = new Date(T0);
    const metrics: { metrics: Record<string, number>; props?: Record<string, unknown> }[] = [];
    const t = createGateThrottle({ store: fake.repo, now: () => now, metrics: { emit: (m, props) => metrics.push({ metrics: m, ...(props ? { props } : {}) }) }, limits });
    return { fake, t, metrics, at: (iso: string) => (now = new Date(iso)) };
  }

  it('apartman sayaci tum gorevlilerin basarisizlik cezalarini toplar; dolunca herkes 429; diger apartman ayri; denetim + metrik', async () => {
    const l = limiter();
    for (const g of [ctxs.guard, ctxs.guard2]) {
      await l.t.consume(subject(g), 'verify');
      await l.t.penalize(subject(g), 'verify', 4);
    }
    // 8 ceza puani: apartman siniri doldu; ucuncu kisi (yonetici) de 429 alir.
    const err = await l.t.consume(subject(ctxs.mgr), 'verify').catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'rate_limited', scope: 'apartment' });
    // Baska apartman etkilenmez (sayaclar kiracinin bolumunde).
    await l.t.consume(subject(ctxs.guardApt2), 'verify');
    expect(l.fake.byPrefix(APT2, 'GTHR#')).toHaveLength(1);
    expect(lockouts(l.fake.audits)).toEqual([
      expect.objectContaining({ apartmentId: APT, target: { type: 'apartment', id: APT }, details: expect.objectContaining({ scope: 'apartment', kind: 'verify', limit: 8 }) }),
    ]);
    expect(l.metrics).toEqual([{ metrics: { GateLockout: 1 }, props: { msg: 'gate_lockout', apartmentId: APT, kind: 'verify', scope: 'apartment' } }]);
  });

  it('plaka aramasinda apartman sayaci yok (yalnizca kullanici)', async () => {
    const l = limiter();
    for (let i = 0; i < 3; i++) await l.t.consume(subject(ctxs.guard), 'plates');
    await expect(l.t.consume(subject(ctxs.guard), 'plates')).rejects.toMatchObject({ scope: 'user' });
    await l.t.consume(subject(ctxs.guard2), 'plates');
    expect(l.fake.byPrefix(APT, 'GTHR#plates#A#')).toEqual([]);
  });

  it('ceza esigi gecirince kilitlenme denetlenir (bir kez); tur bazli ayri sayac; pencere donunce sifir', async () => {
    const l = limiter({ verify: { user: 5, apartment: 100 }, plates: { user: 3 } });
    await l.t.consume(subject(ctxs.guard), 'verify');
    await l.t.penalize(subject(ctxs.guard), 'verify', 5);
    expect(lockouts(l.fake.audits)).toHaveLength(1);
    await l.t.penalize(subject(ctxs.guard), 'verify', 5);
    expect(lockouts(l.fake.audits)).toHaveLength(1);
    await expect(l.t.consume(subject(ctxs.guard), 'verify')).rejects.toMatchObject({ scope: 'user' });
    // Plaka sayaci ayri.
    await l.t.consume(subject(ctxs.guard), 'plates');
    // Pencere donunce yeni sayac; Retry-After yeni pencerenin sonuna kadar.
    const w0 = windowOf(Date.parse(T0));
    l.at(new Date(w0.end * 1000).toISOString());
    await l.t.consume(subject(ctxs.guard), 'verify');
    for (let i = 0; i < 3; i++) await l.t.consume(subject(ctxs.guard), 'plates');
    const err = (await l.t.consume(subject(ctxs.guard), 'plates').catch((e: unknown) => e)) as GateRateLimitError;
    expect(err).toBeInstanceOf(GateRateLimitError);
    expect(err.retryAfterSeconds).toBe(THROTTLE_WINDOW_SECONDS);
  });

  it('denetim yazilamazsa istek yine reddedilir (sinir sayactadir)', async () => {
    const l = limiter({ verify: { user: 1, apartment: 10 }, plates: { user: 1 } });
    l.fake.repo.audit = async () => {
      throw new Error('denetim kapali');
    };
    await l.t.consume(subject(ctxs.guard), 'verify');
    await expect(l.t.consume(subject(ctxs.guard), 'verify')).rejects.toBeInstanceOf(GateRateLimitError);
  });
});

describe('deneme sayaci deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('kosullu ADD + TTL (if_not_exists); kosulsuz cezada kosul yok; kosul bozulursa ok: false', async () => {
    const repo = createGateRepository();
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 3 } });
    expect(await repo.hit(APT, 'GTHR#verify#U#g#100', 1, { limit: 60, ttl: 4600 })).toEqual({ ok: true, count: 3 });
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      Key: { PK: `APT#${APT}`, SK: 'GTHR#verify#U#g#100' },
      UpdateExpression: 'ADD #count :w SET #et = :et, #apt = :apt, #ttl = if_not_exists(#ttl, :ttl)',
      ConditionExpression: 'attribute_not_exists(#count) OR #count < :limit',
      ExpressionAttributeNames: { '#count': 'count', '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':w': 1, ':limit': 60, ':ttl': 4600, ':et': 'GATE_THROTTLE' },
    });
    ddb.on(UpdateCommand).resolves({ Attributes: { count: 9 } });
    expect(await repo.hit(APT, 'GTHR#verify#U#g#100', 5, { ttl: 4600 })).toEqual({ ok: true, count: 9 });
    const penalty = ddb.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(penalty.ConditionExpression).toBeUndefined();
    expect(penalty.ExpressionAttributeValues).not.toHaveProperty(':limit');
    ddb.on(UpdateCommand).rejects(new ConditionalCheckFailedException({ message: 'kosul', $metadata: {} }));
    expect(await repo.hit(APT, 'GTHR#verify#A#100', 1, { limit: 300, ttl: 4600 })).toEqual({ ok: false, count: 300 });
  });
});
