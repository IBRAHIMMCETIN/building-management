/**
 * Finans 2.4-2: mali donem kilidi (postBatch), aylik anlik goruntu, kontrol listesi, iki fazli
 * kapanis (yarida kalan kapanisin devami, dogrulama hatasinda kilidin geri alinmasi) ve son
 * kapanan ayin gerekceli yeniden acilmasi.
 */
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AuthClaims } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Unit, toKurus } from '../src/modules/core/types.js';
import { ValidationError } from '../src/modules/core/validation.js';
import { ClosingBlockedError, PeriodClosedError, PeriodError, buildSnapshot } from '../src/modules/finance/periodLock.js';
import { type PeriodCheckSources, createPeriodService } from '../src/modules/finance/periods.js';
import { createFinanceRepository, financeKeys } from '../src/modules/finance/repository.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Transaction } from '../src/modules/finance/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakeFiscalRepo } from './fakes/fiscalRepo.js';

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
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'seed',
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'seed',
    version: 1,
  } as Unit;
}

function world(nowIso = '2026-11-25T09:00:00.000Z') {
  let now = new Date(nowIso);
  const fake = createFakeFinanceRepo(APT);
  const fiscal = createFakeFiscalRepo(fake.docs);
  const units = [unit('u1'), unit('u2')];
  const core: Pick<CoreRepository, 'getUnit' | 'listUnits'> = { getUnit: async (_a, id) => units.find((u) => u.unitId === id), listUnits: async () => units };
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${String(++n).padStart(4, '0')}` });
  const src = {
    meter: [] as { periodId: string; name: string; status: string; endDate: string }[],
    review: 0,
    bank: 0,
    offsets: 0,
    feeBps: 0,
    onBank: undefined as undefined | (() => void),
  };
  const sources: PeriodCheckSources = {
    meterPeriods: async () => src.meter,
    reviewPayments: async () => src.review,
    unmatchedBankLines: async () => {
      src.onBank?.();
      return src.bank;
    },
    pendingOffsetRequests: async () => src.offsets,
    lateFeeSettings: async () => ({ monthlyBasisPoints: src.feeBps }),
  };
  const periods = createPeriodService({ finance: fake.repo, fiscal: fiscal.repo, sources, now: () => now });
  let k = 0;
  const charge = (unitId: string, date: string, amount: number, dueDate = date) =>
    finance.chargeUnit(ctx, { idempotencyKey: `dues-key-${++k}`, unitId, liableParty: 'owner', amount, date, dueDate, description: `Aidat ${date}` });
  const pay = (unitId: string, paidAt: string, amount: number) =>
    finance.recordPayment(ctx, { idempotencyKey: `pay-key-${++k}`, unitId, liableParty: 'owner', amount, method: 'cash', paidAt });
  const lockVersion = async () => (await fiscal.repo.getLock(APT))?.version ?? 0;
  const closeP = async (period: string, ack: string[] = []) => periods.close(ctx, period, { expectedLockVersion: await lockVersion(), acknowledgeWarnings: ack });
  return { fake, fiscal, finance, periods, src, charge, pay, closeP, lockVersion, setNow: (iso: string) => (now = new Date(iso)) };
}

describe('anlik goruntu (saf)', () => {
  it('acilis + donem hareketleri = kapanis; borc = alacak; kapanislarin toplami sifir; ozet deterministik', () => {
    const t = (date: string, lines: [string, 'debit' | 'credit', number][]): Transaction =>
      ({ transactionId: `${date.replaceAll('-', '')}-x`, date, lines: lines.map(([accountId, side, amount]) => ({ accountId, side, amount: toKurus(amount) })) }) as Transaction;
    const accounts = [
      { accountId: 'cash', type: 'cash', name: 'Kasa', status: 'active', balance: 0 },
      { accountId: 'recv', type: 'receivable', name: 'Daire 1', status: 'active', balance: 0 },
      { accountId: 'inc', type: 'income', name: 'Aidat', status: 'active', balance: 0 },
      { accountId: 'old', type: 'expense', name: 'Eski', status: 'inactive', balance: 0 },
    ] as never[];
    const s = buildSnapshot({
      accounts,
      opening: new Map([['recv', 100000], ['inc', -100000]]),
      periodTransactions: [t('2026-10-01', [['recv', 'debit', 100000], ['inc', 'credit', 100000]]), t('2026-10-05', [['cash', 'debit', 60000], ['recv', 'credit', 60000]])],
    });
    expect(s.rows.map((r) => [r.accountId, r.opening, r.debit, r.credit, r.closing])).toEqual([
      ['cash', 0, 60000, 0, 60000],
      ['recv', 100000, 100000, 60000, 140000],
      ['inc', -100000, 0, 100000, -200000],
    ]);
    expect(s.totals).toMatchObject({ debit: 160000, credit: 160000, opening: 0, closing: 0, transactions: 2 });
    expect(buildSnapshot({ accounts, opening: new Map([['recv', 100000], ['inc', -100000]]), periodTransactions: [] }).hash).not.toBe(s.hash);
    expect(s.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('kapanis akisi', () => {
  it('ilk kapanis herhangi bir tamamlanmis ay; sonrakiler sirali; goruntu onceki kapanistan devam eder', async () => {
    const w = world();
    await w.charge('u1', '2026-09-01', 100000);
    await w.charge('u1', '2026-10-01', 100000);
    await w.charge('u2', '2026-10-01', 100000);
    await w.pay('u1', '2026-10-05', 60000);

    // Bulunulan ay kapatilamaz.
    await expect(w.closeP('2026-11')).rejects.toBeInstanceOf(PeriodError);
    const sept = await w.closeP('2026-09');
    expect(sept.period.snapshot.totals).toMatchObject({ debit: 100000, credit: 100000, closing: 0, transactions: 1 });
    expect(sept.lock).toMatchObject({ lockedThrough: '2026-09-30', lastClosedPeriod: '2026-09' });
    // Sira: Eylul'den sonra Kasim degil Ekim.
    await expect(w.periods.close(ctx, '2026-08', { expectedLockVersion: await w.lockVersion() })).rejects.toThrow(/sıradaki dönem Ekim 2026/);

    const oct = await w.closeP('2026-10');
    const row = (id: string) => oct.period.snapshot.rows.find((r) => r.accountId === id);
    expect(row('recv-u1-owner')).toMatchObject({ opening: 100000, debit: 100000, credit: 60000, closing: 140000 });
    expect(row('recv-u2-owner')).toMatchObject({ opening: 0, debit: 100000, credit: 0, closing: 100000 });
    expect(row('income-dues')).toMatchObject({ opening: -100000, credit: 200000, closing: -300000 });
    expect(row('cash')).toMatchObject({ debit: 60000, closing: 60000 });
    expect(oct.period).toMatchObject({ status: 'closed', revision: 1, periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    expect(w.fiscal.audits.map((a) => a.action)).toEqual(['finance.period_close', 'finance.period_close']);

    const status = await w.periods.status(ctx);
    expect(status).toMatchObject({ lockedThrough: '2026-10-31', lastClosedPeriod: '2026-10', firstClose: false });
    expect(status.nextClosable).toBeUndefined(); // Kasim henuz bitmedi
    expect(status.periods.map((p) => p.period)).toEqual(['2026-09', '2026-10']);
  });

  it('kilit: kapali doneme tarihli her yazim reddedilir (409 period_closed); acik doneme yazim serbest', async () => {
    const w = world();
    await w.charge('u1', '2026-10-01', 100000);
    await w.closeP('2026-10');
    await expect(w.charge('u1', '2026-10-15', 5000)).rejects.toBeInstanceOf(PeriodClosedError);
    await expect(w.pay('u1', '2026-10-31', 5000)).rejects.toThrow(/Ekim 2026 dönemi kapalı/);
    await expect(w.charge('u1', '2026-11-01', 5000)).resolves.toBeTruthy();
  });

  it('engeller kapanisi durdurur ve kilit konmaz; uyarilar kod listesiyle onaylanir', async () => {
    const w = world();
    await w.charge('u1', '2026-10-01', 100000);
    w.src.meter = [{ periodId: 'p1', name: 'Ekim ısınma', status: 'posting', endDate: '2026-10-31' }];
    w.src.review = 1;
    const blocked = await w.closeP('2026-10').catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ClosingBlockedError);
    expect((blocked as ClosingBlockedError).blockers.map((b) => b.code)).toEqual(['meter_posting', 'payment_review']);
    expect(await w.lockVersion()).toBe(0);

    w.src.meter = [{ periodId: 'p2', name: 'Ekim su', status: 'draft', endDate: '2026-10-31' }];
    w.src.review = 0;
    w.src.bank = 3;
    w.src.offsets = 1;
    const check = await w.periods.checklist(ctx, '2026-10');
    expect(check.canClose).toBe(true);
    expect(check.warnings.map((x) => x.code)).toEqual(['bank_unmatched', 'offset_requests_pending', 'meter_draft']);
    const needsAck = await w.closeP('2026-10', ['bank_unmatched']).catch((e: unknown) => e);
    expect((needsAck as ClosingBlockedError).warnings.map((x) => x.code)).toEqual(['offset_requests_pending', 'meter_draft']);
    await expect(w.closeP('2026-10', ['yok'])).rejects.toBeInstanceOf(ValidationError);
    const ok = await w.closeP('2026-10', ['bank_unmatched', 'offset_requests_pending', 'meter_draft']);
    expect(ok.period.acknowledgedWarnings.map((x) => x.code)).toEqual(['bank_unmatched', 'offset_requests_pending', 'meter_draft']);
  });

  it('kesinlesmemis gecikme tazminati uyarisi (onceki ayin tazminati)', async () => {
    const w = world();
    w.src.feeBps = 500;
    await w.charge('u1', '2026-08-01', 100000, '2026-08-10');
    const check = await w.periods.checklist(ctx, '2026-09');
    const fee = check.warnings.find((x) => x.code === 'late_fee_pending');
    expect(fee?.amount).toBeGreaterThan(0);
    expect(fee?.message).toContain('Ağustos 2026');
  });

  it('defter-bakiye uyusmazligi: on kontrolde yakalanir; kilit altinda ortaya cikarsa kilit geri alinir', async () => {
    const w = world();
    await w.charge('u1', '2026-10-01', 100000);
    const acc = w.fake.accounts.get(`${APT}|recv-u1-owner`)!;
    w.fake.accounts.set(`${APT}|recv-u1-owner`, { ...acc, balance: toKurus(99999) });
    const pre = await w.closeP('2026-10').catch((e: unknown) => e);
    expect((pre as ClosingBlockedError).blockers.map((b) => b.code)).toContain('balance_mismatch');
    expect(await w.lockVersion()).toBe(0);

    // On kontrol temiz, faz 2'de bozulma: kilit konur, sonra geri alinir.
    w.fake.accounts.set(`${APT}|recv-u1-owner`, acc);
    w.src.onBank = () => w.fake.accounts.set(`${APT}|recv-u1-owner`, { ...acc, balance: toKurus(1) });
    const late = await w.closeP('2026-10').catch((e: unknown) => e);
    expect(late).toBeInstanceOf(ClosingBlockedError);
    const lock = await w.fiscal.repo.getLock(APT);
    expect(lock).toMatchObject({ version: 2 });
    expect(lock?.lockedThrough).toBeUndefined();
    expect(lock?.closing).toBeUndefined();
    expect(await w.fiscal.repo.getPeriod(APT, '2026-10')).toBeUndefined();
  });

  it('yarida kalan kapanis ayni ayla devam eder; baska ay kapatilamaz; surum uyusmazligi 409', async () => {
    const w = world();
    await w.charge('u1', '2026-09-01', 100000);
    const write = w.fiscal.repo.write;
    let calls = 0;
    w.fiscal.repo.write = async (apt, x) => {
      if (++calls === 2) throw new Error('baglanti koptu');
      return write(apt, x);
    };
    await expect(w.closeP('2026-09')).rejects.toThrow('baglanti koptu');
    expect(await w.fiscal.repo.getLock(APT)).toMatchObject({ lockedThrough: '2026-09-30', closing: { period: '2026-09' } });
    // Kilit altinda yazim yok.
    await expect(w.charge('u1', '2026-09-20', 1000)).rejects.toBeInstanceOf(PeriodClosedError);
    await expect(w.closeP('2026-10')).rejects.toThrow(/Eylül 2026 kapanışı yarıda kaldı/);
    await expect(w.periods.close(ctx, '2026-09', { expectedLockVersion: 0 })).rejects.toBeInstanceOf(PeriodError);
    const done = await w.closeP('2026-09');
    expect(done.lock).toMatchObject({ lastClosedPeriod: '2026-09', lockedThrough: '2026-09-30' });
    expect((await w.fiscal.repo.getLock(APT))?.closing).toBeUndefined();
  });

  it('yeniden acma: yalnizca son kapanan ay, gerekce zorunlu; kilit geri cekilir, tekrar kapanista revizyon artar', async () => {
    const w = world();
    await w.charge('u1', '2026-09-01', 100000);
    await w.closeP('2026-09');
    await w.closeP('2026-10');
    await expect(w.periods.reopen(ctx, '2026-09', { reason: 'Banka dekontu eksik girilmiş' })).rejects.toThrow(/son kapanan dönem \(Ekim 2026\)/);
    await expect(w.periods.reopen(ctx, '2026-10', { reason: 'kısa' })).rejects.toBeInstanceOf(ValidationError);
    const r = await w.periods.reopen(ctx, '2026-10', { reason: 'Banka dekontu eksik girilmiş' });
    expect(r.lock).toMatchObject({ lockedThrough: '2026-09-30', lastClosedPeriod: '2026-09' });
    expect(r.period).toMatchObject({ status: 'reopened', reopenHistory: [{ by: 'mgr-1', reason: 'Banka dekontu eksik girilmiş', revision: 1 }] });
    expect(w.fiscal.audits.at(-1)).toMatchObject({ action: 'finance.period_reopen', reason: 'Banka dekontu eksik girilmiş' });

    await w.pay('u1', '2026-10-20', 25000);
    const again = await w.closeP('2026-10');
    expect(again.period).toMatchObject({ status: 'closed', revision: 2 });
    expect(again.period.snapshot.rows.find((x) => x.accountId === 'cash')?.debit).toBe(25000);
  });
});

describe('API uclari', () => {
  it('denetci okur, yazamaz; kapali doneme tahakkuk 409 period_closed', async () => {
    const w = world();
    await w.charge('u1', '2026-10-01', 100000);
    const app = createApp({
      version: 'test',
      financeService: w.finance,
      periodService: w.periods,
      authenticate: (c) => {
        const raw = c.req.header('x-test-claims');
        return raw ? (JSON.parse(raw) as AuthClaims) : null;
      },
    });
    const as = (role: string) => JSON.stringify({ userId: 'u-x', role, apartmentId: APT });
    const call = async (method: string, path: string, role: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: { 'x-test-claims': as(role), ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Record<string, any> };
    };
    expect((await call('GET', '/api/finance/periods', 'observer')).status).toBe(200);
    expect((await call('GET', '/api/finance/periods/2026-10/checklist', 'observer')).json).toMatchObject({ canClose: true, blockers: [] });
    expect((await call('POST', '/api/finance/periods/2026-10/close', 'observer', { expectedLockVersion: 0 })).status).toBe(403);
    expect((await call('GET', '/api/finance/periods/2026-10', 'observer')).status).toBe(404);

    w.src.bank = 2;
    const blocked = await call('POST', '/api/finance/periods/2026-10/close', 'apartment_manager', { expectedLockVersion: 0 });
    expect(blocked).toMatchObject({ status: 422, json: { error: 'closing_blocked', warnings: [{ code: 'bank_unmatched' }] } });
    const ok = await call('POST', '/api/finance/periods/2026-10/close', 'apartment_manager', { expectedLockVersion: 0, acknowledgeWarnings: ['bank_unmatched'] });
    expect(ok.status).toBe(200);
    const dues = await call('POST', '/api/finance/dues', 'apartment_manager', {
      idempotencyKey: 'dues-closed-1',
      unitId: 'u1',
      liableParty: 'owner',
      amount: 1000,
      date: '2026-10-20',
      dueDate: '2026-10-30',
      description: 'Geç giriş',
    });
    expect(dues).toMatchObject({ status: 409, json: { error: 'period_closed', lockedThrough: '2026-10-31' } });
    expect((await call('POST', '/api/finance/periods/2026-10/reopen', 'management_company', { reason: 'Geç gelen faturalar işlenecek' })).status).toBe(200);
  });
});

describe('postBatch: kilit kontrolu (DynamoDB)', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const tx = (date: string): Transaction => ({
    ...financeKeys.transaction(APT, `${date.replaceAll('-', '')}-t1`),
    entityType: 'TRANSACTION',
    transactionId: `${date.replaceAll('-', '')}-t1`,
    siteId: APT,
    kind: 'dues_charge',
    date,
    description: 'x',
    lines: [
      { accountId: 'recv-u1-owner', side: 'debit', amount: toKurus(100) },
      { accountId: 'income-dues', side: 'credit', amount: toKurus(100) },
    ],
    totalAmount: toKurus(100),
    createdAt: '2026-11-25T00:00:00.000Z',
    createdBy: 'u',
  });

  it('en erken islem tarihiyle FINLOCK ConditionCheck eklenir; kosul hatasi PeriodClosedError olur', async () => {
    const repo = createFinanceRepository();
    ddb.on(TransactWriteCommand).resolvesOnce({});
    await repo.postBatch({ transactions: [tx('2026-11-03'), { ...tx('2026-11-01'), transactionId: '20261101-t2', SK: 'TX#20261101-t2' }], idempotency: { id: 'k1', fingerprint: 'f' } });
    const items = ddb.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    const check = items.find((i) => i.ConditionCheck)?.ConditionCheck;
    expect(check).toMatchObject({ Key: { PK: `APT#${APT}`, SK: 'FINLOCK' }, ExpressionAttributeValues: { ':earliest': '2026-11-01' }, ReturnValuesOnConditionCheckFailure: 'ALL_OLD' });

    // Iptal nedenleri gercek istekteki oge sirasindan uretilir (yalnizca kilit kontrolu basarisiz).
    ddb.on(TransactWriteCommand).callsFake((input: { TransactItems: { ConditionCheck?: unknown }[] }) => {
      throw new TransactionCanceledException({
        message: 'iptal',
        $metadata: {},
        CancellationReasons: input.TransactItems.map((i) => (i.ConditionCheck ? { Code: 'ConditionalCheckFailed', Item: { lockedThrough: { S: '2026-10-31' } } } : { Code: 'None' })),
      });
    });
    const err = await repo.postBatch({ transactions: [tx('2026-10-31')], idempotency: { id: 'k2', fingerprint: 'f' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodClosedError);
    expect((err as PeriodClosedError).lockedThrough).toBe('2026-10-31');
  });
});
