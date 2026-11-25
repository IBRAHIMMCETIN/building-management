/**
 * Finans 2.4-1: hesap plani kodu, hazir gelir hesaplari, tahakkukta gelir hesabi secimi
 * (tekil / toplu / aylik plan / sayac) ve hesap bazli defter okuyucusu (LE# + BatchGet).
 */
import { DynamoDBDocumentClient, BatchGetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Unit, toKurus } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { batchGetTransactions, queryAccountEntries } from '../src/modules/finance/repository.js';
import { DEFAULT_INCOME_ACCOUNTS, FinanceError, type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { templatePresetsFor } from '../src/modules/meters/service.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const NOW = new Date('2026-11-25T09:00:00.000Z');
const APT = 'apt-1';
const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };

function unit(id: string): Unit {
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
  } as Unit;
}

function setup() {
  const fake = createFakeFinanceRepo(APT);
  const units = [unit('u1'), unit('u2')];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = {
    getUnit: async (_a, id) => units.find((u) => u.unitId === id),
    listUnits: async () => units,
  };
  let n = 0;
  const service = createFinanceService({ repository: fake.repo, core, now: () => NOW, newId: () => `id-${++n}` });
  const creditAccountOf = (t: Transaction) => t.lines.find((l) => l.side === 'credit')?.accountId;
  return { service, fake, creditAccountOf };
}

const dues = { liableParty: 'owner', amount: 100000, date: '2026-11-01', dueDate: '2026-11-15', description: 'Kasım demirbaş' };

describe('hesap plani: kod ve hazir gelir hesaplari', () => {
  it('ilk finans isleminde demirbas ve isinma gelir hesaplari acilir', async () => {
    const { service, fake } = setup();
    await service.chargeUnit(ctx, { idempotencyKey: 'dues-00000001', unitId: 'u1', ...dues });
    for (const { accountId, name } of DEFAULT_INCOME_ACCOUNTS) {
      expect(fake.accounts.get(`${APT}|${accountId}`)).toMatchObject({ type: 'income', name, status: 'active' });
    }
    expect(DEFAULT_INCOME_ACCOUNTS.map((a) => a.accountId)).toEqual(['income-fixtures', 'income-heating']);
  });

  it('kod: bicim dogrulanir, apartman icinde benzersizdir, guncellenir ve kaldirilir', async () => {
    const { service, fake } = setup();
    const a = await service.createAccount(ctx, { type: 'expense', name: 'Peyzaj', code: '770.10' });
    expect(a.code).toBe('770.10');
    await expect(service.createAccount(ctx, { type: 'expense', name: 'Havuz', code: '770.10' })).rejects.toBeInstanceOf(FinanceError);
    await expect(service.createAccount(ctx, { type: 'expense', name: 'Havuz', code: 'boşluk var' })).rejects.toBeInstanceOf(ValidationError);
    const b = await service.createAccount(ctx, { type: 'income', name: 'Otopark Gelirleri' });
    expect(b.code).toBeUndefined();
    // Kendi kodunu tekrar vermek cakisma sayilmaz; kod degisir ve kaldirilir.
    await service.updateAccount(ctx, a.accountId, { code: '770.10' });
    await service.updateAccount(ctx, a.accountId, { code: '770.11' });
    expect(fake.accounts.get(`${APT}|${a.accountId}`)?.code).toBe('770.11');
    await service.updateAccount(ctx, a.accountId, { code: null });
    expect(fake.accounts.get(`${APT}|${a.accountId}`)?.code).toBeUndefined();
  });
});

describe('tahakkukta gelir hesabi secimi', () => {
  it('tekil: secilen gelir hesabina alacak; varsayilan income-dues; parmak izi varsayilanda degismez', async () => {
    const { service, creditAccountOf } = setup();
    const r = await service.chargeUnit(ctx, { idempotencyKey: 'dues-00000002', unitId: 'u1', ...dues, incomeAccountId: 'income-fixtures' });
    expect(creditAccountOf(r.transaction)).toBe('income-fixtures');

    const plain = await service.chargeUnit(ctx, { idempotencyKey: 'dues-00000003', unitId: 'u1', ...dues });
    expect(creditAccountOf(plain.transaction)).toBe('income-dues');
    // Ayni istek acik varsayilanla tekrar gonderilirse ayni istektir (replay).
    const again = await service.chargeUnit(ctx, { idempotencyKey: 'dues-00000003', unitId: 'u1', ...dues, incomeAccountId: 'income-dues' });
    expect(again.replayed).toBe(true);
    // Ayni anahtar farkli gelir hesabiyla: farkli istek -> 409.
    await expect(service.chargeUnit(ctx, { idempotencyKey: 'dues-00000003', unitId: 'u1', ...dues, incomeAccountId: 'income-heating' })).rejects.toThrow();
  });

  it('gecersiz gelir hesaplari reddedilir: gider hesabi, gecikme tazminati, pasif, bilinmeyen', async () => {
    const { service } = setup();
    const inactive = await service.createAccount(ctx, { type: 'income', name: 'Eski gelir' });
    await service.updateAccount(ctx, inactive.accountId, { status: 'inactive' });
    for (const incomeAccountId of ['exp-cleaning', 'income-late-fee', inactive.accountId, 'yok-boyle-hesap']) {
      await expect(
        service.chargeUnit(ctx, { idempotencyKey: `dues-x-${incomeAccountId}`.slice(0, 40), unitId: 'u1', ...dues, incomeAccountId }),
        incomeAccountId,
      ).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it('toplu: onizleme gelir hesabini gosterir, tahakkuk her kalemde ona yazar', async () => {
    const { service, fake, creditAccountOf } = setup();
    const body = { liableParty: 'owner', totalAmount: 200000, distributionKey: 'equal', date: '2026-11-01', dueDate: '2026-11-15', description: 'Çatı onarımı', incomeAccountId: 'income-fixtures' };
    const preview = await service.previewBulk(ctx, body);
    expect(preview.incomeAccountId).toBe('income-fixtures');
    await service.chargeBulk(ctx, { idempotencyKey: 'bulk-00000001', ...body });
    const txs = [...fake.transactions.values()].filter((t) => t.kind === 'dues_charge');
    expect(txs).toHaveLength(2);
    expect(txs.every((t) => creditAccountOf(t) === 'income-fixtures')).toBe(true);
  });

  it('aylik plan ve sayac kalemi secilen gelir hesabina yazar', async () => {
    const { service, fake, creditAccountOf } = setup();
    await service.autoChargeDues(APT, {
      period: '2026-12',
      plan: { enabled: true, totalAmount: toKurus(100000), distributionKey: 'equal', liableParty: 'occupant', incomeAccountId: 'income-fixtures' },
      dueDayOfMonth: 15,
    });
    const monthly = [...fake.transactions.values()].filter((t) => t.date === '2026-12-01');
    expect(monthly.length).toBeGreaterThan(0);
    expect(monthly.every((t) => creditAccountOf(t) === 'income-fixtures')).toBe(true);

    const r = await service.chargeMeterLine(ctx, {
      idemId: 'MDP_p1_u1',
      unitId: 'u1',
      party: 'occupant',
      vacant: false,
      amount: 45000,
      date: '2026-11-30',
      dueDate: '2026-12-15',
      description: 'Kasım ısınma',
      batchId: 'mb-1',
      reference: 'METER_PERIOD:p1',
      incomeAccountId: 'income-heating',
    });
    expect(creditAccountOf(fake.transactions.get(`${APT}|${r.transactionId}`)!)).toBe('income-heating');
  });

  it('hazir sayac sablonlari: isinma ve sicak su income-heating, soguk su varsayilan', () => {
    const presets = templatePresetsFor(undefined);
    expect(Object.fromEntries(presets.map((p) => [p.preset, p.incomeAccountId]))).toEqual({
      central_heating: 'income-heating',
      hot_water: 'income-heating',
      cold_water: undefined,
    });
  });
});

describe('hesap bazli defter okuyucusu (LE#)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('tarih araligi SK uzerinde daraltilir, sayfalanir, baska hesap/tenant elenir', async () => {
    const e = (accountId: string, tx: string, siteId = APT) => ({ PK: `APT#${APT}`, SK: `LE#${accountId}#${tx}#0`, accountId, siteId, transactionId: tx });
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [e('cash', '20261101-a')], LastEvaluatedKey: { PK: 'x' } })
      .resolvesOnce({ Items: [e('cash', '20261130-b'), e('cash-2', '20261130-c'), e('cash', '20261130-d', 'apt-2')] });
    const items = await queryAccountEntries(APT, 'cash', { from: '2026-11-01', to: '2026-11-30' });
    expect(items.map((i) => i.transactionId)).toEqual(['20261101-a', '20261130-b']);
    const calls = ddb.commandCalls(QueryCommand);
    expect(calls[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':pk': `APT#${APT}`, ':lo': 'LE#cash#20261101', ':hi': 'LE#cash#20261130~' });
    expect(calls[0]!.args[0].input.ConsistentRead).toBe(true);
    expect(calls[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'x' });

    ddb.reset();
    ddb.on(QueryCommand).resolves({ Items: [] });
    await queryAccountEntries(APT, 'recv-u1-owner');
    expect(ddb.commandCalls(QueryCommand)[0]!.args[0].input.ExpressionAttributeValues).toMatchObject({ ':lo': 'LE#recv-u1-owner#00000000', ':hi': 'LE#recv-u1-owner#99999999~' });
  });

  it('BatchGet: tekrarlar tekillesir, islenmeyen anahtarlar yeniden denenir, baska tenant elenir', async () => {
    ddb
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { 'bm-test-table': [{ transactionId: 't1', siteId: APT }, { transactionId: 'tx', siteId: 'apt-2' }] },
        UnprocessedKeys: { 'bm-test-table': { Keys: [{ PK: `APT#${APT}`, SK: 'TX#t2' }] } },
      })
      .resolvesOnce({ Responses: { 'bm-test-table': [{ transactionId: 't2', siteId: APT }] } });
    const out = await batchGetTransactions(APT, ['t1', 't2', 't1']);
    expect(out.map((t) => t.transactionId)).toEqual(['t1', 't2']);
    const first = ddb.commandCalls(BatchGetCommand)[0]!.args[0].input.RequestItems!['bm-test-table']!;
    expect(first.Keys).toHaveLength(2);
    expect(first.ConsistentRead).toBe(true);
  });
});
