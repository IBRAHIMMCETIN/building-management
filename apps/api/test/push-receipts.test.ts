/**
 * Expo push makbuz kontrolu (`push_receipts` zamanlanmis isi): saat kovalari, 15 dk gecikme ve 24 saat
 * geriye bakis, 1000'lik makbuz parcalari, DeviceNotRegistered -> cihaz pasife, imlec (gecici hatada
 * ilerlemez) ve DynamoDB kayit bicimi (ham token yok).
 */
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { deviceIdOf } from '../src/modules/notifications/devices.js';
import { type ExpoReceipt, TransientPushError } from '../src/modules/notifications/expo.js';
import { type PushReceiptStore, type ReceiptTicket, checkPushReceipts, createDynamoReceiptStore, hourBucket, pendingBuckets } from '../src/modules/notifications/push-receipts.js';
import { createSchedulerWorker, parseJobMessage } from '../src/workers/scheduler-worker.js';
import { createFakeDeviceRepo } from './fakes/deviceRepo.js';

const NOW = new Date('2026-11-28T09:20:00.000Z');
const quiet = { info: () => {}, error: () => {} };
const token = (n: number | string) => `ExponentPushToken[tok${String(n).padStart(8, '0')}xyzABC]`;

describe('islenecek kovalar', () => {
  it('kapanisindan en az 15 dk gecmis, son 24 saatteki kovalar; imlecten sonrasi', () => {
    const all = pendingBuckets(NOW, undefined);
    expect(all[0]).toBe('2026-11-27T09');
    expect(all.at(-1)).toBe('2026-11-28T08'); // 08:00-09:00 kovasi 09:15'te kapandi
    expect(all).toHaveLength(24);
    expect(pendingBuckets(new Date('2026-11-28T09:10:00.000Z'), undefined).at(-1)).toBe('2026-11-28T07');
    expect(pendingBuckets(NOW, '2026-11-28T06')).toEqual(['2026-11-28T07', '2026-11-28T08']);
    expect(pendingBuckets(NOW, '2026-11-28T08')).toEqual([]);
    // Cok eski imlec (is gunlerce calismadi): yalnizca makbuzun hala tutuldugu son 24 saat.
    expect(pendingBuckets(NOW, '2026-11-01T00')[0]).toBe('2026-11-27T09');
    // Ay / gun donumu.
    expect(pendingBuckets(new Date('2026-12-01T01:30:00.000Z'), '2026-11-30T22')).toEqual(['2026-11-30T23', '2026-12-01T00']);
    expect(hourBucket(new Date('2026-11-28T09:59:59.999Z'))).toBe('2026-11-28T09');
  });
});

function fakeStore(buckets: Record<string, ReceiptTicket[]>, cursor?: string) {
  const state = { cursor, listed: [] as string[] };
  const store: PushReceiptStore = {
    record: async () => {},
    listBucket: async (b) => (state.listed.push(b), buckets[b] ?? []),
    getCursor: async () => state.cursor,
    setCursor: async (b) => void (state.cursor = b),
  };
  return { store, state };
}

describe('makbuz kontrolu', () => {
  it("DeviceNotRegistered cihazi pasife alir (bir kez); diger hatalar sayilir; makbuzu olmayan 'missing'; imlec ilerler", async () => {
    const fake = createFakeDeviceRepo();
    const dead = deviceIdOf(token(1));
    const alive = deviceIdOf(token(2));
    for (const [id, t] of [[dead, token(1)], [alive, token(2)]] as const) {
      fake.devices.set(`user-1|${id}`, { deviceId: id, userId: 'user-1', platform: 'ios', status: 'active', createdAt: NOW.toISOString(), lastSeenAt: NOW.toISOString(), token: t });
    }
    const { store, state } = fakeStore(
      {
        '2026-11-28T07': [{ id: 'r1', userId: 'user-1', deviceId: dead }, { id: 'r2', userId: 'user-1', deviceId: alive }],
        '2026-11-28T08': [{ id: 'r3', userId: 'user-1', deviceId: dead }, { id: 'r4', userId: 'user-1', deviceId: alive }, { id: 'r5', userId: 'user-1', deviceId: alive }],
      },
      '2026-11-28T06',
    );
    const receipts: Record<string, ExpoReceipt> = {
      r1: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      r2: { status: 'ok' },
      r3: { status: 'error', details: { error: 'DeviceNotRegistered' } },
      r4: { status: 'error', details: { error: 'MessageTooBig' } },
    };
    const client = { getReceipts: vi.fn(async (ids: string[]) => Object.fromEntries(ids.filter((id) => receipts[id]).map((id) => [id, receipts[id] as ExpoReceipt]))) };
    const errors: string[] = [];
    const r = await checkPushReceipts({ store, client, devices: fake.repository, now: () => NOW, log: { info: () => {}, error: (m: string) => void errors.push(m) } });
    expect(r).toEqual({ buckets: 2, tickets: 5, ok: 1, missing: 1, errors: { DeviceNotRegistered: 2, MessageTooBig: 1 }, deactivated: 1, cursor: '2026-11-28T08' });
    expect(await fake.repository.get('user-1', dead)).toMatchObject({ status: 'inactive', deactivationReason: 'device_not_registered' });
    expect(await fake.repository.get('user-1', alive)).toMatchObject({ status: 'active' });
    expect(state.cursor).toBe('2026-11-28T08');
    expect(errors).toHaveLength(1);
    expect(JSON.parse(errors[0]!)).toMatchObject({ msg: 'push_receipt_errors', errors: { MessageTooBig: 1 } });
    // Ikinci calisma: yeni kova yok.
    expect(await checkPushReceipts({ store, client, devices: fake.repository, now: () => NOW, log: quiet })).toMatchObject({ buckets: 0, tickets: 0 });
  });

  it("1000'lik makbuz parcalari; gecici hata firlatilir ve imlec o kovada kalir", async () => {
    const fake = createFakeDeviceRepo();
    const many = Array.from({ length: 1500 }, (_, i) => ({ id: `r${i}`, userId: 'u', deviceId: deviceIdOf(token(i)) }));
    const { store, state } = fakeStore({ '2026-11-28T07': many, '2026-11-28T08': [{ id: 'x', userId: 'u', deviceId: deviceIdOf(token('x')) }] }, '2026-11-28T06');
    let fail = true;
    const client = {
      getReceipts: vi.fn(async (ids: string[]) => {
        if (ids.includes('x') && fail) throw new TransientPushError('HTTP 503');
        return Object.fromEntries(ids.map((id) => [id, { status: 'ok' } as ExpoReceipt]));
      }),
    };
    await expect(checkPushReceipts({ store, client, devices: fake.repository, now: () => NOW, log: quiet })).rejects.toBeInstanceOf(TransientPushError);
    expect(client.getReceipts.mock.calls.map(([ids]) => ids.length)).toEqual([1000, 500, 1]);
    expect(state.cursor).toBe('2026-11-28T07');
    fail = false;
    expect(await checkPushReceipts({ store, client, devices: fake.repository, now: () => NOW, log: quiet })).toMatchObject({ buckets: 1, tickets: 1, ok: 1, cursor: '2026-11-28T08' });
  });
});

describe('makbuz deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('parca kaydi saat kovasina, 3 gun TTL, ham token yok; kova sorgusu sayfali; imlec', async () => {
    ddb.on(PutCommand).resolves({});
    const store = createDynamoReceiptStore(() => NOW);
    await store.record({ apartmentId: 'apt-1', eventId: 'E1', tickets: [{ id: 'r1', userId: 'u', deviceId: 'd'.repeat(32) }] });
    const item = ddb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
    expect(item).toMatchObject({ PK: 'PUSHRCPT#2026-11-28T09', entityType: 'PUSH_RECEIPT_BATCH', apartmentId: 'apt-1', tickets: [{ id: 'r1', userId: 'u', deviceId: 'd'.repeat(32) }], ttl: Math.floor(NOW.getTime() / 1000) + 3 * 24 * 3600 });
    expect(String(item.SK)).toMatch(/^B#[0-9a-f-]{36}$/);
    expect(JSON.stringify(item)).not.toContain('ExponentPushToken');

    ddb.on(QueryCommand)
      .resolvesOnce({ Items: [{ tickets: [{ id: 'r1', userId: 'u', deviceId: 'd1' }] }], LastEvaluatedKey: { PK: 'x', SK: 'y' } })
      .resolvesOnce({ Items: [{ tickets: [{ id: 'r2', userId: 'u', deviceId: 'd2' }, { id: '', userId: 'u', deviceId: 'd3' }] }] });
    expect((await store.listBucket('2026-11-28T07')).map((t) => t.id)).toEqual(['r1', 'r2']);
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': 'PUSHRCPT#2026-11-28T07' });

    ddb.on(GetCommand).resolves({ Item: { bucket: '2026-11-28T07' } });
    expect(await store.getCursor()).toBe('2026-11-28T07');
    await store.setCursor('2026-11-28T08');
    expect(ddb.commandCalls(PutCommand)[1]!.args[0].input.Item).toMatchObject({ PK: 'PUSHRCPT#CURSOR', SK: 'CURSOR', bucket: '2026-11-28T08' });
  });
});

describe('zamanlanmis is: push_receipts', () => {
  const message = { job: 'push_receipts' as const, scheduledTime: NOW.toISOString() };
  const deps = { core: { listSiteIds: vi.fn(async () => ['apt-1']), getSite: vi.fn(async () => undefined) }, metrics: { emit: vi.fn() }, log: quiet, now: () => NOW };

  it('is adi taninir; push kapaliysa atlanir; apartman dongusu yok', async () => {
    expect(parseJobMessage(JSON.stringify(message)).job).toBe('push_receipts');
    const worker = createSchedulerWorker({ ...deps, pushReceipts: null });
    expect(await worker.runJob(message)).toEqual([{ apartmentId: '_push', status: 'skipped', reason: 'push_disabled' }]);
    expect(deps.core.listSiteIds).not.toHaveBeenCalled();
  });

  it('sonuc ve metrik; hata isi basarisiz yapar (SQS tekrar dener)', async () => {
    const result = { buckets: 1, tickets: 3, ok: 2, missing: 0, errors: { DeviceNotRegistered: 1 }, deactivated: 1, cursor: '2026-11-28T08' };
    const worker = createSchedulerWorker({ ...deps, pushReceipts: { run: async () => result } });
    expect(await worker.runJob(message)).toEqual([{ apartmentId: '_push', status: 'done', detail: result }]);
    expect(deps.metrics.emit).toHaveBeenCalledWith({ PushReceiptsChecked: 3, PushDevicesDeactivated: 1 }, expect.objectContaining({ msg: 'push_receipts' }));

    const failing = createSchedulerWorker({ ...deps, pushReceipts: { run: async () => Promise.reject(new TransientPushError('HTTP 503')) } });
    const res = await failing({ Records: [{ messageId: 'm1', body: JSON.stringify(message) }] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});
