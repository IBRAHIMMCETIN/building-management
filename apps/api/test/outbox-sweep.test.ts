import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { toOutboxItem } from '../src/events/outbox.js';
import { createDynamoOutboxStore } from '../src/events/outboxStore.js';
import { type DomainEvent, type EventPublisher, buildEvent, createInMemoryEventPublisher } from '../src/events/publisher.js';
import { sweepOutbox } from '../src/events/sweep.js';
import { toKurus } from '../src/modules/core/types.js';
import { createEmfEmitter } from '../src/observability/metrics.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { memoryStore } from './fakes/outboxStore.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-21T08:00:00.000Z');
const quiet = { info: vi.fn(), error: vi.fn() };
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const event = (id: string): DomainEvent =>
  buildEvent(
    {
      eventId: `PAYMENT_RECEIVED:${id}`,
      type: 'PAYMENT_RECEIVED',
      apartmentId: APT,
      actorId: 'mgr-1',
      groupKey: 'u1',
      payload: {
        paymentId: id, transactionId: `tx-${id}`, receiptNumber: 'MKB-000001', unitId: 'u1',
        liableParty: 'occupant', amount: toKurus(1000), method: 'cash', paidAt: '2026-11-21',
      },
    },
    () => NOW,
  ) as DomainEvent;

/** `createdAt` dakika once yazilmis bekleyen kayit. */
function seed(store: ReturnType<typeof memoryStore>, id: string, ageMinutes: number) {
  store.items.set(`PAYMENT_RECEIVED:${id}`, toOutboxItem(event(id), minutesAgo(ageMinutes)));
}

describe('outbox suprucusu', () => {
  it('yalnizca esigi asmis bekleyen kayitlari yayinlar ve isaretler; genc kayit relay\'e birakilir', async () => {
    const store = memoryStore();
    seed(store, 'old', 30);
    seed(store, 'mid', 3);
    seed(store, 'young', 1);
    const publisher = createInMemoryEventPublisher();
    const r = await sweepOutbox({ store, publisher, now: () => NOW, log: quiet }, { minAgeSeconds: 120 });

    expect(r).toEqual({ stale: 2, published: 2, failed: 0, invalid: 0, truncated: false, oldestAgeSeconds: 1800 });
    expect(publisher.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:old', 'PAYMENT_RECEIVED:mid']);
    expect(store.items.get('PAYMENT_RECEIVED:old')).toMatchObject({ status: 'published', publishedAt: NOW.toISOString() });
    expect(store.items.get('PAYMENT_RECEIVED:young')!.status).toBe('pending');

    // Ikinci tur: yayinlananlar bekleyen dizinden dustugu icin tekrar yayin yok.
    const again = await sweepOutbox({ store, publisher, now: () => NOW, log: quiet }, { minAgeSeconds: 120 });
    expect(again.stale).toBe(0);
    expect(publisher.published).toHaveLength(2);
  });

  it('stream saklama suresini (24 sa) asan kesintide kalan kayitlari da kurtarir', async () => {
    const store = memoryStore();
    seed(store, 'lost', 3 * 24 * 60);
    const publisher = createInMemoryEventPublisher();
    const r = await sweepOutbox({ store, publisher, now: () => NOW, log: quiet });
    expect(r.published).toBe(1);
    expect(r.oldestAgeSeconds).toBe(3 * 24 * 3600);
  });

  it('yayin hatasi digerlerini bekletmez; basarisiz kayit bekleyen kalir ve sonraki turda yayinlanir', async () => {
    const store = memoryStore();
    for (const id of ['a', 'b', 'c']) seed(store, id, 10);
    let down = true;
    const publisher: EventPublisher = {
      publish: vi.fn(async (e) => {
        if (down && e.eventId.endsWith(':b')) throw new Error('sns');
      }),
    };
    const log = { info: vi.fn(), error: vi.fn() };
    const r = await sweepOutbox({ store, publisher, now: () => NOW, log });
    expect(r).toMatchObject({ stale: 3, published: 2, failed: 1 });
    expect(store.items.get('PAYMENT_RECEIVED:b')!.status).toBe('pending');

    down = false;
    expect((await sweepOutbox({ store, publisher, now: () => NOW, log })).published).toBe(1);
    expect([...store.items.values()].every((i) => i.status === 'published')).toBe(true);
  });

  it('bozuk kayit yayinlanmaz, sayilir ve loglanir', async () => {
    const store = memoryStore();
    seed(store, 'ok', 10);
    const broken = toOutboxItem(event('bad'), minutesAgo(10));
    store.items.set('PAYMENT_RECEIVED:bad', { ...broken, event: { ...broken.event, apartmentId: 'apt-2' } as DomainEvent });
    const log = { info: vi.fn(), error: vi.fn() };
    const publisher = createInMemoryEventPublisher();
    const r = await sweepOutbox({ store, publisher, now: () => NOW, log });
    expect(r).toMatchObject({ stale: 2, published: 1, invalid: 1, failed: 0 });
    expect(publisher.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:ok']);
    expect(log.error.mock.calls.flat().join(' ')).toContain('outbox_record_invalid');
  });

  it('sayfalar: anahtar tabanli imlecle ilerler; sayfa siniri asilirsa truncated', async () => {
    const store = memoryStore();
    for (let i = 0; i < 7; i++) seed(store, `e${i}`, 60 - i);
    const publisher = createInMemoryEventPublisher();
    const r = await sweepOutbox({ store, publisher, now: () => NOW, log: quiet }, { pageSize: 2, maxPages: 2 });
    expect(r).toMatchObject({ stale: 4, published: 4, truncated: true });
    const rest = await sweepOutbox({ store, publisher, now: () => NOW, log: quiet }, { pageSize: 2, maxPages: 5 });
    expect(rest).toMatchObject({ stale: 3, published: 3, truncated: false });
    expect(new Set(publisher.published.map((e) => e.eventId)).size).toBe(7);
  });
});

describe('outbox deposu - sayfali bekleyen sorgusu', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('ExclusiveStartKey ile devam eder, LastEvaluatedKey imlec olarak doner', async () => {
    const lastKey = { PK: 'APT#apt-1', SK: 'OUTBOX#x', GSI1PK: 'OUTBOX#PENDING', GSI1SK: 'k' };
    ddb.on(QueryCommand).resolvesOnce({ Items: [], LastEvaluatedKey: lastKey }).resolvesOnce({ Items: [] });
    const store = createDynamoOutboxStore();
    const first = await store.listPendingPage({ limit: 5, olderThan: NOW });
    expect(first.cursor).toEqual(lastKey);
    const second = await store.listPendingPage({ limit: 5, olderThan: NOW, cursor: first.cursor });
    expect(second.cursor).toBeUndefined();
    const inputs = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(inputs[0]!.ExclusiveStartKey).toBeUndefined();
    expect(inputs[1]!.ExclusiveStartKey).toEqual(lastKey);
  });
});

describe('EMF metrikleri', () => {
  it('Stack boyutlu, namespace sabit, ozellikler log satirinda', () => {
    const log = { log: vi.fn() };
    createEmfEmitter({ stack: 'building-management-dev', log, now: () => NOW }).emit({ LedgerDrift: 2 }, { apartmentId: APT });
    const line = JSON.parse(log.log.mock.calls[0]![0] as string);
    expect(line).toEqual({
      apartmentId: APT,
      _aws: {
        Timestamp: NOW.getTime(),
        CloudWatchMetrics: [{ Namespace: 'BuildingManagement', Dimensions: [['Stack']], Metrics: [{ Name: 'LedgerDrift', Unit: 'Count' }] }],
      },
      Stack: 'building-management-dev',
      LedgerDrift: 2,
    });
  });
});

describe('zamanlayici - outbox_sweep isi', () => {
  function setup(store = memoryStore()) {
    const events = createInMemoryEventPublisher();
    const metrics = { emit: vi.fn() };
    const core = { listSiteIds: vi.fn(async () => ['apt-1', 'apt-2']), getSite: vi.fn() };
    const worker = createSchedulerWorker({
      core, events, metrics, outbox: store, now: () => NOW, log: quiet,
      finance: {} as never, payments: null, auditor: { run: vi.fn() },
      sweepOptions: { minAgeSeconds: 120 },
    });
    return { worker, events, metrics, core, store };
  }

  it('apartman dongusu olmadan tek tur calisir, olaylari zamanlayicinin yayincisiyla yayinlar, metrik uretir', async () => {
    const s = setup();
    seed(s.store, 'x', 10);
    const res = await s.worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'outbox_sweep', scheduledTime: NOW.toISOString() }) }] });
    expect(res.batchItemFailures).toEqual([]);
    expect(s.core.listSiteIds).not.toHaveBeenCalled();
    expect(s.events.published.map((e) => e.eventId)).toEqual(['PAYMENT_RECEIVED:x']);
    expect(s.metrics.emit).toHaveBeenCalledWith(
      { OutboxSweepStale: 1, OutboxSweepPublished: 1, OutboxSweepFailed: 0, OutboxSweepInvalid: 0 },
      expect.objectContaining({ msg: 'outbox_sweep' }),
    );
    expect(s.metrics.emit).toHaveBeenCalledWith({ OutboxOldestPendingSeconds: 600 }, expect.anything(), 'Seconds');
  });

  it('sorgu (altyapi) hatasi is hatasidir: mesaj tekrar denenir', async () => {
    const broken = memoryStore();
    broken.listPendingPage = async () => {
      throw new Error('GSI yok');
    };
    const s = setup(broken);
    const res = await s.worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'outbox_sweep', scheduledTime: NOW.toISOString() }) }] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});
