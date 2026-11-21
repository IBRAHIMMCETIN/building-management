import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type DomainEvent, buildEvent } from '../src/events/publisher.js';
import { type Kurus, type Unit, toKurus } from '../src/modules/core/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import {
  type Notification,
  type Notifier,
  type SqsEvent,
  buildNotifications,
  createNotificationWorker,
  parseDomainEvent,
} from '../src/workers/notification-worker.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const APT = 'apt-1';
const quiet = { info: () => {}, error: () => {} };

function member(userId: string, unitId: string, relation: 'owner' | 'tenant', over: Partial<UnitMembership> = {}) {
  return {
    userId,
    unitId,
    apartmentId: APT,
    relation,
    residesInUnit: relation === 'tenant',
    status: 'active',
    startDate: '2026-01-01',
    ...over,
  } as UnitMembership;
}

const memberships: UnitMembership[] = [
  member('tenant-1', 'u1', 'tenant'),
  member('owner-1', 'u1', 'owner'), // dairede oturmuyor
  member('owner-2', 'u2', 'owner', { residesInUnit: true }),
  member('old-tenant', 'u2', 'tenant', { endDate: '2026-06-30' }),
  member('owner-3', 'u3', 'owner', { residesInUnit: true }),
  member('baska-apt', 'u1', 'tenant', { apartmentId: 'apt-2' }),
];
const units = [
  { unitId: 'u1', blockId: 'A' },
  { unitId: 'u2', blockId: 'A' },
  { unitId: 'u3', blockId: 'B' },
] as Unit[];

const k = (n: number) => toKurus(n) as Kurus;

const paymentEvent = (liableParty: 'owner' | 'occupant' = 'occupant') =>
  buildEvent(
    {
      eventId: 'PAYMENT_RECEIVED:p1',
      type: 'PAYMENT_RECEIVED',
      apartmentId: APT,
      actorId: 'mgr',
      payload: {
        paymentId: 'p1',
        transactionId: 't1',
        receiptNumber: 'MKB-000001',
        unitId: 'u1',
        liableParty,
        amount: k(150050),
        method: 'cash',
        paidAt: '2026-11-05',
      },
    },
    () => NOW,
  );

const dueEvent = () =>
  buildEvent(
    {
      eventId: 'DUE_GENERATED:b1:t1',
      type: 'DUE_GENERATED',
      apartmentId: APT,
      actorId: 'mgr',
      payload: {
        mode: 'single',
        date: '2026-11-01',
        dueDate: '2026-11-15',
        description: 'Kasim aidati',
        liableParty: 'occupant',
        totalAmount: k(300000),
        items: [
          { unitId: 'u1', amount: k(100000), transactionId: 't1' },
          { unitId: 'u2', amount: k(100000), transactionId: 't2' },
          { unitId: 'u3', amount: k(100000), transactionId: 't3' },
        ],
      },
    },
    () => NOW,
  );

/** Toplu tahakkukun kalem olayi (yeni bicim: kalem basina, batchId dolu). */
const bulkItemEvent = (unitId: string, transactionId: string) =>
  buildEvent(
    {
      eventId: `DUE_GENERATED:${transactionId}`,
      type: 'DUE_GENERATED',
      apartmentId: APT,
      actorId: 'mgr',
      groupKey: unitId,
      payload: {
        mode: 'bulk',
        batchId: 'b9',
        date: '2026-11-01',
        dueDate: '2026-11-15',
        description: 'Kasim aidati',
        liableParty: 'occupant',
        totalAmount: k(100000),
        items: [{ unitId, amount: k(100000), transactionId, liableParty: 'occupant' }],
      },
    },
    () => NOW,
  );

const summaryEvent = (items: { unitId: string; amount: number; liableParty?: 'owner' | 'occupant' }[]) =>
  buildEvent(
    {
      eventId: 'DUES_BATCH_SUMMARY:b9',
      type: 'DUES_BATCH_SUMMARY',
      apartmentId: APT,
      actorId: 'mgr',
      payload: {
        batchId: 'b9',
        part: 1,
        parts: 1,
        date: '2026-11-01',
        dueDate: '2026-11-15',
        description: 'Kasim aidati',
        liableParty: 'occupant',
        totalAmount: k(items.reduce((s, i) => s + i.amount, 0)),
        items: items.map((i, n) => ({ unitId: i.unitId, amount: k(i.amount), transactionId: `t${n}`, liableParty: i.liableParty ?? 'occupant' })),
      },
    },
    () => NOW,
  );

const announcementEvent = (blockIds: string[]) =>
  buildEvent(
    {
      eventId: 'ANNOUNCEMENT_PUBLISHED:ann1',
      type: 'ANNOUNCEMENT_PUBLISHED',
      apartmentId: APT,
      actorId: 'mgr',
      payload: { announcementId: 'ann1', title: 'Su kesintisi', blockIds, publishAt: NOW.toISOString() },
    },
    () => NOW,
  );

const sqs = (...bodies: (DomainEvent | string)[]): SqsEvent => ({
  Records: bodies.map((b, i) => ({ messageId: `m${i + 1}`, body: typeof b === 'string' ? b : JSON.stringify(b) })),
});

function setup(overrides: { notifier?: Notifier } = {}) {
  const sent: Notification[] = [];
  const processed = new Set<string>();
  const notifier: Notifier = overrides.notifier ?? { channel: 'test', send: async (n) => void sent.push(n) };
  const listUnits = vi.fn(async () => units);
  const worker = createNotificationWorker({
    memberships: { list: async (apt) => memberships.filter((m) => m.apartmentId === apt) },
    core: { listUnits },
    notifier,
    isProcessed: async (apt, id) => processed.has(`${apt}|${id}`),
    markProcessed: async (apt, id) => void processed.add(`${apt}|${id}`),
    now: () => NOW,
    log: quiet,
  });
  return { worker, sent, processed, listUnits };
}

const users = (ns: Notification[]) => ns.map((n) => n.userId).sort();

// ---------------------------------------------------------------------------

describe('parseDomainEvent', () => {
  it('raw govdeyi ve SNS zarfini cozer', () => {
    const e = paymentEvent();
    expect(parseDomainEvent(JSON.stringify(e)).eventId).toBe(e.eventId);
    expect(parseDomainEvent(JSON.stringify({ Type: 'Notification', Message: JSON.stringify(e) })).type).toBe(
      'PAYMENT_RECEIVED',
    );
  });

  it.each([
    ['json degil', 'x{'],
    ['dizi', '[]'],
    ['bilinmeyen tur', JSON.stringify({ ...paymentEvent(), type: 'USER_DELETED' })],
    ['eventId yok', JSON.stringify({ ...paymentEvent(), eventId: '' })],
    ['payload yok', JSON.stringify({ ...paymentEvent(), payload: null })],
  ])('gecersiz: %s', (_l, body) => {
    expect(() => parseDomainEvent(body)).toThrow();
  });
});

describe('buildNotifications - alici cozumleme', () => {
  it('toplu tahakkuk kalemi tek basina bildirim uretmez (ozet olayina birakilir)', () => {
    expect(buildNotifications(bulkItemEvent('u1', 't1'), memberships, new Map(), '2026-11-06')).toEqual([]);
  });

  it('DUES_BATCH_SUMMARY: kullanici basina TEK ozet; gordugu tum kalemler ve toplam', () => {
    const extra = [...memberships, member('tenant-1', 'u3', 'tenant')]; // iki dairede kiraci
    const ns = buildNotifications(summaryEvent([{ unitId: 'u1', amount: 100000 }, { unitId: 'u2', amount: 120000 }, { unitId: 'u3', amount: 90000 }]), extra, new Map(), '2026-11-06');
    const byUser = new Map(ns.map((n) => [n.userId, n]));
    expect([...byUser.keys()].sort()).toEqual(['owner-2', 'owner-3', 'tenant-1']);
    expect(ns.every((n) => n.template === 'dues_batch_summary' && n.eventId === 'DUES_BATCH_SUMMARY:b9')).toBe(true);
    expect(byUser.get('tenant-1')!.data).toEqual({
      batchId: 'b9',
      description: 'Kasim aidati',
      dueDate: '2026-11-15',
      total: 190000,
      items: [{ unitId: 'u1', amount: 100000 }, { unitId: 'u3', amount: 90000 }],
    });
    // Oturmayan malik sakin gideri ozeti almaz; eski kiraci da almaz.
    expect(byUser.has('owner-1')).toBe(false);
    expect(byUser.has('old-tenant')).toBe(false);
  });

  it('DUES_BATCH_SUMMARY: bos daire kalemi (malike yazilmis) malike gider', () => {
    const ns = buildNotifications(summaryEvent([{ unitId: 'u1', amount: 100000, liableParty: 'owner' }]), memberships, new Map(), '2026-11-06');
    expect(ns.map((n) => n.userId)).toEqual(['owner-1']);
  });

  const day = '2026-11-06';

  it('PAYMENT_RECEIVED (occupant): kiraci; oturmayan malik ve baska apartman almaz', () => {
    expect(users(buildNotifications(paymentEvent('occupant'), memberships, new Map(), day))).toEqual(['tenant-1']);
  });

  it('PAYMENT_RECEIVED (owner): yalnizca malik', () => {
    const ns = buildNotifications(paymentEvent('owner'), memberships, new Map(), day);
    expect(users(ns)).toEqual(['owner-1']);
    expect(ns[0]).toMatchObject({ template: 'payment_received', data: { receiptNumber: 'MKB-000001', amount: 150050 } });
  });

  it('DUE_GENERATED: her dairede sakin carisini goren gecerli uyeler (eski kiraci haric)', () => {
    const ns = buildNotifications(dueEvent(), memberships, new Map(), day);
    expect(users(ns)).toEqual(['owner-2', 'owner-3', 'tenant-1']);
    expect(ns.find((n) => n.userId === 'owner-2')?.data).toMatchObject({ unitId: 'u2', amount: 100000, dueDate: '2026-11-15' });
  });

  it('ANNOUNCEMENT_PUBLISHED: tum gecerli uyeler, blok hedefliyse yalnizca o blok; kullanici basina tek bildirim', () => {
    const blocks = new Map(units.map((u) => [u.unitId, u.blockId]));
    const extra = [...memberships, member('tenant-1', 'u2', 'tenant')];
    expect(users(buildNotifications(announcementEvent([]), extra, blocks, day))).toEqual([
      'owner-1',
      'owner-2',
      'owner-3',
      'tenant-1',
    ]);
    expect(users(buildNotifications(announcementEvent(['B']), memberships, blocks, day))).toEqual(['owner-3']);
  });
});

describe('notification worker handler', () => {
  it('olayi isler, bildirimleri gonderir ve islenmis olarak isaretler', async () => {
    const { worker, sent, processed } = setup();
    const res = await worker(sqs(dueEvent()));
    expect(res.batchItemFailures).toEqual([]);
    expect(sent).toHaveLength(3);
    expect(processed.has(`${APT}|DUE_GENERATED:b1:t1`)).toBe(true);
  });

  it('ayni olay ikinci kez gelirse bildirim tekrar gonderilmez (idempotency)', async () => {
    const { worker, sent } = setup();
    await worker(sqs(paymentEvent()));
    await worker(sqs(paymentEvent()));
    expect(sent).toHaveLength(1);
  });

  it('yalnizca hatali mesaj basarisiz raporlanir (partial batch response)', async () => {
    const { worker, sent } = setup();
    const res = await worker(sqs(paymentEvent(), 'bozuk-json', announcementEvent([])));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm2' }]);
    expect(sent.length).toBeGreaterThan(1);
  });

  it('gonderim hatasinda olay isaretlenmez ve yeniden denenir', async () => {
    const notifier: Notifier = { channel: 'sms', send: async () => { throw new Error('saglayici kapali'); } };
    const { worker, processed } = setup({ notifier });
    const res = await worker(sqs(paymentEvent()));
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
    expect(processed.size).toBe(0);
  });

  it('blok hedefi yoksa daireler okunmaz (gereksiz sorgu yok)', async () => {
    const { worker, listUnits } = setup();
    await worker(sqs(announcementEvent([])));
    expect(listUnits).not.toHaveBeenCalled();
    await worker(sqs({ ...announcementEvent(['A']), eventId: 'ANNOUNCEMENT_PUBLISHED:ann2' }));
    expect(listUnits).toHaveBeenCalledOnce();
  });
});

describe('notification worker - DynamoDB idempotency kaydi', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const worker = (sent: Notification[]) =>
    createNotificationWorker({
      memberships: { list: async () => memberships },
      core: { listUnits: async () => units },
      notifier: { channel: 't', send: async (n) => void sent.push(n) },
      now: () => NOW,
      log: quiet,
    });

  it('NOTIF#<eventId> kaydini TTL ile kosullu yazar', async () => {
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const sent: Notification[] = [];
    expect((await worker(sent)(sqs(paymentEvent()))).batchItemFailures).toEqual([]);
    const put = ddb.commandCalls(PutCommand)[0]!.args[0].input;
    expect(put.Item).toMatchObject({
      PK: 'APT#apt-1',
      SK: 'NOTIF#PAYMENT_RECEIVED:p1',
      entityType: 'NOTIFICATION_LOG',
      recipients: 1,
      ttl: Math.floor(NOW.getTime() / 1000) + 30 * 24 * 3600,
    });
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('kayit varsa atlar; es zamanli isaretleme cakismasi hata sayilmaz', async () => {
    ddb.on(GetCommand).resolves({ Item: { PK: 'x', SK: 'y' } });
    const sent: Notification[] = [];
    await worker(sent)(sqs(paymentEvent()));
    expect(sent).toHaveLength(0);

    ddb.reset();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).rejects(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    expect((await worker(sent)(sqs(paymentEvent()))).batchItemFailures).toEqual([]);
  });
});
