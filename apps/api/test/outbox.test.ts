import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { OUTBOX_PENDING_PK, outboxKeys, toOutboxItem, toOutboxItems } from '../src/events/outbox.js';
import { type DomainEvent, buildEvent } from '../src/events/publisher.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Unit, toKurus } from '../src/modules/core/types.js';
import {
  LedgerConflictError,
  MAX_TRANSACT_ITEMS,
  createFinanceRepository,
  financeKeys,
} from '../src/modules/finance/repository.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-1';
const NOW = new Date('2026-11-06T10:00:00.000Z');
const TL = (n: number) => toKurus(Math.round(n * 100));

const event = (over: Partial<DomainEvent> = {}): DomainEvent =>
  ({
    ...buildEvent(
      {
        eventId: 'PAYMENT_RECEIVED:p1',
        type: 'PAYMENT_RECEIVED',
        apartmentId: APT,
        actorId: 'mgr-1',
        groupKey: 'u1',
        payload: {
          paymentId: 'p1',
          transactionId: '20261101-t1',
          receiptNumber: 'MKB-000001',
          unitId: 'u1',
          liableParty: 'occupant',
          amount: toKurus(150050),
          method: 'cash',
          paidAt: '2026-11-01',
        },
      },
      () => NOW,
    ),
    ...over,
  }) as DomainEvent;

function tx(over: Partial<Transaction> = {}): Transaction {
  const transactionId = over.transactionId ?? '20261101-t1';
  return {
    ...financeKeys.transaction(APT, transactionId),
    entityType: 'TRANSACTION',
    transactionId,
    siteId: APT,
    kind: 'payment',
    date: '2026-11-01',
    description: 'test',
    lines: [
      { accountId: 'cash', side: 'debit', amount: toKurus(150050) },
      { accountId: 'recv-u1-occupant', side: 'credit', amount: toKurus(150050), unitId: 'u1', liableParty: 'occupant' },
    ],
    totalAmount: toKurus(150050),
    createdAt: NOW.toISOString(),
    createdBy: 'mgr-1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Kayit bicimi
// ---------------------------------------------------------------------------

describe('outbox - kayit bicimi', () => {
  it('tenant PK, OUTBOX#<eventId> SK, seyrek bekleyen GSI ve TTL\'siz pending durum', () => {
    const item = toOutboxItem(event(), NOW.toISOString());
    expect(item).toMatchObject({
      PK: 'APT#apt-1',
      SK: 'OUTBOX#PAYMENT_RECEIVED:p1',
      entityType: 'OUTBOX_EVENT',
      eventId: 'PAYMENT_RECEIVED:p1',
      eventType: 'PAYMENT_RECEIVED',
      apartmentId: APT,
      status: 'pending',
      createdAt: NOW.toISOString(),
      GSI1PK: OUTBOX_PENDING_PK,
      GSI1SK: `${NOW.toISOString()}#apt-1#PAYMENT_RECEIVED:p1`,
    });
    expect(item.GSI1PK).toBe('OUTBOX#PENDING');
    // Yayinlanmamis olay asla TTL ile silinmez.
    expect(item).not.toHaveProperty('ttl');
    // Zarf birebir saklanir (relay SNS'e aynen gonderir).
    expect(item.event).toEqual(event());
    expect(outboxKeys(APT, 'x')).toEqual({ PK: 'APT#apt-1', SK: 'OUTBOX#x' });
  });

  it('gecersiz kimlik, baska tenant ve bilinmeyen tur reddedilir; ayni olay iki kez verilemez', () => {
    expect(() => toOutboxItem(event({ eventId: 'a#b' }), NOW.toISOString())).toThrow(/eventId/);
    expect(() => toOutboxItem(event({ eventId: '' }), NOW.toISOString())).toThrow(/eventId/);
    expect(() => toOutboxItem(event(), NOW.toISOString(), 'apt-2')).toThrow(/tenant/);
    expect(() => toOutboxItem(event({ type: 'NOPE' } as never), NOW.toISOString())).toThrow(/turu/);
    expect(() => toOutboxItems([event(), event()], NOW.toISOString(), APT)).toThrow(/iki kez/);
  });
});

// ---------------------------------------------------------------------------
// postBatch / postTransaction (aws-sdk-client-mock)
// ---------------------------------------------------------------------------

describe('outbox - postBatch atomik yazimi', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const repo = createFinanceRepository();
  const idempotency = { id: 'key-12345', fingerprint: 'fp' };

  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const items = () => ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;

  it('olay, defter kaydiyla AYNI TransactWriteItems icinde, kayitlarin sonunda ve kosullu yazilir', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await repo.postTransaction({ transaction: tx(), idempotency, outbox: [event()] });

    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const list = items();
    // idem + tx + 2 satir + 2 hesap + 1 olay + donem kilidi kontrolu (veri ogelerinin sonu)
    expect(list).toHaveLength(8);
    expect(list[7]!.ConditionCheck).toBeDefined();
    const put = list[6]!.Put!;
    expect(put.TableName).toBe('bm-test-table');
    expect(put.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(put.Item).toMatchObject({
      PK: 'APT#apt-1',
      SK: 'OUTBOX#PAYMENT_RECEIVED:p1',
      status: 'pending',
      GSI1PK: 'OUTBOX#PENDING',
      // Kayit zamani islemin zamani (relay/suprucu siralamasi).
      createdAt: NOW.toISOString(),
    });
  });

  it('olaysiz yazim degismez (geriye uyumlu)', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await repo.postTransaction({ transaction: tx(), idempotency });
    expect(items().some((i) => String(i.Put?.Item?.SK ?? '').startsWith('OUTBOX#'))).toBe(false);
  });

  it('coklu islem + coklu olay tek yazimda; olaylar oge sinirina dahildir', async () => {
    ddb.on(TransactWriteCommand).resolves({});
    await repo.postBatch({
      transactions: [tx(), tx({ transactionId: '20261101-t2' })],
      idempotency,
      outbox: [event(), event({ eventId: 'PAYMENT_RECEIVED:p2' })],
    });
    const sks = items().map((i) => String(i.Put?.Item?.SK ?? ''));
    expect(sks.filter((sk) => sk.startsWith('OUTBOX#'))).toEqual(['OUTBOX#PAYMENT_RECEIVED:p1', 'OUTBOX#PAYMENT_RECEIVED:p2']);

    // 1 idem + 1 tx + 2 satir + 2 hesap = 6; 95 olay ile 101 > 100 -> DynamoDB'ye gitmeden reddedilir.
    const many = Array.from({ length: MAX_TRANSACT_ITEMS - 5 }, (_, i) => event({ eventId: `PAYMENT_RECEIVED:x${i}` }));
    ddb.reset();
    await expect(repo.postTransaction({ transaction: tx(), idempotency, outbox: many })).rejects.toThrow(/100 ogeyi asamaz/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('baska apartmanin olayi yazima karisamaz (DynamoDB\'ye gidilmez)', async () => {
    await expect(
      repo.postTransaction({ transaction: tx(), idempotency, outbox: [event({ apartmentId: 'apt-2' } as Partial<DomainEvent>)] }),
    ).rejects.toThrow(/tenant/);
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('olay kosulu tutmazsa tum yazim iptal olur ve duplicate cakismasi doner', async () => {
    ddb.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({
        message: 'cancelled',
        $metadata: {},
        CancellationReasons: [
          { Code: 'None' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' }, { Code: 'None' },
          { Code: 'ConditionalCheckFailed' },
        ],
      }),
    );
    const err = await repo.postTransaction({ transaction: tx(), idempotency, outbox: [event()] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerConflictError);
    expect(err).toMatchObject({ reason: 'duplicate', label: 'outbox:PAYMENT_RECEIVED:p1' });
  });
});

// ---------------------------------------------------------------------------
// Servis: olaylar defterle birlikte
// ---------------------------------------------------------------------------

function unit(id: string): Unit {
  const ts = NOW.toISOString();
  return {
    PK: `APT#${APT}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: APT, blockId: 'b1',
    number: id.toUpperCase(), type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active',
    createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1,
  };
}

function world() {
  const fake = createFakeFinanceRepo();
  const units = [unit('u1'), unit('u2')];
  const core = {
    getUnit: async (_apt: string, id: string) => units.find((u) => u.unitId === id),
    listUnits: async () => units,
  } as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  let n = 0;
  let now = new Date('2026-09-01T09:00:00.000Z');
  const service = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${++n}` });
  const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
  const setNow = (iso: string) => void (now = new Date(`${iso}T09:00:00.000Z`));
  return { fake, service, ctx, setNow };
}

describe('outbox - finans servisinde olaylar', () => {
  it('her olay kendisini doguran yazimin icinde: tahakkuk, tahsilat ve tazminat', async () => {
    const w = world();
    const charged = await w.service.chargeUnit(w.ctx, {
      idempotencyKey: 'k1', unitId: 'u1', liableParty: 'occupant', amount: TL(1000), date: '2026-09-01', dueDate: '2026-09-10', description: 'Eylül aidatı',
    });
    const paid = await w.service.recordPayment(w.ctx, {
      idempotencyKey: 'p1', unitId: 'u1', liableParty: 'occupant', amount: TL(400), method: 'cash', paidAt: '2026-09-20',
    });
    // Her yazim kendi olayini tasir: ayri yayin cagrisi yoktur.
    const [chargeWrite, payWrite] = w.fake.posted;
    expect(chargeWrite!.outbox!.map((e) => e.eventId)).toEqual([`DUE_GENERATED:${charged.transaction.transactionId}`]);
    expect(payWrite!.outbox!.map((e) => e.eventId)).toEqual([`PAYMENT_RECEIVED:${paid.payment.paymentId}`]);
    expect(payWrite!.outbox![0]!.occurredAt).toBe('2026-09-01T09:00:00.000Z');

    w.setNow('2026-10-01');
    const fees = await w.service.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    const fresh = fees.items.filter((i) => !i.replayed);
    expect(fresh).toHaveLength(1);
    const lateFee = w.fake.events('LATE_FEE_POSTED');
    expect(lateFee).toHaveLength(1);
    expect(lateFee[0]).toMatchObject({
      eventId: `LATE_FEE_POSTED:2026-09:${fresh[0]!.transactionId}`,
      actorId: 'system-scheduler',
      groupKey: 'u1',
      payload: { period: '2026-09', items: [{ unitId: 'u1', liableParty: 'occupant', amount: fresh[0]!.amount, transactionId: fresh[0]!.transactionId }] },
    });
    expect(w.fake.posted.at(-1)!.outbox).toEqual([lateFee[0]]);

    // Gorevin tekrari: yeni yazim yok, yeni olay yok.
    await w.service.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    expect(w.fake.events('LATE_FEE_POSTED')).toHaveLength(1);
  });

  it('yazim basarisizsa olay da yoktur; tekrar denemede olay tam bir kez olusur', async () => {
    const w = world();
    const body = { idempotencyKey: 'k1', unitId: 'u1', liableParty: 'occupant', amount: TL(1000), date: '2026-09-01', dueDate: '2026-09-10', description: 'Eylül aidatı' };
    w.fake.failNext(new Error('TransactWriteItems iptal'));
    await expect(w.service.chargeUnit(w.ctx, body)).rejects.toThrow();
    expect(w.fake.outbox.size).toBe(0);

    const first = await w.service.chargeUnit(w.ctx, body);
    const again = await w.service.chargeUnit(w.ctx, body);
    expect(again.replayed).toBe(true);
    expect(w.fake.events('DUE_GENERATED').map((e) => e.eventId)).toEqual([`DUE_GENERATED:${first.transaction.transactionId}`]);
  });

  it('bos daire kurali: olaydaki borclu taraf gercek yazilan taraftir', async () => {
    const w = world();
    const memberships = {
      list: async () => [
        { apartmentId: APT, unitId: 'u1', userId: 'own', relation: 'owner', residesInUnit: false, status: 'active', startDate: '2026-01-01' },
      ],
    };
    const service = createFinanceService({
      repository: w.fake.repo,
      core: { getUnit: async () => unit('u1'), listUnits: async () => [unit('u1')] },
      now: () => NOW,
      newId: () => 'idx',
      memberships: memberships as never,
    });
    await service.chargeUnit(w.ctx, {
      idempotencyKey: 'k-vac', unitId: 'u1', liableParty: 'occupant', amount: TL(100), date: '2026-11-01', dueDate: '2026-11-10', description: 'Kasım aidatı',
    });
    const [due] = w.fake.events('DUE_GENERATED');
    expect(due!.payload.liableParty).toBe('owner');
    expect(due!.payload.items[0]!.liableParty).toBe('owner');
  });
});
