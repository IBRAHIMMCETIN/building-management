import { ConditionalCheckFailedException, ProvisionedThroughputExceededException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import { createLocalOutboxRelay } from '../src/events/localRelay.js';
import { type OutboxItem, toOutboxItem } from '../src/events/outbox.js';
import { type OutboxStore, OUTBOX_PUBLISHED_RETENTION_DAYS, createDynamoOutboxStore } from '../src/events/outboxStore.js';
import { type DomainEvent, type EventPublisher, buildEvent, createInMemoryEventPublisher } from '../src/events/publisher.js';
import { relayEvents } from '../src/events/relay.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Unit, toKurus } from '../src/modules/core/types.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import {
  type DynamoStreamRecord,
  createOutboxRelay,
  eventFromOutboxItem,
} from '../src/workers/outbox-relay.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { memoryStore } from './fakes/outboxStore.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const quiet = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

const event = (id: string, apartmentId = APT): DomainEvent =>
  buildEvent(
    {
      eventId: `PAYMENT_RECEIVED:${id}`,
      type: 'PAYMENT_RECEIVED',
      apartmentId,
      actorId: 'mgr-1',
      groupKey: 'u1',
      payload: {
        paymentId: id,
        transactionId: `tx-${id}`,
        receiptNumber: 'MKB-000001',
        unitId: 'u1',
        liableParty: 'occupant',
        amount: toKurus(1000),
        method: 'cash',
        paidAt: '2026-11-21',
      },
    },
    () => NOW,
  ) as DomainEvent;

/** DynamoDB Streams kaydi (Lambda'nin teslim ettigi bicim). */
const streamRecord = (item: Record<string, unknown>, seq: string, eventName: DynamoStreamRecord['eventName'] = 'INSERT'): DynamoStreamRecord => {
  const image = marshall(item, { removeUndefinedValues: true });
  return {
    eventID: `ev-${seq}`,
    eventName,
    dynamodb: { Keys: { PK: image.PK!, SK: image.SK! }, NewImage: image, SequenceNumber: seq },
  };
};

// ---------------------------------------------------------------------------
// Cekirdek
// ---------------------------------------------------------------------------

describe('relay cekirdegi', () => {
  it('once yayinlar sonra isaretler; sira korunur', async () => {
    const calls: string[] = [];
    const publisher: EventPublisher = { publish: async (e) => void calls.push(`pub:${e.eventId}`) };
    const store = { markPublished: vi.fn(async (_a: string, id: string) => (calls.push(`mark:${id}`), 'updated' as const)) };
    const out = await relayEvents([{ key: 'a', event: event('a') }, { key: 'b', event: event('b') }], { publisher, store, now: () => NOW, log: quiet });
    expect(out).toEqual({ published: ['a', 'b'], failed: [] });
    expect(calls).toEqual(['pub:PAYMENT_RECEIVED:a', 'mark:PAYMENT_RECEIVED:a', 'pub:PAYMENT_RECEIVED:b', 'mark:PAYMENT_RECEIVED:b']);
    expect(store.markPublished).toHaveBeenCalledWith(APT, 'PAYMENT_RECEIVED:a', NOW);
  });

  it('stopOnFailure: ilk hatada durur, kalanlar atlandi olarak doner; yayin hatasinda isaretleme yok', async () => {
    const publisher: EventPublisher = { publish: vi.fn(async (e) => { if (e.eventId.endsWith(':b')) throw new Error('sns down'); }) };
    const store = { markPublished: vi.fn(async () => 'updated' as const) };
    const items = ['a', 'b', 'c'].map((k) => ({ key: k, event: event(k) }));
    const out = await relayEvents(items, { publisher, store, now: () => NOW, log: quiet }, { stopOnFailure: true });
    expect(out.published).toEqual(['a']);
    expect(out.failed.map((f) => [f.key, f.error])).toEqual([['b', 'Error'], ['c', 'skipped']]);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(store.markPublished).toHaveBeenCalledTimes(1);
  });

  it('durdurmasiz modda bir kaydin hatasi digerlerini bekletmez; isaretleme hatasi da basarisizliktir', async () => {
    const publisher: EventPublisher = { publish: vi.fn(async () => {}) };
    const store = { markPublished: vi.fn(async (_a: string, id: string) => { if (id.endsWith(':a')) throw new Error('ddb'); return 'updated' as const; }) };
    const out = await relayEvents(['a', 'b'].map((k) => ({ key: k, event: event(k) })), { publisher, store, now: () => NOW, log: quiet });
    expect(out.published).toEqual(['b']);
    expect(out.failed.map((f) => f.key)).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// Stream relay Lambda'si
// ---------------------------------------------------------------------------

describe('outbox-relay Lambda', () => {
  const item = (id: string, apartmentId = APT) => toOutboxItem(event(id, apartmentId), NOW.toISOString());

  function setup(publish?: (e: DomainEvent) => Promise<void>) {
    const publisher = createInMemoryEventPublisher();
    const pub: EventPublisher = publish ? { publish: vi.fn(publish) } : publisher;
    const store = memoryStore();
    const log = { info: vi.fn(), error: vi.fn() };
    const handler = createOutboxRelay({ publisher: pub, store, now: () => NOW, log });
    return { handler, publisher, store, log, pub };
  }

  it('INSERT kayitlarini yayinlar, published isaretler; MODIFY/REMOVE ve outbox disi kayitlari atlar', async () => {
    const s = setup();
    for (const id of ['a', 'b']) s.store.items.set(`PAYMENT_RECEIVED:${id}`, item(id));
    const res = await s.handler({
      Records: [
        streamRecord(item('a'), '100'),
        streamRecord({ ...item('a'), status: 'published' }, '101', 'MODIFY'),
        streamRecord({ PK: 'APT#apt-1', SK: 'TX#20261121-x', entityType: 'TRANSACTION' }, '102'),
        streamRecord(item('b'), '103'),
        streamRecord(item('old'), '104', 'REMOVE'),
      ],
    });
    expect(res).toEqual({ batchItemFailures: [] });
    expect(s.publisher.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:a', 'PAYMENT_RECEIVED:b']);
    // Zarf birebir iletilir (DynamoDB tip donusumu kayipsiz).
    expect(s.publisher.published[0]).toEqual(event('a'));
    expect(s.store.items.get('PAYMENT_RECEIVED:a')).toMatchObject({ status: 'published', publishedAt: NOW.toISOString() });
    expect(s.store.items.get('PAYMENT_RECEIVED:a')).not.toHaveProperty('GSI1PK');
  });

  it('yayin hatasinda ilk basarisiz kaydin sira numarasini dondurur, sonrakileri islemez', async () => {
    const s = setup(async (e) => {
      if (e.eventId.endsWith(':b')) throw new Error('throttled');
    });
    const res = await s.handler({ Records: ['a', 'b', 'c'].map((id, i) => streamRecord(item(id), String(200 + i))) });
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: '201' }] });
    expect(s.pub.publish).toHaveBeenCalledTimes(2);
    expect(s.log.error.mock.calls.flat().join(' ')).toContain('outbox_publish_failed');
  });

  it('tekrar teslim (ayni kayit iki kez) zararsizdir: isaretleme idempotent', async () => {
    const s = setup();
    s.store.items.set('PAYMENT_RECEIVED:a', item('a'));
    await s.handler({ Records: [streamRecord(item('a'), '300')] });
    const first = s.store.items.get('PAYMENT_RECEIVED:a')!.publishedAt;
    const again = await s.handler({ Records: [streamRecord(item('a'), '300')] });
    expect(again.batchItemFailures).toEqual([]);
    // En az bir kez teslim: olay yeniden yayinlanabilir (tuketici eventId ile idempotent),
    // ilk yayin zamani korunur.
    expect(s.store.items.get('PAYMENT_RECEIVED:a')!.publishedAt).toBe(first);
  });

  it('bozuk kayit parcayi bloklamaz: loglanir ve atlanir', async () => {
    const s = setup();
    const broken = { ...item('x'), event: { ...event('x'), eventId: 'baska' } };
    const foreign = { ...item('y'), PK: 'APT#apt-2' };
    const res = await s.handler({ Records: [streamRecord(broken, '400'), streamRecord(foreign, '401'), streamRecord(item('ok'), '402')] });
    expect(res.batchItemFailures).toEqual([]);
    expect(s.publisher.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:ok']);
    expect(s.log.error.mock.calls.flat().filter((l) => String(l).includes('outbox_record_invalid'))).toHaveLength(2);
  });

  it('sira numarasi olmayan kayitta tum parca yeniden denenir (hata firlatilir)', async () => {
    const s = setup();
    const rec = streamRecord(item('a'), '500');
    delete rec.dynamodb!.SequenceNumber;
    await expect(s.handler({ Records: [rec] })).rejects.toThrow(/SequenceNumber/);
  });

  it('eventFromOutboxItem: tenant, kimlik ve tur dogrulanir', () => {
    expect(eventFromOutboxItem(item('a'))).toEqual(event('a'));
    expect(() => eventFromOutboxItem({ ...item('a'), event: undefined as never })).toThrow(/event/);
    expect(() => eventFromOutboxItem({ ...item('a'), apartmentId: 'apt-2' })).toThrow(/tenant/);
    expect(() => eventFromOutboxItem({ ...item('a'), event: { ...event('a'), type: 'X' } as never })).toThrow(/tur/);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB outbox deposu (aws-sdk-client-mock)
// ---------------------------------------------------------------------------

describe('outbox deposu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const store = createDynamoOutboxStore();

  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('markPublished: yalnizca bekleyen kaydi kosullu gunceller, GSI anahtarlarini kaldirir, TTL ekler', async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await store.markPublished(APT, 'PAYMENT_RECEIVED:a', NOW)).toBe('updated');
    const input = ddb.commandCalls(UpdateCommand)[0]!.args[0].input;
    expect(input.Key).toEqual({ PK: 'APT#apt-1', SK: 'OUTBOX#PAYMENT_RECEIVED:a' });
    expect(input.UpdateExpression).toBe('SET #status = :published, #publishedAt = :at, #ttl = :ttl REMOVE #gpk, #gsk');
    expect(input.ConditionExpression).toBe('attribute_exists(PK) AND #status = :pending');
    expect(input.ExpressionAttributeNames).toMatchObject({ '#gpk': 'GSI1PK', '#gsk': 'GSI1SK' });
    expect(input.ExpressionAttributeValues).toEqual({
      ':published': 'published',
      ':pending': 'pending',
      ':at': NOW.toISOString(),
      ':ttl': Math.floor(NOW.getTime() / 1000) + OUTBOX_PUBLISHED_RETENTION_DAYS * 86_400,
    });
  });

  it('markPublished: zaten yayinlanmis/silinmis kayit "already"; diger hatalar DataAccessError', async () => {
    ddb
      .on(UpdateCommand)
      .rejectsOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }))
      .rejectsOnce(new ProvisionedThroughputExceededException({ message: 'x', $metadata: {} }));
    expect(await store.markPublished(APT, 'PAYMENT_RECEIVED:a', NOW)).toBe('already');
    await expect(store.markPublished(APT, 'PAYMENT_RECEIVED:a', NOW)).rejects.toBeInstanceOf(DataAccessError);
  });

  it('listPending: GSI1 OUTBOX#PENDING, en eskiden; esik verilirse GSI1SK < esik', async () => {
    ddb.on(QueryCommand).resolves({ Items: [toOutboxItem(event('a'), NOW.toISOString())] });
    expect(await store.listPending({ limit: 10 })).toHaveLength(1);
    await store.listPending({ olderThan: new Date('2026-11-21T07:55:00.000Z') });
    const [plain, older] = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(plain).toMatchObject({
      IndexName: 'GSI1',
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeValues: { ':pk': 'OUTBOX#PENDING' },
      ScanIndexForward: true,
      Limit: 10,
    });
    expect(older).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND #sk < :before',
      ExpressionAttributeNames: { '#pk': 'GSI1PK', '#sk': 'GSI1SK' },
      ExpressionAttributeValues: { ':pk': 'OUTBOX#PENDING', ':before': '2026-11-21T07:55:00.000Z' },
      Limit: 25,
    });
  });
});

// ---------------------------------------------------------------------------
// Yerel relay
// ---------------------------------------------------------------------------

describe('yerel bellek ici relay', () => {
  it('bekleyenleri ayni cekirdekle yayinlar; ikinci turda yeniden yayin yok', async () => {
    const store = memoryStore();
    for (const id of ['a', 'b']) store.items.set(`PAYMENT_RECEIVED:${id}`, toOutboxItem(event(id), NOW.toISOString()));
    const publisher = createInMemoryEventPublisher();
    const relay = createLocalOutboxRelay({ store, publisher, now: () => NOW, log: quiet });
    expect(await relay.tick()).toBe(2);
    expect(publisher.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:a', 'PAYMENT_RECEIVED:b']);
    expect(await relay.tick()).toBe(0);
    expect(publisher.published).toHaveLength(2);
  });

  it('depo hatasi sunucuyu dusurmez; turlar ust uste binmez', async () => {
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const store: Pick<OutboxStore, 'listPending' | 'markPublished'> = {
      listPending: vi.fn(async () => {
        await slow;
        throw new Error('tablo yok');
      }),
      markPublished: vi.fn(),
    };
    const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const relay = createLocalOutboxRelay({ store, publisher: createInMemoryEventPublisher(), log });
    const first = relay.tick();
    expect(await relay.tick()).toBe(0); // calisan tur varken yeni tur baslamaz
    release();
    expect(await first).toBe(0);
    expect(store.listPending).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls.flat().join(' ')).toContain('tablo yok');
  });
});

// ---------------------------------------------------------------------------
// Uctan uca: finans yazimi -> outbox -> stream -> relay -> yayinci
// ---------------------------------------------------------------------------

describe('uctan uca: defter yazimindan yayina', () => {
  it('tahakkuk ve tahsilat olaylari stream uzerinden birebir ve bir kez yayinlanir', async () => {
    const fin = createFakeFinanceRepo();
    const ts = NOW.toISOString();
    const unit: Unit = {
      PK: `APT#${APT}`, SK: 'UNIT#u1', entityType: 'UNIT', unitId: 'u1', siteId: APT, blockId: 'b1', number: '1', type: 'flat',
      grossAreaTenthsM2: 1000, exemptions: [], status: 'active', createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1,
    };
    const core = { getUnit: async () => unit, listUnits: async () => [unit] } as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
    let n = 0;
    const finance = createFinanceService({ repository: fin.repo, core, now: () => NOW, newId: () => `id${++n}` });
    const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
    await finance.chargeUnit(ctx, { idempotencyKey: 'k1', unitId: 'u1', liableParty: 'occupant', amount: 150050, date: '2026-11-01', dueDate: '2026-11-15', description: 'Kasım aidatı' });
    await finance.recordPayment(ctx, { idempotencyKey: 'p1', unitId: 'u1', liableParty: 'occupant', amount: 100000, method: 'cash', paidAt: '2026-11-05' });

    // Fake depodaki outbox olaylari, DynamoDB'ye yazilacak kayitlara ve stream kayitlarina cevrilir.
    const store = memoryStore();
    const records = fin.events().map((e, i) => {
      const it = toOutboxItem(e, ts);
      store.items.set(e.eventId, it);
      return streamRecord(it, String(1000 + i));
    });
    const publisher = createInMemoryEventPublisher();
    const relay = createOutboxRelay({ publisher, store, now: () => NOW, log: quiet });
    expect(await relay({ Records: records })).toEqual({ batchItemFailures: [] });

    expect(publisher.published.map((e) => e.type)).toEqual(['DUE_GENERATED', 'PAYMENT_RECEIVED']);
    expect(publisher.published).toEqual(fin.events());
    expect([...store.items.values()].every((i) => i.status === 'published')).toBe(true);
    expect(await store.listPending()).toEqual([]);
  });
});
