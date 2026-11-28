/**
 * Mobil push cihaz kaydi (`/api/me/devices`): token dogrulamasi, kullanici basina aktif cihaz siniri,
 * ortak telefonda token'in yeni kullaniciya tasinmasi, kullanici yalitimi, token'in API yanitlarina /
 * denetim ayrintisina / API okumalarina girmemesi ve DynamoDB yazim bicimi.
 */
import { ConditionalCheckFailedException, TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, createMockIdentityResolver, encodeMockToken } from '../src/auth/authenticators.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { ValidationError } from '../src/modules/core/validation.js';
import {
  MAX_ACTIVE_DEVICES,
  createDeviceService,
  createDynamoDeviceRepository,
  deviceIdOf,
  deviceKeys,
  isExpoPushToken,
  parseDeviceInput,
} from '../src/modules/notifications/devices.js';
import { createFakeDeviceRepo } from './fakes/deviceRepo.js';

const NOW = new Date('2026-11-28T09:00:00.000Z');
const token = (n: number | string) => `ExponentPushToken[tok${String(n).padStart(8, '0')}xyzABC]`;

/** Her cagrida 1 dk ilerleyen saat (lastSeenAt sirasi belirgin olsun). */
function clock(start = NOW) {
  let t = start.getTime();
  return () => new Date((t += 60_000));
}

describe('token ve govde dogrulamasi', () => {
  it('Expo token bicimleri kabul, digerleri red', () => {
    for (const ok of ['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', 'ExpoPushToken[AbC_123-xyz9]']) expect(isExpoPushToken(ok), ok).toBe(true);
    for (const bad of ['', 'ExponentPushToken[]', 'ExponentPushToken[abc]', 'ExponentPushToken[xxxxxxxxxxxx', 'fcm:APA91bH-raw-token', 'ExponentPushToken[xxxxxxxx xxxx]', `ExponentPushToken[${'a'.repeat(201)}]`, 'ExponentPushToken[xxxxxxxxxx]#x']) {
      expect(isExpoPushToken(bad), bad).toBe(false);
    }
  });

  it('govde: platform ios|android, istege bagli surum / dil; bilinmeyen alan reddedilir', () => {
    expect(parseDeviceInput({ token: token(1), platform: 'ios', appVersion: '1.2.0', locale: 'tr-TR' })).toEqual({ token: token(1), platform: 'ios', appVersion: '1.2.0', locale: 'tr-TR' });
    expect(parseDeviceInput({ token: token(1), platform: 'android' })).toEqual({ token: token(1), platform: 'android' });
    for (const bad of [
      null,
      {},
      { token: token(1) },
      { token: token(1), platform: 'web' },
      { token: 'abc', platform: 'ios' },
      { token: token(1), platform: 'ios', appVersion: '1.0 beta' },
      { token: token(1), platform: 'ios', appVersion: 'x'.repeat(40) },
      { token: token(1), platform: 'ios', locale: 'türkçe' },
      { token: token(1), platform: 'ios', userId: 'baska' },
    ]) {
      expect(() => parseDeviceInput(bad), JSON.stringify(bad)).toThrow(ValidationError);
    }
  });

  it('cihaz kimligi token ozetidir: anahtarlarda ham token yok', () => {
    const id = deviceIdOf(token(1));
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(deviceIdOf(token(1))).toBe(id);
    expect(deviceIdOf(token(2))).not.toBe(id);
    expect(JSON.stringify([deviceKeys.device('user-1', id), deviceKeys.owner(id)])).not.toContain('tok0000');
    expect(deviceKeys.device('user-1', id)).toEqual({ PK: 'USER#user-1', SK: `PUSHDEV#${id}` });
    expect(deviceKeys.owner(id)).toEqual({ PK: `PUSHTOKEN#${id}`, SK: 'OWNER' });
    expect(() => deviceKeys.device('a#b', id)).toThrow();
  });
});

describe('cihaz servisi', () => {
  it('kayit + tazeleme: ilk kayit created, tekrar kayit tazeler (createdAt korunur, denetim yok)', async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    const first = await service.register('user-1', { token: token(1), platform: 'ios', appVersion: '1.0.0' });
    expect(first.created).toBe(true);
    expect(first.device).toMatchObject({ deviceId: deviceIdOf(token(1)), platform: 'ios', appVersion: '1.0.0', status: 'active' });
    expect(first.device).not.toHaveProperty('token');
    const again = await service.register('user-1', { token: token(1), platform: 'ios', appVersion: '1.1.0', locale: 'tr-TR' });
    expect(again.created).toBe(false);
    expect(again.device.createdAt).toBe(first.device.createdAt);
    expect(again.device.lastSeenAt > first.device.lastSeenAt).toBe(true);
    expect(again.device).toMatchObject({ appVersion: '1.1.0', locale: 'tr-TR' });
    expect(fake.audits.map((a) => a.action)).toEqual(['push_device.register']);
    expect(JSON.stringify(fake.audits)).not.toContain(token(1));
    expect((await service.list('user-1')).devices).toHaveLength(1);
    expect(JSON.stringify(await service.list('user-1'))).not.toContain('ExponentPushToken');
  });

  it(`aktif cihaz siniri ${MAX_ACTIVE_DEVICES}: asilinca en eski gorulen pasife alinir`, async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    for (let i = 1; i <= MAX_ACTIVE_DEVICES; i++) await service.register('user-1', { token: token(i), platform: 'android' });
    // 1. cihaz yeniden goruldu: artik en eski 2. cihaz.
    await service.register('user-1', { token: token(1), platform: 'android' });
    await service.register('user-1', { token: token(99), platform: 'ios' });
    const active = (await service.list('user-1')).devices;
    expect(active).toHaveLength(MAX_ACTIVE_DEVICES);
    expect(active.map((d) => d.deviceId)).not.toContain(deviceIdOf(token(2)));
    expect(active[0]?.deviceId).toBe(deviceIdOf(token(99))); // en son gorulen once
    expect(await fake.repository.get('user-1', deviceIdOf(token(2)))).toMatchObject({ status: 'inactive', deactivationReason: 'limit' });
    expect(fake.devices.get(`user-1|${deviceIdOf(token(2))}`)).not.toHaveProperty('token');
    expect(fake.audits.at(-1)?.details).toMatchObject({ deactivatedOldest: 1 });
  });

  it('ortak telefon: ayni token baska kullaniciyla kaydedilince cihaz yeni kullaniciya gecer', async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    const id = deviceIdOf(token(7));
    await service.register('user-a', { token: token(7), platform: 'ios' });
    const moved = await service.register('user-b', { token: token(7), platform: 'ios' });
    expect(moved.created).toBe(true);
    expect((await service.list('user-a')).devices).toEqual([]);
    expect((await service.list('user-b')).devices.map((d) => d.deviceId)).toEqual([id]);
    expect(await fake.repository.get('user-a', id)).toMatchObject({ status: 'inactive', deactivationReason: 'moved' });
    expect(fake.owners.get(id)).toBe('user-b');
    // Worker yalnizca yeni sahibe gonderir.
    expect(await fake.repository.listActiveForPush('user-a')).toEqual([]);
    expect((await fake.repository.listActiveForPush('user-b')).map((d) => d.token)).toEqual([token(7)]);
    expect(fake.audits.at(-1)).toMatchObject({ action: 'push_device.register', target: { type: 'user', id: 'user-b' }, details: { movedFromAnotherUser: true } });
    // Geri tasinma (A tekrar giris yapti): B pasif, A aktif.
    await service.register('user-a', { token: token(7), platform: 'ios' });
    expect((await service.list('user-b')).devices).toEqual([]);
    expect((await service.list('user-a')).devices).toHaveLength(1);
  });

  it("kaldirilmis cihazin token'i baska kullaniciya tasinirken eski kayda yeniden dokunulmaz", async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    const id = deviceIdOf(token(3));
    await service.register('user-a', { token: token(3), platform: 'android' });
    await service.remove('user-a', id);
    await service.register('user-b', { token: token(3), platform: 'android' });
    expect(await fake.repository.get('user-a', id)).toMatchObject({ status: 'inactive', deactivationReason: 'user' });
  });

  it('es zamanli sahiplik degisimi: yeniden okunup tekrar denenir', async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    const id = deviceIdOf(token(5));
    // Okumadan sonra, yazimdan once baska kullanici ayni token'i aldi.
    fake.hooks.beforeSave = () => {
      fake.owners.set(id, 'user-x');
      fake.devices.set(`user-x|${id}`, { deviceId: id, userId: 'user-x', platform: 'ios', status: 'active', createdAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), token: token(5) });
    };
    const r = await service.register('user-a', { token: token(5), platform: 'ios' });
    expect(r.created).toBe(true);
    expect(fake.owners.get(id)).toBe('user-a');
    expect(await fake.repository.get('user-x', id)).toMatchObject({ status: 'inactive', deactivationReason: 'moved' });
  });

  it('kaldirma: kendi cihazi pasife; baska kullanicinin cihazi 404; tekrar kaldirma zararsiz; gecersiz kimlik 400', async () => {
    const fake = createFakeDeviceRepo();
    const service = createDeviceService({ repository: fake.repository, now: clock() });
    const { device } = await service.register('user-a', { token: token(1), platform: 'ios' });
    await expect(service.remove('user-b', device.deviceId)).rejects.toMatchObject({ httpStatus: 404 });
    expect((await service.list('user-a')).devices).toHaveLength(1);
    const removed = await service.remove('user-a', device.deviceId);
    expect(removed.device).toMatchObject({ status: 'inactive', deactivationReason: 'user' });
    expect((await service.remove('user-a', device.deviceId)).device.status).toBe('inactive');
    expect(fake.audits.map((a) => a.action)).toEqual(['push_device.register', 'push_device.remove']);
    expect(fake.audits[1]?.details).toEqual({ deviceId: device.deviceId, platform: 'ios' });
    await expect(service.remove('user-a', 'not-a-device')).rejects.toBeInstanceOf(ValidationError);
    expect(await fake.repository.listActiveForPush('user-a')).toEqual([]);
  });
});

describe('/api/me/devices', () => {
  function api() {
    const fake = createFakeDeviceRepo();
    const app = createApp({
      version: 'test',
      authenticate: createMockAuthenticator(),
      identify: createMockIdentityResolver(),
      deviceService: createDeviceService({ repository: fake.repository, now: clock() }),
    });
    const call = (method: string, path: string, sub: string | undefined, body?: unknown, apartmentId = 'apt-1') =>
      app.request(`/api/me/devices${path}`, {
        method,
        headers: { ...(sub ? { authorization: `Bearer ${encodeMockToken({ sub, role: 'resident', apartmentId })}` } : {}), 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { call, fake };
  }

  it('POST 201 / 200, GET yalnizca kendi aktif cihazlari, DELETE pasife alir; yanitlarda token yok', async () => {
    const { call } = api();
    const created = await call('POST', '', 'res-1', { token: token(1), platform: 'android', appVersion: '1.0.0' });
    expect(created.status).toBe(201);
    const { device } = (await created.json()) as { device: { deviceId: string } };
    expect((await call('POST', '', 'res-1', { token: token(1), platform: 'android' })).status).toBe(200);
    const list = await call('GET', '', 'res-1');
    expect(list.headers.get('cache-control')).toBe('no-store');
    const body = await list.text();
    expect(body).not.toContain('ExponentPushToken');
    expect(JSON.parse(body).devices).toHaveLength(1);
    // Kullanici / apartman yalitimi: baska kullanici (baska apartmanda da olsa) goremez, silemez.
    expect(await (await call('GET', '', 'res-2', undefined, 'apt-2')).json()).toEqual({ devices: [] });
    expect((await call('DELETE', `/${device.deviceId}`, 'res-2', undefined, 'apt-2')).status).toBe(404);
    const del = await call('DELETE', `/${device.deviceId}`, 'res-1');
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ device: { deviceId: device.deviceId, status: 'inactive' } });
    expect(await (await call('GET', '', 'res-1')).json()).toEqual({ devices: [] });
  });

  it('kimliksiz 401; gecersiz token / platform / JSON 400', async () => {
    const { call, fake } = api();
    expect((await call('GET', '', undefined)).status).toBe(401);
    expect((await call('POST', '', undefined, { token: token(1), platform: 'ios' })).status).toBe(401);
    expect((await call('POST', '', 'res-1', { token: 'abc', platform: 'ios' })).status).toBe(400);
    expect((await call('POST', '', 'res-1', { token: token(1), platform: 'windows' })).status).toBe(400);
    expect((await call('DELETE', '/abc', 'res-1')).status).toBe(400);
    expect(fake.devices.size).toBe(0);
  });
});

describe('DynamoDB cihaz deposu', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
    delete process.env.AUDIT_TABLE_NAME;
  });
  const id = deviceIdOf(token(1));
  const old = deviceIdOf(token(2));
  const base = { deviceId: id, userId: 'user-b', platform: 'ios' as const, status: 'active' as const, createdAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), token: token(1) };

  it('API okumalari token ozniteligini projeksiyona almaz; worker okumasi alir, aktifleri en yeni once dondurur', async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { deviceId: old, userId: 'user-b', platform: 'android', status: 'active', lastSeenAt: '2026-11-01T00:00:00.000Z', token: token(2) },
        { deviceId: id, userId: 'user-b', platform: 'ios', status: 'active', lastSeenAt: '2026-11-20T00:00:00.000Z', token: token(1) },
        { deviceId: deviceIdOf(token(3)), userId: 'user-b', platform: 'ios', status: 'inactive', lastSeenAt: '2026-11-25T00:00:00.000Z' },
      ],
    });
    ddb.on(GetCommand).resolves({ Item: { deviceId: id, status: 'active' } });
    const repo = createDynamoDeviceRepository();
    await repo.listByUser('user-b');
    await repo.get('user-b', id);
    const viewQuery = ddb.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(viewQuery).toMatchObject({ KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)', ExpressionAttributeValues: { ':pk': 'USER#user-b', ':sk': 'PUSHDEV#' } });
    expect(viewQuery.ProjectionExpression).not.toMatch(/token|#tok/);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.ProjectionExpression).not.toMatch(/token|#tok/);

    const targets = await repo.listActiveForPush('user-b');
    expect(ddb.commandCalls(QueryCommand)[1]!.args[0].input.ProjectionExpression).toContain('#tok');
    expect(targets.map((t) => t.token)).toEqual([token(1), token(2)]);
  });

  it('tazeleme tek PutItem; tasima + sinir tek atomik yazim (sahiplik kosulu, pasife alinan kayitta REMOVE token)', async () => {
    ddb.on(PutCommand).resolves({});
    ddb.on(TransactWriteCommand).resolves({});
    const repo = createDynamoDeviceRepository();
    await repo.save({ device: base, owner: undefined, evict: [] });
    expect(ddb.commandCalls(PutCommand)[0]!.args[0].input.Item).toMatchObject({ PK: 'USER#user-b', SK: `PUSHDEV#${id}`, entityType: 'PUSH_DEVICE', token: token(1) });
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);

    await repo.save({ device: base, owner: { expected: 'user-a' }, moveFrom: 'user-a', evict: [old], audit: { action: 'push_device.register', target: { type: 'user', id: 'user-b' } } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items).toHaveLength(4);
    expect(items[1]!.Put).toMatchObject({ Item: { PK: `PUSHTOKEN#${id}`, SK: 'OWNER', userId: 'user-b' }, ConditionExpression: 'userId = :prev', ExpressionAttributeValues: { ':prev': 'user-a' } });
    expect(items[2]!.Update).toMatchObject({ Key: { PK: 'USER#user-a', SK: `PUSHDEV#${id}` }, ExpressionAttributeValues: { ':reason': 'moved' } });
    expect(items[2]!.Update!.UpdateExpression).toContain('REMOVE #tok');
    expect(items[3]!.Update).toMatchObject({ Key: { PK: 'USER#user-b', SK: `PUSHDEV#${old}` }, ConditionExpression: 'attribute_exists(PK) AND #st = :active', ExpressionAttributeValues: { ':reason': 'limit' } });
    // Ilk kayit: sahiplik kaydi yoksa yazilir.
    await repo.save({ device: base, owner: { expected: null }, evict: [] });
    expect(ddb.commandCalls(TransactWriteCommand)[1]!.args[0].input.TransactItems![1]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('kosul iptali DeviceWriteConflict olur; pasife alma kosulu tutmazsa false', async () => {
    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }));
    const repo = createDynamoDeviceRepository();
    await expect(repo.save({ device: base, owner: { expected: null }, evict: [] })).rejects.toMatchObject({ name: 'DeviceWriteConflict', httpStatus: 409 });

    ddb.on(UpdateCommand).rejectsOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} })).resolves({});
    expect(await repo.deactivate('user-b', id, 'device_not_registered', NOW.toISOString())).toBe(false);
    expect(await repo.deactivate('user-b', id, 'device_not_registered', NOW.toISOString())).toBe(true);
    const update = ddb.commandCalls(UpdateCommand)[1]!.args[0].input;
    expect(update.Key).toEqual({ PK: 'USER#user-b', SK: `PUSHDEV#${id}` });
    expect(update.UpdateExpression).toBe('SET #st = :inactive, deactivatedAt = :at, deactivationReason = :reason, updatedAt = :at REMOVE #tok');
  });
});
