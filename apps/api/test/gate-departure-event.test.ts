/**
 * Kapi devami: tasinma kaydedilince aninda pasife alma.
 *  - Uyelik PATCH / iptal ve cari kapama, kullanici bugun oturmuyorsa ayni yazimda `MEMBERSHIP_ENDED`
 *    outbox olayi yazar (bitis bugun / ileri tarihse yazmaz).
 *  - DynamoDB: uyelik + outbox + denetim tek TransactWriteItems; surum cakismasi 409.
 *  - Zamanlanmis gorev worker'i olayi alir ve `releaseNow`'i sistem aktoruyle calistirir; bozuk /
 *    bu kuyrukta islenmeyen olay hata (DLQ), is mesajlari eskisi gibi.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import { type DomainEvent, buildEvent, createInMemoryEventPublisher } from '../src/events/publisher.js';
import type { Unit } from '../src/modules/core/types.js';
import { endsResidency } from '../src/modules/gate/departures.js';
import { type MembershipRepository, createMembershipRepository, membershipKeys } from '../src/modules/memberships/repository.js';
import { createMembershipService } from '../src/modules/memberships/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createSchedulerWorker, parseEventMessage } from '../src/workers/scheduler-worker.js';
import { APT, cariWorld, manager } from './fakes/cariWorld.js';

const NOW = new Date('2026-11-27T09:00:00.000Z'); // Istanbul 27 Kasim
const TODAY = '2026-11-27';
const ts = NOW.toISOString();

function membership(over: Partial<UnitMembership> = {}): UnitMembership {
  return {
    ...membershipKeys.membership('apt-1', 'tenant-1', 'u1'),
    entityType: 'UNIT_MEMBERSHIP',
    userId: 'tenant-1',
    apartmentId: 'apt-1',
    unitId: 'u1',
    relation: 'tenant',
    residesInUnit: true,
    status: 'active',
    startDate: '2026-01-01',
    createdAt: ts,
    createdBy: 'seed',
    updatedAt: ts,
    updatedBy: 'seed',
    version: 1,
    ...over,
  } as UnitMembership;
}

function serviceWith(initial: UnitMembership[]) {
  const items = new Map(initial.map((m) => [`${m.userId}|${m.unitId}`, m]));
  const calls: { version: number; outbox?: DomainEvent[] }[] = [];
  const repo: MembershipRepository = {
    get: async (_apt, user, unitId) => items.get(`${user}|${unitId}`),
    list: async (apt, filter = {}) => [...items.values()].filter((m) => m.apartmentId === apt && (!filter.unitId || m.unitId === filter.unitId)),
    create: async () => {},
    update: async (m, expectedVersion, opts) => {
      if (items.get(`${m.userId}|${m.unitId}`)?.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      items.set(`${m.userId}|${m.unitId}`, m);
      calls.push({ version: m.version, ...(opts?.outbox ? { outbox: opts.outbox } : {}) });
    },
  };
  const unit = { unitId: 'u1', siteId: 'apt-1', status: 'active' } as Unit;
  const service = createMembershipService({ repository: repo, core: { getUnit: async () => unit }, now: () => NOW });
  return { service, calls };
}

const ctx = { apartmentId: 'apt-1', userId: 'mgr-1' };

describe('MEMBERSHIP_ENDED: uyelik yazimi', () => {
  it('bitis gecmis tarihe cekilirse ayni yazimda olay; deterministik kimlik, kisi verisi yok', async () => {
    const { service, calls } = serviceWith([membership()]);
    await service.update(ctx, 'tenant-1', 'u1', { version: 1, endDate: '2026-11-26' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outbox).toEqual([
      expect.objectContaining({
        eventId: 'MEMBERSHIP_ENDED:tenant-1:u1:2',
        type: 'MEMBERSHIP_ENDED',
        apartmentId: 'apt-1',
        actorId: 'mgr-1',
        payload: { userId: 'tenant-1', unitId: 'u1', source: 'membership', endDate: '2026-11-26' },
      }),
    ]);
  });

  it('bitis bugun veya ileri tarih: olay yok (bitis gunu boyunca oturur; gece taramasi)', async () => {
    for (const endDate of [TODAY, '2026-12-15']) {
      const { service, calls } = serviceWith([membership()]);
      await service.update(ctx, 'tenant-1', 'u1', { version: 1, endDate });
      expect(calls[0]?.outbox).toBeUndefined();
    }
  });

  it('iptal (DELETE) ve oturan malikin artik oturmamasi olay yazar; ilgisiz degisiklik yazmaz', async () => {
    const a = serviceWith([membership()]);
    await a.service.deactivate(ctx, 'tenant-1', 'u1');
    expect(a.calls[0]?.outbox?.[0]).toMatchObject({ eventId: 'MEMBERSHIP_ENDED:tenant-1:u1:2', payload: { source: 'membership' } });

    const owner = membership({ relation: 'owner', residesInUnit: true });
    const b = serviceWith([owner]);
    await b.service.update(ctx, 'tenant-1', 'u1', { version: 1, residesInUnit: false });
    expect(b.calls[0]?.outbox).toHaveLength(1);

    // Zaten oturmayan malikin hisse disi alani degisti: olay yok.
    const c = serviceWith([membership({ relation: 'owner', residesInUnit: false })]);
    await c.service.update(ctx, 'tenant-1', 'u1', { version: 1, startDate: '2025-06-01' });
    expect(c.calls[0]?.outbox).toBeUndefined();
  });

  it('endsResidency: henuz baslamamis veya hala oturan uyelik aday degil', () => {
    expect(endsResidency(membership(), membership({ startDate: '2026-12-01', status: 'inactive', version: 2 }), TODAY)).toBe(false);
    expect(endsResidency(membership(), membership({ endDate: TODAY, version: 2 }), TODAY)).toBe(false);
    expect(endsResidency(undefined, membership({ status: 'inactive' }), TODAY)).toBe(false);
    expect(endsResidency(membership(), membership({ status: 'inactive', version: 2 }), TODAY)).toBe(true);
  });
});

describe('MEMBERSHIP_ENDED: DynamoDB atomik yazim', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    vi.stubEnv('DYNAMODB_TABLE_NAME', 'bm-test');
    vi.stubEnv('AWS_REGION', 'eu-central-1');
    vi.stubEnv('DYNAMODB_ENDPOINT', '');
    vi.stubEnv('AUDIT_TABLE_NAME', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  const event = buildEvent({ eventId: 'MEMBERSHIP_ENDED:tenant-1:u1:2', type: 'MEMBERSHIP_ENDED', apartmentId: 'apt-1', actorId: 'mgr-1', payload: { userId: 'tenant-1', unitId: 'u1', source: 'membership' } }, () => NOW);

  it('uyelik (surum kosullu) + outbox (yeni) tek islemde', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await createMembershipRepository().update(membership({ status: 'inactive', version: 2 }), 1, { outbox: [event] });
    const items = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0]?.Put).toMatchObject({ Item: { SK: 'MEMBER#tenant-1#u1', status: 'inactive', GSI1PK: 'USER#tenant-1' }, ExpressionAttributeValues: { ':expectedVersion': 1 } });
    expect(items[1]?.Put).toMatchObject({ Item: { SK: 'OUTBOX#MEMBERSHIP_ENDED:tenant-1:u1:2', eventType: 'MEMBERSHIP_ENDED', status: 'pending' }, ConditionExpression: 'attribute_not_exists(PK)' });
  });

  it('surum cakismasi conflict olur', async () => {
    ddb.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'x', $metadata: {}, CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }] }));
    await expect(createMembershipRepository().update(membership({ version: 2 }), 1, { outbox: [event] })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('MEMBERSHIP_ENDED: cari kapama', () => {
  it('kapamayla biten uyelik icin kapama yazimiyla ayni batch\'te olay (karar worker\'da, geri alma payi korunur)', async () => {
    const s = cariWorld();
    s.member('tenant-a', { relation: 'tenant', startDate: '2026-03-01' });
    await s.charge('k-oct', 1000, '2026-10-01', '2026-10-10');
    s.setNow('2026-11-05');
    const r = await s.call('POST', '/api/finance/units/u1/closures', manager, {
      idempotencyKey: 'close-ev-1',
      party: 'occupant',
      moveOutDate: '2026-10-31',
      userIds: ['tenant-a'],
      reason: 'Kiracı taşındı',
    });
    expect(r.status).toBe(201);
    const outbox = s.fake.batches.at(-1)?.outbox ?? [];
    expect(outbox).toEqual([
      expect.objectContaining({
        eventId: 'MEMBERSHIP_ENDED:tenant-a:u1:2',
        type: 'MEMBERSHIP_ENDED',
        apartmentId: APT,
        payload: { userId: 'tenant-a', unitId: 'u1', source: 'closure', closureId: r.json.closure.closureId, endDate: '2026-10-31' },
      }),
    ]);
  });
});

describe('MEMBERSHIP_ENDED: zamanlanmis gorev worker', () => {
  const quiet = { info: () => {}, error: () => {} };
  const event = buildEvent({ eventId: 'MEMBERSHIP_ENDED:tenant-1:u1:2', type: 'MEMBERSHIP_ENDED', apartmentId: 'apt-1', actorId: 'mgr-1', payload: { userId: 'tenant-1', unitId: 'u1', source: 'membership' } }, () => NOW);

  function worker(releaseNow = vi.fn(async () => ({ status: 'released' as const, passIds: ['p1'], vehicleIds: [] }))) {
    const emitted: Record<string, number>[] = [];
    const w = createSchedulerWorker({
      core: { listSiteIds: async () => [], getSite: async () => undefined },
      events: createInMemoryEventPublisher(),
      gate: { sweep: vi.fn(), releaseNow },
      metrics: { emit: (m) => emitted.push(m) },
      now: () => NOW,
      log: quiet,
    });
    return { w, releaseNow, emitted };
  }

  it('olay (raw veya SNS zarfi) releaseNow ile sistem aktoru ve tetikleyiciyle islenir', async () => {
    const { w, releaseNow, emitted } = worker();
    expect(await w({ Records: [{ messageId: 'm1', body: JSON.stringify(event) }] })).toEqual({ batchItemFailures: [] });
    expect(releaseNow).toHaveBeenCalledWith('apt-1', { userId: 'tenant-1', unitId: 'u1' }, TODAY, 'system-scheduler', { trigger: 'membership_ended', eventId: event.eventId });
    expect(emitted).toContainEqual({ GateDepartureImmediate: 1 });
    await w({ Records: [{ messageId: 'm2', body: JSON.stringify({ Type: 'Notification', Message: JSON.stringify(event) }) }] });
    expect(releaseNow).toHaveBeenCalledTimes(2);
  });

  it('hata: mesaj yeniden denenir ve GateDepartureFailed metrigi', async () => {
    const { w, emitted } = worker(vi.fn(async () => {
      throw new DataAccessError('throttled', 'yavas');
    }));
    expect(await w({ Records: [{ messageId: 'm1', body: JSON.stringify(event) }] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(emitted).toContainEqual({ GateDepartureFailed: 1 });
  });

  it('bu kuyrukta islenmeyen / bozuk olay reddedilir; is mesaji olay sanilmaz', () => {
    expect(() => parseEventMessage(JSON.stringify({ ...event, type: 'PAYMENT_RECEIVED' }))).toThrow(/islenmeyen/);
    expect(() => parseEventMessage(JSON.stringify({ ...event, payload: { userId: 'a/b', unitId: 'u1' } }))).toThrow(/gecersiz/);
    expect(parseEventMessage(JSON.stringify({ job: 'ledger_audit', scheduledTime: ts }))).toBeUndefined();
    expect(parseEventMessage('x')).toBeUndefined();
  });
});
