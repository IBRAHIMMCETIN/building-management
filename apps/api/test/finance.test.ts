import { computePartyDues } from '../src/modules/finance/reports.js';
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { DataAccessError, resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Kurus, type Unit, toKurus } from '../src/modules/core/types.js';
import {
  type FinanceRepository,
  LedgerConflictError,
  type PostInput,
  createFinanceRepository,
  financeKeys,
  toLedgerEntries,
} from '../src/modules/finance/repository.js';
import {
  FinanceError,
  type FinanceContext,
  createFinanceService,
  distributeKurus,
} from '../src/modules/finance/service.js';
import type {
  Account,
  Expense,
  IdempotencyRecord,
  Payment,
  Transaction,
} from '../src/modules/finance/types.js';
import { ValidationError } from '../src/modules/core/validation.js';

// ---------------------------------------------------------------------------
// Ortak yardimcilar
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-06T10:00:00.000Z');
const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const ctx: FinanceContext = { apartmentId: APT, userId: 'user-1' };
const meta = { $metadata: {} };

function unit(id: string, over: Partial<Unit> = {}): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: NOW.toISOString(),
    createdBy: 'seed',
    updatedAt: NOW.toISOString(),
    updatedBy: 'seed',
    version: 1,
    ...over,
  };
}

function fakeCore(units: Unit[]): Pick<CoreRepository, 'getUnit' | 'listUnits'> {
  return {
    getUnit: async (apartmentId, unitId) =>
      units.find((u) => u.siteId === apartmentId && u.unitId === unitId),
    listUnits: async (apartmentId) => units.filter((u) => u.siteId === apartmentId),
  };
}

/** DynamoDB semantigini taklit eden bellek ici defter: atomik, kosullu, surumlu. */
function createFakeFinanceRepo() {
  const accounts = new Map<string, Account>();
  const transactions = new Map<string, Transaction>();
  const payments = new Map<string, Payment>();
  const expenses = new Map<string, Expense>();
  const idem = new Map<string, IdempotencyRecord>();
  const counters = new Map<string, number>();
  const posted: PostInput[] = [];
  const k = (apt: string, id: string) => `${apt}|${id}`;
  let failNextPost: Error | undefined;

  const repo: FinanceRepository = {
    getAccount: async (apt, id) => accounts.get(k(apt, id)),
    listAccounts: async (apt) => [...accounts.values()].filter((a) => a.siteId === apt),
    createAccount: async (a) => {
      if (accounts.has(k(a.siteId, a.accountId))) throw new DataAccessError('conflict', 'var');
      accounts.set(k(a.siteId, a.accountId), a);
    },
    updateAccount: async (a, expectedVersion) => {
      const cur = accounts.get(k(a.siteId, a.accountId));
      if (!cur || cur.version !== expectedVersion) throw new DataAccessError('conflict', 'surum');
      accounts.set(k(a.siteId, a.accountId), { ...cur, name: a.name, status: a.status, version: cur.version + 1 });
    },
    ensureAccounts: async (list) => {
      for (const a of list) if (!accounts.has(k(a.siteId, a.accountId))) accounts.set(k(a.siteId, a.accountId), a);
    },
    getTransaction: async (apt, id) => transactions.get(k(apt, id)),
    getPayment: async (apt, id) => payments.get(k(apt, id)),
    getExpense: async (apt, id) => expenses.get(k(apt, id)),
    getIdempotency: async (apt, id) => idem.get(k(apt, id)),
    getCounter: async (apt, name) => counters.get(k(apt, name)) ?? 0,
    listTransactions: async (apt, q = {}) => {
      const lo = (q.from ?? '0000-00-00').replaceAll('-', '');
      const hi = (q.to ?? '9999-99-99').replaceAll('-', '') + '~';
      const all = [...transactions.values()]
        .filter((t) => t.siteId === apt && t.transactionId >= lo && t.transactionId <= hi)
        .sort((a, b) => a.transactionId.localeCompare(b.transactionId) * (q.newestFirst ? -1 : 1));
      const start = q.cursor ? Number(q.cursor) : 0;
      if (!q.limit) return { items: all.slice(start) };
      const end = start + q.limit;
      return { items: all.slice(start, end), cursor: end < all.length ? String(end) : undefined };
    },
    postTransaction: async (input) => {
      if (failNextPost) {
        const e = failNextPost;
        failNextPost = undefined;
        throw e;
      }
      const tx = input.transaction;
      const apt = tx.siteId;
      // 1) Tum kosullar (atomiklik: hicbir sey yazilmadan once)
      let debit = 0;
      let credit = 0;
      for (const l of tx.lines) {
        if (!Number.isSafeInteger(l.amount) || l.amount < 1) throw new Error('gecersiz tutar');
        if (l.side === 'debit') debit += l.amount;
        else credit += l.amount;
      }
      if (debit !== credit) throw new Error('dengesiz islem');
      if (idem.has(k(apt, input.idempotency.id))) throw new LedgerConflictError('duplicate');
      for (const l of tx.lines) {
        const acc = accounts.get(k(apt, l.accountId));
        if (!acc) throw new LedgerConflictError('account_missing');
        const exp = input.expectedVersions?.[l.accountId];
        if (exp !== undefined && acc.version !== exp) throw new LedgerConflictError('version');
      }
      if (input.counter && (counters.get(k(apt, input.counter.name)) ?? 0) !== input.counter.expected) {
        throw new LedgerConflictError('counter');
      }
      // 2) Yazim
      idem.set(k(apt, input.idempotency.id), {
        transactionId: tx.transactionId,
        recordId: input.idempotency.recordId,
        fingerprint: input.idempotency.fingerprint,
      });
      transactions.set(k(apt, tx.transactionId), tx);
      for (const l of tx.lines) {
        const acc = accounts.get(k(apt, l.accountId))!;
        accounts.set(k(apt, l.accountId), {
          ...acc,
          balance: toKurus(acc.balance + (l.side === 'debit' ? l.amount : -l.amount)),
          version: acc.version + 1,
        });
      }
      if (input.counter) counters.set(k(apt, input.counter.name), input.counter.expected + 1);
      if (input.record?.entityType === 'PAYMENT') payments.set(k(apt, input.record.paymentId), input.record);
      if (input.record?.entityType === 'EXPENSE') expenses.set(k(apt, input.record.expenseId), input.record);
      posted.push(input);
    },
  };

  const balanceOf = (id: string, apt = APT) => accounts.get(k(apt, id))?.balance ?? 0;
  /** Mizan: tum hesap bakiyelerinin toplami her zaman 0 olmali (borc = alacak). */
  const trialBalance = () => [...accounts.values()].reduce((s, a) => s + a.balance, 0);

  return {
    repo,
    accounts,
    transactions,
    payments,
    expenses,
    idem,
    counters,
    posted,
    balanceOf,
    trialBalance,
    failNext: (e: Error) => {
      failNextPost = e;
    },
  };
}

function makeService(units: Unit[] = [unit('u1'), unit('u2'), unit('u3')]) {
  const fake = createFakeFinanceRepo();
  let n = 0;
  const service = createFinanceService({
    repository: fake.repo,
    core: fakeCore(units),
    now: () => NOW,
    newId: () => `id-${++n}`,
  });
  return { service, ...fake };
}

const dueBase = { dueDate: '2026-11-15', date: '2026-11-01', description: 'Kasim aidati' };

function tx(over: Partial<Transaction> = {}): Transaction {
  const transactionId = over.transactionId ?? '20261101-t1';
  return {
    ...financeKeys.transaction(APT, transactionId),
    entityType: 'TRANSACTION',
    transactionId,
    siteId: APT,
    kind: 'dues_charge',
    date: '2026-11-01',
    description: 'test',
    lines: [
      { accountId: 'recv-u1-owner', side: 'debit', amount: toKurus(150050), unitId: 'u1', liableParty: 'owner' },
      { accountId: 'income-dues', side: 'credit', amount: toKurus(150050) },
    ],
    totalAmount: toKurus(150050),
    createdAt: NOW.toISOString(),
    createdBy: 'user-1',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// distributeKurus (saf fonksiyon)
// ---------------------------------------------------------------------------

describe('distributeKurus', () => {
  it('toplami kurusuna kadar korur (en buyuk kalan)', () => {
    const shares = distributeKurus(10000, [1n, 1n, 1n]);
    expect(shares).toEqual([3334, 3333, 3333]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it('agirlikli dagitimda toplam sabit kalir', () => {
    const shares = distributeKurus(100001, [855n, 1000n, 1234n]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100001);
    expect(shares.every((s) => Number.isInteger(s) && s >= 0)).toBe(true);
  });

  it('1 kurus 3 daire arasinda ilk dairede kalir', () => {
    expect(distributeKurus(1, [1n, 1n, 1n])).toEqual([1, 0, 0]);
  });

  it('gecersiz girdileri reddeder', () => {
    expect(() => distributeKurus(-1, [1n])).toThrow();
    expect(() => distributeKurus(10.5, [1n])).toThrow();
    expect(() => distributeKurus(10, [])).toThrow();
    expect(() => distributeKurus(10, [0n, 0n])).toThrow();
    expect(() => distributeKurus(10, [-1n, 2n])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Repository (aws-sdk-client-mock)
// ---------------------------------------------------------------------------

describe('finance repository - postTransaction', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createFinanceRepository();
  const idempotency = { id: 'key-12345', fingerprint: 'fp' };

  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const items = () => ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;

  it('tek TransactWriteItems ile islem, satirlar, bakiyeler ve idempotency yazar', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await repo.postTransaction({
      transaction: tx(),
      idempotency,
      expectedVersions: { 'income-dues': 7 },
    });

    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(1);
    const list = items();
    // idem + tx + 2 satir + 2 hesap
    expect(list).toHaveLength(6);

    expect(list[0]!.Put!.Item!.SK).toBe('IDEM#key-12345');
    expect(list[0]!.Put!.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(list[1]!.Put!.Item!.SK).toBe('TX#20261101-t1');
    expect(list[2]!.Put!.Item!.SK).toBe('LE#recv-u1-owner#20261101-t1#1');
    expect(list[3]!.Put!.Item!.SK).toBe('LE#income-dues#20261101-t1#2');
    for (const i of list.slice(0, 4)) expect(i.Put!.Item!.PK).toBe('APT#apt-1');

    const recv = list[4]!.Update!;
    const income = list[5]!.Update!;
    expect(recv.Key).toEqual({ PK: 'APT#apt-1', SK: 'ACCT#recv-u1-owner' });
    expect(recv.ExpressionAttributeValues![':delta']).toBe(150050); // borc: +
    expect(income.ExpressionAttributeValues![':delta']).toBe(-150050); // alacak: -
    expect(recv.ConditionExpression).toBe('attribute_exists(PK)');
    expect(income.ConditionExpression).toContain('#version = :expectedVersion');
    expect(income.ExpressionAttributeValues![':expectedVersion']).toBe(7);
  });

  it('sayac ve belgeyi ayni atomik yazima ekler', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    const record = { PK: 'APT#apt-1', SK: 'PAY#p1', entityType: 'PAYMENT' } as unknown as Payment;
    await repo.postTransaction({
      transaction: tx(),
      idempotency,
      counter: { name: 'receipt', expected: 4 },
      record,
    });
    const list = items();
    const counter = list.find((i) => i.Update?.Key?.SK === 'CTR#receipt')!.Update!;
    expect(counter.ConditionExpression).toBe('#value = :expected');
    expect(counter.ExpressionAttributeValues![':next']).toBe(5);
    expect(list.at(-1)!.Put!.Item!.SK).toBe('PAY#p1');
  });

  it('ilk makbuz numarasinda sayac attribute_not_exists ile olusturulur', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await repo.postTransaction({ transaction: tx(), idempotency, counter: { name: 'receipt', expected: 0 } });
    const counter = items().find((i) => i.Update?.Key?.SK === 'CTR#receipt')!.Update!;
    expect(counter.ConditionExpression).toBe('attribute_not_exists(PK)');
  });

  it('dengesiz islemi DynamoDB cagrisi yapmadan reddeder', async () => {
    const bad = tx({
      lines: [
        { accountId: 'a', side: 'debit', amount: toKurus(100) },
        { accountId: 'b', side: 'credit', amount: toKurus(99) },
      ],
      totalAmount: toKurus(100),
    });
    await expect(repo.postTransaction({ transaction: bad, idempotency })).rejects.toThrow(/esit degil/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it.each([0, -500, 1.5, Number.NaN])('gecersiz tutari (%s) reddeder', async (amount) => {
    const bad = tx({
      lines: [
        { accountId: 'a', side: 'debit', amount: amount as Kurus },
        { accountId: 'b', side: 'credit', amount: amount as Kurus },
      ],
      totalAmount: amount as Kurus,
    });
    await expect(repo.postTransaction({ transaction: bad, idempotency })).rejects.toThrow();
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('tek satirli veya fazla satirli islemi reddeder', async () => {
    const one = tx({ lines: [{ accountId: 'a', side: 'debit', amount: toKurus(5) }], totalAmount: toKurus(5) });
    await expect(repo.postTransaction({ transaction: one, idempotency })).rejects.toThrow(/satir/);
  });

  it('baska tenant anahtarli islemi reddeder', async () => {
    const foreign = tx({ PK: 'APT#apt-2' });
    await expect(repo.postTransaction({ transaction: foreign, idempotency })).rejects.toThrow(/tenant/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('turetilen defter satirlari islemle birebir eslesir', () => {
    const entries = toLedgerEntries(tx());
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => `${e.side}:${e.amount}`)).toEqual(['debit:150050', 'credit:150050']);
    expect(entries.every((e) => e.transactionId === '20261101-t1')).toBe(true);
  });

  const cancel = (codes: string[]) =>
    new TransactionCanceledException({
      message: 'iptal',
      CancellationReasons: codes.map((Code) => ({ Code })),
      ...meta,
    });

  it('idempotency kosulu basarisizsa LedgerConflictError(duplicate) firlatir', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancel(['ConditionalCheckFailed', 'None', 'None', 'None', 'None', 'None']));
    await expect(repo.postTransaction({ transaction: tx(), idempotency })).rejects.toMatchObject({
      name: 'LedgerConflictError',
      reason: 'duplicate',
    });
  });

  it('surum kosulu basarisizsa reason=version', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancel(['None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed']));
    await expect(
      repo.postTransaction({ transaction: tx(), idempotency, expectedVersions: { 'income-dues': 3 } }),
    ).rejects.toMatchObject({ reason: 'version' });
  });

  it('surum beklenmeyen hesap yoksa reason=account_missing', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancel(['None', 'None', 'None', 'None', 'ConditionalCheckFailed', 'None']));
    await expect(repo.postTransaction({ transaction: tx(), idempotency })).rejects.toMatchObject({
      reason: 'account_missing',
    });
  });

  it('sayac cakismasi reason=counter', async () => {
    ddbMock.on(TransactWriteCommand).rejects(cancel(['None', 'None', 'None', 'None', 'None', 'None', 'ConditionalCheckFailed']));
    await expect(
      repo.postTransaction({ transaction: tx(), idempotency, counter: { name: 'receipt', expected: 2 } }),
    ).rejects.toMatchObject({ reason: 'counter' });
  });

  it('gecici TransactionConflict sonrasi tekrar dener', async () => {
    ddbMock
      .on(TransactWriteCommand)
      .rejectsOnce(cancel(['None', 'None', 'None', 'None', 'None', 'TransactionConflict']))
      .resolves({});
    await repo.postTransaction({ transaction: tx(), idempotency });
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(2);
  });

  it('diger SDK hatalarini DataAccessError olarak yukseltir', async () => {
    ddbMock.on(TransactWriteCommand).rejects(new ConditionalCheckFailedException({ message: 'x', ...meta }));
    await expect(repo.postTransaction({ transaction: tx(), idempotency })).rejects.toBeInstanceOf(DataAccessError);
  });
});

// ---------------------------------------------------------------------------
// Servis: tahakkuk
// ---------------------------------------------------------------------------

describe('finance service - aidat tahakkuku', () => {
  it('tekil tahakkuk borc ve alacagi atomik gunceller; mizan sifir kalir', async () => {
    const t = makeService();
    const r = await t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'occupant', amount: 150050, ...dueBase,
    });
    expect(r.replayed).toBe(false);
    expect(t.balanceOf('recv-u1-occupant')).toBe(150050);
    expect(t.balanceOf('income-dues')).toBe(-150050);
    expect(t.trialBalance()).toBe(0);
    expect(r.transaction.kind).toBe('dues_charge');
    expect(r.transaction.lines.map((l) => l.side)).toEqual(['debit', 'credit']);
  });

  it('ayni idempotencyKey ile tekrar: ikinci borc yazilmaz (replay)', async () => {
    const t = makeService();
    const body = { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 5000, ...dueBase };
    const a = await t.service.chargeUnit(ctx, body);
    const b = await t.service.chargeUnit(ctx, body);
    expect(b.replayed).toBe(true);
    expect(b.transaction.transactionId).toBe(a.transaction.transactionId);
    expect(t.balanceOf('recv-u1-owner')).toBe(5000);
    expect(t.posted).toHaveLength(1);
  });

  it('ayni anahtar farkli tutarla kullanilirsa 409 idempotency_conflict', async () => {
    const t = makeService();
    const body = { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 5000, ...dueBase };
    await t.service.chargeUnit(ctx, body);
    await expect(t.service.chargeUnit(ctx, { ...body, amount: 6000 })).rejects.toMatchObject({
      code: 'idempotency_conflict',
      httpStatus: 409,
    });
    expect(t.balanceOf('recv-u1-owner')).toBe(5000);
  });

  it.each([
    ['sifir', 0],
    ['negatif', -100],
    ['ondalikli', 10.5],
    ['string', '100'],
    ['ust sinir asan', 1e15],
    ['NaN', Number.NaN],
  ])('%s tutari reddeder ve hicbir sey yazmaz', async (_label, amount) => {
    const t = makeService();
    await expect(
      t.service.chargeUnit(ctx, { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount, ...dueBase }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(t.posted).toHaveLength(0);
    expect(t.transactions.size).toBe(0);
  });

  it('gecersiz tarih/anahtar/sorumlu taraf reddedilir', async () => {
    const t = makeService();
    const ok = { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 100, ...dueBase };
    await expect(t.service.chargeUnit(ctx, { ...ok, dueDate: '2026-13-40' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.service.chargeUnit(ctx, { ...ok, idempotencyKey: 'a#b' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.service.chargeUnit(ctx, { ...ok, liableParty: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.service.chargeUnit(ctx, null)).rejects.toBeInstanceOf(ValidationError);
  });

  it('olmayan veya pasif bagimsiz bolum icin tahakkuk yapilmaz', async () => {
    const t = makeService([unit('u1'), unit('u9', { status: 'inactive' })]);
    const base = { idempotencyKey: 'dues-0001', liableParty: 'owner', amount: 100, ...dueBase };
    await expect(t.service.chargeUnit(ctx, { ...base, unitId: 'nope' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.chargeUnit(ctx, { ...base, unitId: 'u9' })).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it('baska apartmanin bagimsiz bolumune tahakkuk yapilamaz (tenant izolasyonu)', async () => {
    const t = makeService([unit('u1')]);
    await expect(
      t.service.chargeUnit(
        { apartmentId: OTHER_APT, userId: 'x' },
        { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 100, ...dueBase },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('toplu tahakkuk esit dagitimda toplam kurusu korur', async () => {
    const t = makeService();
    const r = await t.service.chargeBulk(ctx, {
      idempotencyKey: 'bulk-0001', liableParty: 'occupant', totalAmount: 10000, distributionKey: 'equal', ...dueBase,
    });
    expect(r.items.map((i) => i.amount)).toEqual([3334, 3333, 3333]);
    expect(r.distributedAmount).toBe(10000);
    expect(t.balanceOf('income-dues')).toBe(-10000);
    expect(t.trialBalance()).toBe(0);
  });

  it('toplu tahakkuk metrekareye gore dagitir', async () => {
    const t = makeService([
      unit('u1', { grossAreaTenthsM2: 500 }),
      unit('u2', { grossAreaTenthsM2: 1500 }),
    ]);
    const r = await t.service.chargeBulk(ctx, {
      idempotencyKey: 'bulk-0002', liableParty: 'owner', totalAmount: 20000, distributionKey: 'area', ...dueBase,
    });
    expect(r.items.map((i) => i.amount)).toEqual([5000, 15000]);
  });

  it('toplu tahakkuk arsa payina gore dagitir; arsa payi yoksa reddeder', async () => {
    const t = makeService([
      unit('u1', { landShare: { numerator: 1, denominator: 4 } }),
      unit('u2', { landShare: { numerator: 3, denominator: 4 } }),
    ]);
    const r = await t.service.chargeBulk(ctx, {
      idempotencyKey: 'bulk-0003', liableParty: 'owner', totalAmount: 10000, distributionKey: 'land_share', ...dueBase,
    });
    expect(r.items.map((i) => i.amount)).toEqual([2500, 7500]);

    const t2 = makeService([unit('u1'), unit('u2')]);
    await expect(
      t2.service.chargeBulk(ctx, {
        idempotencyKey: 'bulk-0004', liableParty: 'owner', totalAmount: 10000, distributionKey: 'land_share', ...dueBase,
      }),
    ).rejects.toMatchObject({ code: 'unprocessable' });
    expect(t2.posted).toHaveLength(0);
  });

  it('sayac/endeks anahtari toplu aidatta desteklenmez (400)', async () => {
    const t = makeService();
    await expect(
      t.service.chargeBulk(ctx, {
        idempotencyKey: 'bulk-0005', liableParty: 'owner', totalAmount: 100, distributionKey: 'meter', ...dueBase,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('toplu tahakkuk tekrari mukerrer borc yazmaz; yarim kalan istek tamamlanir', async () => {
    const t = makeService();
    const body = {
      idempotencyKey: 'bulk-0006', liableParty: 'occupant', totalAmount: 9000, distributionKey: 'equal', ...dueBase,
    };
    // Ilk istek 2. dairede kesilir: ilk daire yazildi, sonrasi yazilmadi.
    const original = t.repo.postTransaction;
    let calls = 0;
    t.repo.postTransaction = async (input) => {
      if (++calls === 2) throw new Error('boom');
      return original(input);
    };
    await expect(t.service.chargeBulk(ctx, body)).rejects.toThrow('boom');
    expect(t.transactions.size).toBe(1);
    t.repo.postTransaction = original;

    const r = await t.service.chargeBulk(ctx, body);
    expect(r.count).toBe(3);
    expect(r.items.map((i) => i.replayed)).toEqual([true, false, false]);
    expect(t.transactions.size).toBe(3);
    expect(t.balanceOf('income-dues')).toBe(-9000);

    const again = await t.service.chargeBulk(ctx, body);
    expect(again.replayed).toBe(true);
    expect(t.transactions.size).toBe(3);
    expect(t.trialBalance()).toBe(0);
  });

  it('bagimsiz bolum filtresi ve olmayan daire 404', async () => {
    const t = makeService();
    const base = { idempotencyKey: 'bulk-0007', liableParty: 'owner', totalAmount: 1000, distributionKey: 'equal', ...dueBase };
    const r = await t.service.chargeBulk(ctx, { ...base, unitIds: ['u1', 'u2'] });
    expect(r.count).toBe(2);
    await expect(t.service.chargeBulk(ctx, { ...base, idempotencyKey: 'bulk-0008', unitIds: ['zzz'] })).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

// ---------------------------------------------------------------------------
// Servis: tahsilat, gider, ters kayit, bakiye, hesaplar
// ---------------------------------------------------------------------------

describe('finance service - tahsilat', () => {
  const charge = (t: ReturnType<typeof makeService>, amount = 100000) =>
    t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'occupant', amount, ...dueBase,
    });
  const pay = { idempotencyKey: 'pay-00001', unitId: 'u1', liableParty: 'occupant', method: 'cash', amount: 40000 };

  it('tahsilat kasayi borclandirir, sakin carisini alacaklandirir ve makbuz no verir', async () => {
    const t = makeService();
    await charge(t);
    const r = await t.service.recordPayment(ctx, pay);
    expect(r.payment.receiptNumber).toBe('MKB-000001');
    expect(t.balanceOf('cash')).toBe(40000);
    expect(t.balanceOf('recv-u1-occupant')).toBe(60000);
    expect(t.trialBalance()).toBe(0);
    expect(r.transaction.kind).toBe('payment');
  });

  it('havale/kart varsayilan olarak banka hesabina yazilir; makbuz numaralari ardisiktir', async () => {
    const t = makeService();
    await charge(t);
    await t.service.recordPayment(ctx, pay);
    const r = await t.service.recordPayment(ctx, { ...pay, idempotencyKey: 'pay-00002', method: 'bank_transfer', amount: 10000 });
    expect(r.payment.receiptNumber).toBe('MKB-000002');
    expect(t.balanceOf('bank')).toBe(10000);
  });

  it('ayni tahsilat tekrar gonderilirse cift tahsilat olmaz', async () => {
    const t = makeService();
    await charge(t);
    const a = await t.service.recordPayment(ctx, pay);
    const b = await t.service.recordPayment(ctx, pay);
    expect(b.replayed).toBe(true);
    expect(b.payment.paymentId).toBe(a.payment.paymentId);
    expect(t.balanceOf('cash')).toBe(40000);
    expect(t.counters.get(`${APT}|receipt`)).toBe(1);
  });

  it('fazla odeme avans (negatif bakiye) olarak kalir', async () => {
    const t = makeService();
    await charge(t, 10000);
    await t.service.recordPayment(ctx, { ...pay, amount: 25000 });
    const b = await t.service.getUnitBalance(ctx, 'u1');
    expect(b.occupant).toEqual({ balance: -15000, debt: 0, credit: 15000 });
  });

  it.each([0, -1, 2.5, '5'])('gecersiz tahsilat tutari (%s) reddedilir', async (amount) => {
    const t = makeService();
    await expect(t.service.recordPayment(ctx, { ...pay, amount })).rejects.toBeInstanceOf(ValidationError);
    expect(t.posted).toHaveLength(0);
  });

  it('kasa/banka olmayan veya olmayan tahsilat hesabini reddeder', async () => {
    const t = makeService();
    await expect(t.service.recordPayment(ctx, { ...pay, depositAccountId: 'income-dues' })).rejects.toMatchObject({
      code: 'unprocessable',
    });
    await expect(t.service.recordPayment(ctx, { ...pay, depositAccountId: 'yok' })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('makbuz sayaci cakisirsa yeniden okuyup tekrar dener', async () => {
    const t = makeService();
    const original = t.repo.postTransaction;
    let first = true;
    t.repo.postTransaction = async (input) => {
      if (first) {
        first = false;
        t.counters.set(`${APT}|receipt`, 7); // baska bir istek araya girdi
      }
      return original(input);
    };
    const r = await t.service.recordPayment(ctx, pay);
    expect(r.payment.receiptNumber).toBe('MKB-000008');
  });

  it('olmayan bagimsiz bolum icin tahsilat 404', async () => {
    const t = makeService();
    await expect(t.service.recordPayment(ctx, { ...pay, unitId: 'yok' })).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('finance service - gider', () => {
  async function withExpenseAccount() {
    const t = makeService();
    await t.service.listAccounts(ctx); // sistem hesaplari
    await t.service.createAccount(ctx, { accountId: 'exp-clean', type: 'expense', name: 'Temizlik' });
    return t;
  }
  const exp = { idempotencyKey: 'exp-00001', expenseAccountId: 'exp-clean', amount: 30000, description: 'Temizlik' };

  async function fund(t: ReturnType<typeof makeService>, amount: number) {
    await t.service.chargeUnit(ctx, { idempotencyKey: 'dues-f001', unitId: 'u1', liableParty: 'owner', amount, ...dueBase });
    await t.service.recordPayment(ctx, { idempotencyKey: 'pay-f0001', unitId: 'u1', liableParty: 'owner', method: 'cash', amount });
  }

  it('gider kasadan odenir: gider hesabi borclanir, kasa alacaklanir', async () => {
    const t = await withExpenseAccount();
    await fund(t, 50000);
    const r = await t.service.recordExpense(ctx, { ...exp, supplier: 'ABC', invoiceNumber: 'F-1' });
    expect(t.balanceOf('exp-clean')).toBe(30000);
    expect(t.balanceOf('cash')).toBe(20000);
    expect(t.trialBalance()).toBe(0);
    expect(r.expense.supplier).toBe('ABC');
  });

  it('kasa bakiyesi yetersizse gider reddedilir ve hicbir sey yazilmaz', async () => {
    const t = await withExpenseAccount();
    await fund(t, 10000);
    const before = t.posted.length;
    await expect(t.service.recordExpense(ctx, exp)).rejects.toMatchObject({ code: 'insufficient_funds', httpStatus: 422 });
    expect(t.posted).toHaveLength(before);
    expect(t.balanceOf('cash')).toBe(10000);
  });

  it('vadeli gider tedarikci borcuna yazilir (kasa kontrolu yok)', async () => {
    const t = await withExpenseAccount();
    await t.service.recordExpense(ctx, { ...exp, creditAccountId: 'payable' });
    expect(t.balanceOf('payable')).toBe(-30000);
    expect(t.balanceOf('exp-clean')).toBe(30000);
    expect(t.trialBalance()).toBe(0);
  });

  it('ayni gider tekrar gonderilirse cift kayit olmaz', async () => {
    const t = await withExpenseAccount();
    await t.service.recordExpense(ctx, { ...exp, creditAccountId: 'payable' });
    const again = await t.service.recordExpense(ctx, { ...exp, creditAccountId: 'payable' });
    expect(again.replayed).toBe(true);
    expect(t.balanceOf('exp-clean')).toBe(30000);
  });

  it('gider hesabi olmayan/yanlis turde hesapla reddedilir', async () => {
    const t = await withExpenseAccount();
    await expect(t.service.recordExpense(ctx, { ...exp, expenseAccountId: 'yok' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.recordExpense(ctx, { ...exp, expenseAccountId: 'cash' })).rejects.toMatchObject({ code: 'unprocessable' });
  });

  it.each([0, -50, 1.1])('gecersiz gider tutari (%s) reddedilir', async (amount) => {
    const t = await withExpenseAccount();
    await expect(t.service.recordExpense(ctx, { ...exp, amount })).rejects.toBeInstanceOf(ValidationError);
  });

  it('es zamanli kasa degisikligi (surum cakismasi) yeniden degerlendirilir', async () => {
    const t = await withExpenseAccount();
    await fund(t, 50000);
    const original = t.repo.postTransaction;
    let first = true;
    t.repo.postTransaction = async (input) => {
      if (first) {
        first = false;
        const cash = t.accounts.get(`${APT}|cash`)!;
        // Baska bir gider kasayi 45.000'e dusurdu (surum artti)
        t.accounts.set(`${APT}|cash`, { ...cash, balance: toKurus(5000), version: cash.version + 1 });
      }
      return original(input);
    };
    await expect(t.service.recordExpense(ctx, exp)).rejects.toMatchObject({ code: 'insufficient_funds' });
  });
});

describe('finance service - ters kayit', () => {
  it('ters kayit bakiyeleri sifirlar; defter silinmez/guncellenmez', async () => {
    const t = makeService();
    const dues = await t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 7777, ...dueBase,
    });
    const rev = await t.service.reverseTransaction(ctx, dues.transaction.transactionId, { reason: 'Hatali tahakkuk' });
    expect(rev.transaction.kind).toBe('reversal');
    expect(rev.transaction.reversalOf).toBe(dues.transaction.transactionId);
    expect(t.balanceOf('recv-u1-owner')).toBe(0);
    expect(t.balanceOf('income-dues')).toBe(0);
    expect(t.transactions.get(`${APT}|${dues.transaction.transactionId}`)).toEqual(dues.transaction);
    expect(t.transactions.size).toBe(2);
    expect(t.trialBalance()).toBe(0);
  });

  it('ayni islem ikinci kez ters cevrilemez; tekrar istek replay olur', async () => {
    const t = makeService();
    const dues = await t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 100, ...dueBase,
    });
    const id = dues.transaction.transactionId;
    const a = await t.service.reverseTransaction(ctx, id, { reason: 'x' });
    const b = await t.service.reverseTransaction(ctx, id, { reason: 'x' });
    expect(b.replayed).toBe(true);
    expect(b.transaction.transactionId).toBe(a.transaction.transactionId);
    await expect(t.service.reverseTransaction(ctx, id, { reason: 'baska neden' })).rejects.toMatchObject({ code: 'conflict' });
    expect(t.balanceOf('income-dues')).toBe(0);
  });

  it('ters kayit tekrar ters cevrilemez; neden zorunlu; olmayan islem 404', async () => {
    const t = makeService();
    const dues = await t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 100, ...dueBase,
    });
    const rev = await t.service.reverseTransaction(ctx, dues.transaction.transactionId, { reason: 'x' });
    await expect(t.service.reverseTransaction(ctx, rev.transaction.transactionId, { reason: 'y' })).rejects.toMatchObject({
      code: 'unprocessable',
    });
    await expect(t.service.reverseTransaction(ctx, dues.transaction.transactionId, {})).rejects.toBeInstanceOf(ValidationError);
    await expect(t.service.reverseTransaction(ctx, 'yok', { reason: 'x' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('baska apartmanin islemi ters cevrilemez', async () => {
    const t = makeService();
    const dues = await t.service.chargeUnit(ctx, {
      idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 100, ...dueBase,
    });
    await expect(
      t.service.reverseTransaction({ apartmentId: OTHER_APT, userId: 'x' }, dues.transaction.transactionId, { reason: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('finance service - bakiye ve hesaplar', () => {
  it('daire bakiyesi malik ve sakin alt carilerini ayri ve toplam gosterir', async () => {
    const t = makeService();
    await t.service.chargeUnit(ctx, { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'occupant', amount: 30000, ...dueBase });
    await t.service.chargeUnit(ctx, { idempotencyKey: 'dues-0002', unitId: 'u1', liableParty: 'owner', amount: 90000, ...dueBase });
    await t.service.recordPayment(ctx, { idempotencyKey: 'pay-00001', unitId: 'u1', liableParty: 'occupant', method: 'cash', amount: 10000 });
    const b = await t.service.getUnitBalance(ctx, 'u1');
    expect(b).toMatchObject({
      currency: 'TRY',
      owner: { balance: 90000, debt: 90000, credit: 0 },
      occupant: { balance: 20000, debt: 20000, credit: 0 },
      balance: 110000,
      debt: 110000,
      credit: 0,
    });
  });

  it('hareketsiz dairenin bakiyesi sifirdir; baska dairenin borcu karismaz', async () => {
    const t = makeService();
    await t.service.chargeUnit(ctx, { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 500, ...dueBase });
    expect((await t.service.getUnitBalance(ctx, 'u2')).balance).toBe(0);
  });

  it('olmayan daire ve baska apartman icin bakiye sorgusu 404', async () => {
    const t = makeService();
    await expect(t.service.getUnitBalance(ctx, 'yok')).rejects.toMatchObject({ code: 'not_found' });
    await expect(t.service.getUnitBalance({ apartmentId: OTHER_APT, userId: 'x' }, 'u1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('hesap listesi sistem hesaplarini olusturur ve tipe gore filtreler', async () => {
    const t = makeService();
    const all = await t.service.listAccounts(ctx);
    const ids = all.map((a) => a.accountId);
    expect(ids).toEqual(expect.arrayContaining(['bank', 'cash', 'income-dues', 'payable', 'exp-cleaning', 'exp-elevator']));
    expect(all.filter((a) => a.system).map((a) => a.accountId).sort()).toEqual(['bank', 'cash', 'income-dues', 'payable']);
    // Varsayilan gider kalemleri sistem hesabi degil: yonetici pasife alabilir.
    expect(all.find((a) => a.accountId === 'exp-cleaning')).toMatchObject({ type: 'expense', name: 'Temizlik' });
    expect((await t.service.listAccounts(ctx, 'bank')).map((a) => a.accountId)).toEqual(['bank']);
    await expect(t.service.listAccounts(ctx, 'xx')).rejects.toBeInstanceOf(ValidationError);
  });

  it('hesap olusturma: receivable elle acilamaz, ayni kimlik 409, sistem hesabi pasife alinamaz', async () => {
    const t = makeService();
    await expect(t.service.createAccount(ctx, { type: 'receivable', name: 'x' })).rejects.toBeInstanceOf(ValidationError);
    await t.service.createAccount(ctx, { accountId: 'exp-1', type: 'expense', name: 'Asansor' });
    await expect(t.service.createAccount(ctx, { accountId: 'exp-1', type: 'expense', name: 'Asansor' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await t.service.listAccounts(ctx);
    await expect(t.service.updateAccount(ctx, 'cash', { status: 'inactive' })).rejects.toMatchObject({ code: 'unprocessable' });
    const upd = await t.service.updateAccount(ctx, 'exp-1', { name: 'Asansor Bakim' });
    expect(upd.name).toBe('Asansor Bakim');
    await expect(t.service.updateAccount(ctx, 'yok', { name: 'x' })).rejects.toBeInstanceOf(FinanceError);
  });

  it('bakiyesi sifir olmayan hesap pasife alinamaz', async () => {
    const t = makeService();
    await t.service.chargeUnit(ctx, { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 500, ...dueBase });
    await expect(t.service.updateAccount(ctx, 'income-dues', { status: 'inactive' })).rejects.toMatchObject({ code: 'unprocessable' });
  });
});

// ---------------------------------------------------------------------------
// Rotalar: yetki, tenant izolasyonu, dogrulama
// ---------------------------------------------------------------------------

describe('finance routes', () => {
  const claims = (role: AuthClaims['role'], apartmentId: string = APT): AuthClaims => ({
    userId: 'user-1',
    role,
    apartmentId,
  });
  const manager = claims('apartment_manager');

  function setup(units: Unit[] = [unit('u1'), unit('u2')]) {
    const t = makeService(units);
    const app = createApp({
      version: 'test',
      financeService: t.service,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const call = async (method: string, path: string, who?: AuthClaims | null, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: {
          ...(who ? { 'x-test-claims': JSON.stringify(who) } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    return { ...t, call };
  }

  const duesBody = { idempotencyKey: 'dues-0001', unitId: 'u1', liableParty: 'owner', amount: 12345, ...dueBase };

  it('kimlik yoksa tum finans rotalari 401 doner', async () => {
    const { call } = setup();
    for (const [m, p] of [
      ['GET', '/api/finance/accounts'],
      ['POST', '/api/finance/dues'],
      ['POST', '/api/finance/payments'],
      ['GET', '/api/finance/balance/u1'],
    ] as const) {
      expect((await call(m, p)).status).toBe(401);
    }
  });

  it('authenticate verilmezse varsayilan 401', async () => {
    const res = await createApp({ version: 'x' }).request('/api/finance/accounts');
    expect(res.status).toBe(401);
  });

  it.each(['resident', 'building_staff', 'security_guard', 'platform_admin'] as const)(
    '%s rolu finans islemlerine erisemez (403)',
    async (role) => {
      const { call, posted } = setup();
      expect((await call('GET', '/api/finance/accounts', claims(role))).status).toBe(403);
      expect((await call('GET', '/api/finance/balance/u1', claims(role))).status).toBe(403);
      expect((await call('POST', '/api/finance/dues', claims(role), duesBody)).status).toBe(403);
      expect((await call('POST', '/api/finance/payments', claims(role), {})).status).toBe(403);
      expect(posted).toHaveLength(0);
    },
  );

  it('observer salt okunurdur: okur ama yazamaz', async () => {
    const { call, posted } = setup();
    const obs = claims('observer');
    expect((await call('GET', '/api/finance/accounts', obs)).status).toBe(200);
    expect((await call('GET', '/api/finance/balance/u1', obs)).status).toBe(200);
    expect((await call('POST', '/api/finance/dues', obs, duesBody)).status).toBe(403);
    expect((await call('POST', '/api/finance/payments', obs, {})).status).toBe(403);
    expect((await call('POST', '/api/finance/expenses', obs, {})).status).toBe(403);
    expect((await call('POST', '/api/finance/accounts', obs, {})).status).toBe(403);
    expect(posted).toHaveLength(0);
  });

  it('apartman baglami olmayan token 403 alir', async () => {
    const { call } = setup();
    const res = await call('GET', '/api/finance/accounts', { userId: 'user-1', role: 'apartment_manager' });
    expect(res.status).toBe(403);
  });

  it('management_company rolu yazabilir', async () => {
    const { call } = setup();
    const res = await call('POST', '/api/finance/dues', claims('management_company'), duesBody);
    expect(res.status).toBe(201);
  });

  it('tekil tahakkuk -> tahsilat -> bakiye akisi ve PK/SK sizdirmaz', async () => {
    const { call, trialBalance } = setup();
    const d = await call('POST', '/api/finance/dues', manager, duesBody);
    expect(d.status).toBe(201);
    expect(d.json.mode).toBe('single');
    expect(d.json.transaction.PK).toBeUndefined();
    expect(d.json.transaction.SK).toBeUndefined();

    const p = await call('POST', '/api/finance/payments', manager, {
      idempotencyKey: 'pay-00001', unitId: 'u1', liableParty: 'owner', method: 'cash', amount: 2345,
    });
    expect(p.status).toBe(201);
    expect(p.json.payment.receiptNumber).toBe('MKB-000001');

    const b = await call('GET', '/api/finance/balance/u1', manager);
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ unitId: 'u1', balance: 10000, debt: 10000, credit: 0, currency: 'TRY' });
    expect(trialBalance()).toBe(0);
  });

  it('tekrarlanan istek 200 + replayed doner, ikinci kayit olusmaz', async () => {
    const { call, transactions } = setup();
    await call('POST', '/api/finance/dues', manager, duesBody);
    const again = await call('POST', '/api/finance/dues', manager, duesBody);
    expect(again.status).toBe(200);
    expect(again.json.replayed).toBe(true);
    expect(transactions.size).toBe(1);
  });

  it('toplu tahakkuk (unitId yok) dagitim sonucunu doner', async () => {
    const { call } = setup();
    const res = await call('POST', '/api/finance/dues', manager, {
      idempotencyKey: 'bulk-0001', liableParty: 'occupant', totalAmount: 10001, distributionKey: 'equal', ...dueBase,
    });
    expect(res.status).toBe(201);
    expect(res.json.mode).toBe('bulk');
    expect(res.json.distributedAmount).toBe(10001);
    expect(res.json.items.map((i: { amount: number }) => i.amount)).toEqual([5001, 5000]);
  });

  it('gecersiz tutar 400, gecersiz JSON 400', async () => {
    const { call, posted } = setup();
    for (const amount of [0, -5, 1.5, '10']) {
      const res = await call('POST', '/api/finance/dues', manager, { ...duesBody, amount });
      expect(res.status).toBe(400);
      expect(res.json.error).toBe('validation_error');
    }
    expect((await call('POST', '/api/finance/dues', manager, '{bozuk')).status).toBe(400);
    expect(posted).toHaveLength(0);
  });

  it('idempotency cakismasi 409, yetersiz bakiye 422, olmayan daire 404', async () => {
    const { call } = setup();
    await call('POST', '/api/finance/dues', manager, duesBody);
    expect((await call('POST', '/api/finance/dues', manager, { ...duesBody, amount: 1 })).json.error).toBe('idempotency_conflict');
    expect((await call('POST', '/api/finance/dues', manager, { ...duesBody, idempotencyKey: 'dues-0002', unitId: 'yok' })).status).toBe(404);

    await call('POST', '/api/finance/accounts', manager, { accountId: 'exp-1', type: 'expense', name: 'Temizlik' });
    const exp = await call('POST', '/api/finance/expenses', manager, {
      idempotencyKey: 'exp-00001', expenseAccountId: 'exp-1', amount: 100, description: 'x',
    });
    expect(exp.status).toBe(422);
    expect(exp.json.error).toBe('insufficient_funds');
  });

  it('gider ve ters kayit rotalari calisir', async () => {
    const { call, balanceOf } = setup();
    await call('POST', '/api/finance/accounts', manager, { accountId: 'exp-1', type: 'expense', name: 'Temizlik' });
    const exp = await call('POST', '/api/finance/expenses', manager, {
      idempotencyKey: 'exp-00001', expenseAccountId: 'exp-1', creditAccountId: 'payable', amount: 900, description: 'Temizlik',
    });
    expect(exp.status).toBe(201);
    expect(balanceOf('exp-1')).toBe(900);

    const rev = await call('POST', `/api/finance/transactions/${exp.json.transaction.transactionId}/reversal`, manager, {
      reason: 'Yanlis fatura',
    });
    expect(rev.status).toBe(201);
    expect(rev.json.transaction.kind).toBe('reversal');
    expect(balanceOf('exp-1')).toBe(0);
  });

  it('TENANT IZOLASYONU: apartmentId govde/URL ile degistirilemez, claim kullanilir', async () => {
    const t = setup([unit('u1'), unit('u1x', { siteId: OTHER_APT, PK: `APT#${OTHER_APT}`, SK: 'UNIT#u1x' })]);
    // Govdeye baska apartman yazmak etkisizdir; islem claim'deki apartmana yazilir.
    const res = await t.call('POST', '/api/finance/dues', manager, { ...duesBody, apartmentId: OTHER_APT, siteId: OTHER_APT });
    expect(res.status).toBe(201);
    expect(res.json.transaction.siteId).toBe(APT);
    expect([...t.transactions.keys()].every((key) => key.startsWith(`${APT}|`))).toBe(true);
    expect(t.balanceOf('recv-u1-owner', OTHER_APT)).toBe(0);

    // Diger apartmanin dairesi bu apartmanin yoneticisine gorunmez.
    expect((await t.call('GET', '/api/finance/balance/u1x', manager)).status).toBe(404);
    expect((await t.call('POST', '/api/finance/dues', manager, { ...duesBody, idempotencyKey: 'dues-0009', unitId: 'u1x' })).status).toBe(404);
  });

  it('TENANT IZOLASYONU: diger apartmanin yoneticisi hesaplari/islemleri goremez ve duzeltemez', async () => {
    const t = setup();
    const d = await t.call('POST', '/api/finance/dues', manager, duesBody);
    const other = claims('apartment_manager', OTHER_APT);

    const accounts = await t.call('GET', '/api/finance/accounts', other);
    expect(accounts.status).toBe(200);
    expect(accounts.json.items.every((a: { siteId: string }) => a.siteId === OTHER_APT)).toBe(true);
    expect(accounts.json.items.some((a: { accountId: string }) => a.accountId.startsWith('recv-'))).toBe(false);

    expect((await t.call('GET', '/api/finance/balance/u1', other)).status).toBe(404);
    const rev = await t.call('POST', `/api/finance/transactions/${d.json.transaction.transactionId}/reversal`, other, { reason: 'x' });
    expect(rev.status).toBe(404);
    expect(t.balanceOf('income-dues')).toBe(-12345);
  });

  it('bilinmeyen finans yolu 404 ve beklenmeyen hata 500 (ic detay sizmaz)', async () => {
    const t = setup();
    expect((await t.call('GET', '/api/finance/yok', manager)).status).toBe(404);
    t.failNext(new Error('db patladi: gizli'));
    const res = await t.call('POST', '/api/finance/dues', manager, duesBody);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain('gizli');
  });
});

// ---------------------------------------------------------------------------
// Raporlar: ozet, aidat durumu, hareketler
// ---------------------------------------------------------------------------

describe('computePartyDues (FIFO)', () => {
  it('odemeyi en eski vadeye sayar, kalan vadesi gecmis kismi gecikme olur', () => {
    const r = computePartyDues(
      [
        { amount: 1000, dueDate: '2026-11-15' },
        { amount: 1000, dueDate: '2026-10-15' },
      ],
      500,
      '2026-11-06',
    );
    expect(r).toMatchObject({ charged: 2000, paid: 500, balance: 1500, overdue: 500, oldestUnpaidDueDate: '2026-10-15' });
  });

  it('vade gunu henuz gecmemisse gecikme yok; fazla odeme avanstir', () => {
    expect(computePartyDues([{ amount: 1000, dueDate: '2026-11-06' }], 0, '2026-11-06').overdue).toBe(0);
    expect(computePartyDues([{ amount: 1000, dueDate: '2026-10-01' }], 1500, '2026-11-06')).toMatchObject({
      balance: -500,
      overdue: 0,
      oldestUnpaidDueDate: undefined,
    });
  });
});

describe('finans raporlari', () => {
  async function seeded() {
    const t = makeService();
    let i = 0;
    const key = () => `k${++i}`;
    const charge = (unitId: string, amount: number, dueDate: string) =>
      t.service.chargeUnit(ctx, { idempotencyKey: key(), unitId, liableParty: 'occupant', amount, date: '2026-10-01', dueDate, description: 'Aidat' });
    const pay = (unitId: string, amount: number, method: 'cash' | 'bank_transfer', paidAt: string) =>
      t.service.recordPayment(ctx, { idempotencyKey: key(), unitId, liableParty: 'occupant', amount, method, paidAt });

    await charge('u1', 100000, '2026-10-15');
    await charge('u1', 100000, '2026-11-15');
    await charge('u2', 100000, '2026-10-15');
    await pay('u1', 50000, 'cash', '2026-10-20');
    await pay('u2', 100000, 'bank_transfer', '2026-10-10');
    await pay('u3', 20000, 'cash', '2026-11-02'); // borcsuz odeme -> avans
    await t.service.recordExpense(ctx, {
      idempotencyKey: key(),
      expenseAccountId: 'exp-cleaning',
      amount: 30000,
      date: '2026-11-03',
      description: 'Merdiven temizligi',
    });
    return t;
  }

  it('aidat durumu: gecikme, odendi, avans ve son odeme tarihi', async () => {
    const t = await seeded();
    const { asOf, items } = await t.service.duesStatus(ctx);
    expect(asOf).toBe('2026-11-06');
    const byUnit = Object.fromEntries(items.map((d) => [d.unitId, d]));
    expect(byUnit.u1).toMatchObject({ status: 'overdue', balance: 150000, overdue: 50000, daysOverdue: 22, lastPaymentDate: '2026-10-20' });
    expect(byUnit.u2).toMatchObject({ status: 'paid', balance: 0, overdue: 0 });
    expect(byUnit.u3).toMatchObject({ status: 'advance', balance: -20000 });
  });

  it('ozet: kasa/banka bakiyeleri ve alacaklar', async () => {
    const t = await seeded();
    const s = await t.service.summary(ctx);
    expect(s).toMatchObject({
      cash: 40000, // 50000 + 20000 - 30000 gider
      bank: 100000,
      totalFunds: 140000,
      receivables: 150000,
      advances: 20000,
      overdue: 50000,
      overdueUnitCount: 1,
      pendingUnitCount: 0,
    });
    expect(s.fundsAccounts.map((a) => a.accountId)).toEqual(['bank', 'cash']);
  });

  it('hareketler: en yeni once, kategori ve kasa/banka yonu', async () => {
    const t = await seeded();
    const { items, nextCursor } = await t.service.listTransactions(ctx);
    expect(nextCursor).toBeUndefined();
    expect(items.map((i) => i.date)).toEqual([...items.map((i) => i.date)].sort().reverse());
    const expense = items.find((i) => i.kind === 'expense');
    expect(expense).toMatchObject({ category: 'expense', netFundsChange: -30000, funds: [{ accountId: 'cash', direction: 'out' }] });
    const payment = items.find((i) => i.kind === 'payment' && i.unitId === 'u2');
    expect(payment).toMatchObject({ category: 'income', netFundsChange: 100000, unitNumber: 'U2', funds: [{ accountType: 'bank' }] });
    expect(items.filter((i) => i.category === 'accrual')).toHaveLength(3);
  });

  it('hareketler: tarih filtresi, sayfalama ve gecersiz girdi', async () => {
    const t = await seeded();
    const nov = await t.service.listTransactions(ctx, { from: '2026-11-01', to: '2026-11-30' });
    expect(nov.items.map((i) => i.date).every((d) => d >= '2026-11-01')).toBe(true);
    const p1 = await t.service.listTransactions(ctx, { limit: '2' });
    expect(p1.items).toHaveLength(2);
    const p2 = await t.service.listTransactions(ctx, { limit: '2', cursor: p1.nextCursor });
    expect(p2.items[0]?.transactionId).not.toBe(p1.items[0]?.transactionId);
    await expect(t.service.listTransactions(ctx, { limit: '0' })).rejects.toBeInstanceOf(ValidationError);
    await expect(t.service.listTransactions(ctx, { from: '2026-12-01', to: '2026-11-01' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('ters kayit "reversal" olarak siniflanir; iptal edilen tahakkuk FIFO\'yu bozmaz', async () => {
    const t = await seeded();
    const charge = (await t.service.listTransactions(ctx)).items.find((i) => i.kind === 'dues_charge' && i.dueDate === '2026-11-15');
    await t.service.reverseTransaction(ctx, charge?.transactionId ?? '', { reason: 'Hatali tahakkuk' });
    const { items } = await t.service.listTransactions(ctx);
    expect(items.find((i) => i.kind === 'reversal')).toMatchObject({ category: 'reversal', reversalOf: charge?.transactionId });
    const u1 = (await t.service.duesStatus(ctx)).items.find((d) => d.unitId === 'u1');
    // Ekim borcunun 50000'i hala gecikmede: iptal "odeme" sayilip eski borca dusulmedi.
    expect(u1).toMatchObject({ balance: 50000, overdue: 50000, owner: { charged: 0 }, occupant: { charged: 100000, paid: 50000 } });
  });

  it('iptal edilen odeme odenmis sayilmaz', async () => {
    const t = await seeded();
    const pay = (await t.service.listTransactions(ctx)).items.find((i) => i.kind === 'payment' && i.unitId === 'u2');
    await t.service.reverseTransaction(ctx, pay?.transactionId ?? '', { reason: 'Karsiliksiz havale' });
    const u2 = (await t.service.duesStatus(ctx)).items.find((d) => d.unitId === 'u2');
    expect(u2).toMatchObject({ status: 'overdue', balance: 100000, overdue: 100000, lastPaymentDate: undefined });
    expect((await t.service.summary(ctx)).bank).toBe(0);
  });
});
