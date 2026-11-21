import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Site, type Unit, toKurus } from '../src/modules/core/types.js';
import {
  type AuditSnapshot,
  type AuditSource,
  checkClosures,
  checkOnlinePayments,
  checkReceipts,
  checkTransactions,
  createDynamoAuditSource,
  createLedgerAuditor,
} from '../src/modules/finance/audit.js';
import type { CariClosure } from '../src/modules/finance/closures.js';
import { toLedgerEntries } from '../src/modules/finance/repository.js';
import { type FinanceContext, createFinanceService } from '../src/modules/finance/service.js';
import type { Account, Transaction } from '../src/modules/finance/types.js';
import type { PaymentIntent } from '../src/modules/payments/types.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';

const APT = 'apt-1';
const TL = (n: number) => toKurus(Math.round(n * 100));

function unit(id: string): Unit {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    PK: `APT#${APT}`, SK: `UNIT#${id}`, entityType: 'UNIT', unitId: id, siteId: APT, blockId: 'b1', number: id.toUpperCase(),
    type: 'flat', grossAreaTenthsM2: 1000, exemptions: [], status: 'active', createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1,
  };
}

/**
 * Temiz defter: gercek finans servisiyle uretilir (tahakkuk, tahsilat, tazminat). Sonra
 * 10-05'te, 09-15 tarihli bir tahsilat daha girilir (kapama senaryosunda kilit ihlali olacak).
 */
async function golden(): Promise<AuditSnapshot> {
  const fake = createFakeFinanceRepo();
  const units = [unit('u1'), unit('u2')];
  const core = { getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id), listUnits: async () => units } as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  let now = new Date('2026-09-01T09:00:00.000Z');
  let n = 0;
  const finance = createFinanceService({ repository: fake.repo, core, now: () => now, newId: () => `id${++n}` });
  const ctx: FinanceContext = { apartmentId: APT, userId: 'mgr-1' };
  for (const u of ['u1', 'u2']) {
    await finance.chargeUnit(ctx, { idempotencyKey: `k-${u}`, unitId: u, liableParty: 'occupant', amount: TL(1000), date: '2026-09-01', dueDate: '2026-09-10', description: 'Eylül aidatı' });
  }
  await finance.recordPayment(ctx, { idempotencyKey: 'p1', unitId: 'u1', liableParty: 'occupant', amount: TL(400), method: 'cash', paidAt: '2026-09-05' });
  now = new Date('2026-10-01T09:00:00.000Z');
  await finance.postLateFees(APT, { period: '2026-09', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
  now = new Date('2026-10-05T09:00:00.000Z');
  await finance.recordPayment(ctx, { idempotencyKey: 'p2', unitId: 'u1', liableParty: 'occupant', amount: TL(100), method: 'cash', paidAt: '2026-09-15' });

  const transactions = [...fake.transactions.values()];
  return structuredClone({
    apartmentId: APT,
    intents: [],
    closures: [],
    transactions,
    entries: transactions.flatMap(toLedgerEntries),
    accounts: [...fake.accounts.values()],
    payments: [...fake.payments.values()],
    receiptCounter: fake.counters.get(`${APT}|receipt`) ?? 0,
  });
}

/** Anlik goruntu uzerinde calisan kaynak; tekil okumalar (yeniden dogrulama) ayri ayarlanabilir. */
function sourceOf(snap: AuditSnapshot, over: Partial<AuditSource> = {}): AuditSource {
  return {
    load: async () => structuredClone(snap),
    getAccount: async (_a, id) => structuredClone(snap.accounts.find((a) => a.accountId === id)),
    listAccountEntries: async (_a, id) => snap.entries.filter((e) => e.accountId === id),
    getTransaction: async (_a, id) => snap.transactions.find((t) => t.transactionId === id),
    listClosures: async () => snap.closures,
    ...over,
  };
}

const codes = (fs: { code: string }[]) => fs.map((f) => f.code).sort();
const acc = (s: AuditSnapshot, id: string) => s.accounts.find((a) => a.accountId === id) as Account;

describe('defter denetimi - temiz defter', () => {
  it('gercek servis ciktisinda bulgu yok', async () => {
    const snap = await golden();
    expect(snap.transactions.length).toBeGreaterThanOrEqual(5);
    const report = await createLedgerAuditor(sourceOf(snap)).run(APT);
    expect(report.findings).toEqual([]);
    expect(report.unstable).toEqual([]);
    expect(report.counts).toMatchObject({ transactions: snap.transactions.length, entries: snap.entries.length, payments: 2 });
  });
});

describe('defter denetimi - bakiye', () => {
  it('hesap bakiyesi LE# toplamindan sapmissa (yeniden okumada da) balance_mismatch', async () => {
    const snap = await golden();
    acc(snap, 'recv-u1-occupant').balance = toKurus(acc(snap, 'recv-u1-occupant').balance + 1);
    const report = await createLedgerAuditor(sourceOf(snap)).run(APT);
    expect(report.findings).toEqual([
      expect.objectContaining({ code: 'balance_mismatch', accountId: 'recv-u1-occupant', actual: acc(snap, 'recv-u1-occupant').balance }),
    ]);
  });

  it('es zamanli yazim: yeniden okumada tutuyorsa bulgu yok; surum degistiyse kararsiz (bulgu degil)', async () => {
    const snap = await golden();
    // Anlik goruntude hesap okunmadan once yeni bir kayit yazilmis gibi: bakiye geride.
    const stale = structuredClone(snap);
    acc(stale, 'recv-u2-occupant').balance = toKurus(acc(stale, 'recv-u2-occupant').balance - 5);
    const ok = await createLedgerAuditor(sourceOf(snap, { load: async () => structuredClone(stale) })).run(APT);
    expect(ok.findings).toEqual([]);

    let reads = 0;
    const moving = sourceOf(stale, {
      getAccount: async (_a, id) => ({ ...acc(stale, id), version: acc(stale, id).version + reads++ }),
    });
    const unstable = await createLedgerAuditor(moving).run(APT);
    expect(unstable.findings).toEqual([]);
    expect(unstable.unstable).toEqual(['recv-u2-occupant']);
  });

  it('hesabi olmayan LE# kaydi entry_account_missing', async () => {
    const snap = await golden();
    snap.accounts = snap.accounts.filter((a) => a.accountId !== 'recv-u2-occupant');
    const report = await createLedgerAuditor(sourceOf(snap)).run(APT);
    expect(codes(report.findings)).toEqual(['entry_account_missing']);
  });
});

describe('defter denetimi - islem butunlugu', () => {
  it('borc/alacak dengesizligi ve eksik LE# kaydi', async () => {
    const snap = await golden();
    const tx = snap.transactions[0] as Transaction;
    tx.lines[0]!.amount = toKurus(tx.lines[0]!.amount + 1);
    expect(codes(checkTransactions(snap))).toEqual(['tx_entries_mismatch', 'tx_unbalanced']);

    const clean = await golden();
    const victim = clean.transactions[1] as Transaction;
    clean.entries = clean.entries.filter((e) => !(e.transactionId === victim.transactionId && e.lineNo === 2));
    expect(checkTransactions(clean)).toEqual([expect.objectContaining({ code: 'tx_entries_mismatch', transactionId: victim.transactionId, expected: 2, actual: 1 })]);
  });

  it('islem basligi olmayan LE#: tekil okumada da yoksa entry_orphan; varsa (yeni yazim) bulgu yok', async () => {
    const snap = await golden();
    const ghost = snap.transactions.pop() as Transaction;
    const missing = await createLedgerAuditor(sourceOf(snap)).run(APT);
    expect(missing.findings).toEqual([{ code: 'entry_orphan', transactionId: ghost.transactionId }]);

    const late = await createLedgerAuditor(sourceOf(snap, { getTransaction: async () => ghost })).run(APT);
    expect(late.findings).toEqual([]);
  });
});

describe('defter denetimi - kapama kilidi', () => {
  const closure = (over: Partial<CariClosure> = {}): CariClosure =>
    ({
      PK: `APT#${APT}`, SK: 'CLOSURE#c1', entityType: 'CARI_CLOSURE', closureId: 'c1', apartmentId: APT, unitId: 'u1', party: 'occupant',
      moveOutDate: '2026-09-30', sourceAccountId: 'recv-u1-occupant', userIds: [], items: [], membershipChanges: [],
      transactionIds: {}, status: 'completed', reason: 'tasinma', createdAt: '2026-10-01T12:00:00.000Z', createdBy: 'mgr-1',
      updatedAt: '2026-10-01T12:00:00.000Z', updatedBy: 'mgr-1', version: 1, lateFee: toKurus(0), debt: toKurus(0), advance: toKurus(0),
      debtTo: 'former', advanceTo: 'keep',
      ...over,
    }) as unknown as CariClosure;

  it('kilitten sonra kilitli doneme yazilan kayit closed_period_write; kilitten onceki kayitlar ve kapama islemleri muaf', async () => {
    const snap = await golden();
    acc(snap, 'recv-u1-occupant').closedThrough = '2026-09-30';
    snap.closures = [closure()];
    const late = snap.transactions.find((t) => t.date === '2026-09-15') as Transaction;
    expect(checkClosures(snap)).toEqual([
      expect.objectContaining({ code: 'closed_period_write', accountId: 'recv-u1-occupant', transactionId: late.transactionId, closureId: 'c1', actual: '2026-09-15' }),
    ]);
    // Ayni islem kapamanin kendi islemiyse muaf.
    snap.closures = [closure({ transactionIds: { close: late.transactionId } })];
    expect(checkClosures(snap)).toEqual([]);
  });

  it('tamamlanmis kapamanin kilidi yoksa lock_missing; kilidi koyan kapama yoksa lock_orphan; geri alinmis kapama sayilmaz', () => {
    const accounts = [{ accountId: 'recv-u1-occupant', closedThrough: undefined }] as unknown as Account[];
    expect(codes(checkClosures({ accounts, closures: [closure()], entries: [] }))).toEqual(['closure_lock_missing']);
    expect(checkClosures({ accounts, closures: [closure({ status: 'reversed' })], entries: [] })).toEqual([]);
    const locked = [{ accountId: 'recv-u1-occupant', closedThrough: '2026-09-30' }] as unknown as Account[];
    expect(codes(checkClosures({ accounts: locked, closures: [], entries: [] }))).toEqual(['closure_lock_orphan']);
  });

  it('kilit bulgulari yeniden okumayla dogrulanir (araya giren kapama yanlis alarm uretmez)', async () => {
    const snap = await golden();
    snap.closures = [closure({ createdAt: '2026-10-06T00:00:00.000Z' })]; // kilit hesaba henuz yansimamis goruntu
    const fresh = structuredClone(snap);
    acc(fresh, 'recv-u1-occupant').closedThrough = '2026-09-30';
    const report = await createLedgerAuditor(sourceOf(snap, { getAccount: async (_a, id) => acc(fresh, id) })).run(APT);
    expect(report.findings).toEqual([]);

    const persistent = await createLedgerAuditor(sourceOf(snap)).run(APT);
    expect(codes(persistent.findings)).toEqual(['closure_lock_missing']);
  });
});

describe('defter denetimi - makbuz ve online odeme', () => {
  it('makbuz tekrari ve geride kalan sayac', async () => {
    const snap = await golden();
    expect(checkReceipts(snap)).toEqual([]);
    snap.payments[1]!.receiptNumber = snap.payments[0]!.receiptNumber;
    snap.receiptCounter = 0;
    expect(codes(checkReceipts(snap))).toEqual(['receipt_counter_behind', 'receipt_duplicate']);
  });

  async function online() {
    const snap = await golden();
    const p = snap.payments[0]!;
    p.intentId = 'pi1';
    const tx = snap.transactions.find((t) => t.transactionId === p.transactionId)!;
    tx.reference = 'IYZICO:pay-1';
    const intent = {
      intentId: 'pi1', entityType: 'PAYMENT_INTENT', apartmentId: APT, status: 'SUCCEEDED', provider: 'iyzico',
      providerPaymentId: 'pay-1', paymentIds: [p.paymentId], amount: p.amount,
    } as unknown as PaymentIntent;
    snap.intents = [intent];
    return { snap, intent, p, tx };
  }

  it('tamamlanmis online odeme defterde ve tutarli ise bulgu yok', async () => {
    const { snap } = await online();
    expect(checkOnlinePayments(snap)).toEqual([]);
  });

  it('eksik tahsilat, referans ve tutar uyusmazligi online_payment_unposted; tamamlanmamis niyet denetlenmez', async () => {
    const a = await online();
    a.snap.payments = a.snap.payments.filter((x) => x.paymentId !== a.p.paymentId);
    expect(checkOnlinePayments(a.snap)).toEqual([expect.objectContaining({ code: 'online_payment_unposted', intentId: 'pi1' })]);

    const b = await online();
    b.tx.reference = 'IYZICO:baska';
    expect(checkOnlinePayments(b.snap)).toEqual([expect.objectContaining({ detail: 'saglayici referansi uyusmuyor', actual: 'IYZICO:baska' })]);

    const c = await online();
    c.intent.amount = toKurus(c.intent.amount + 100);
    expect(checkOnlinePayments(c.snap)).toEqual([expect.objectContaining({ detail: 'tutar uyusmuyor' })]);

    const d = await online();
    d.intent.status = 'NEEDS_REVIEW';
    d.snap.payments = [];
    expect(checkOnlinePayments(d.snap)).toEqual([]);
  });

  it('komisyon (P1): ONLINE-FEE gideri niyetin islemlerinde ve tutari esit olmali', async () => {
    const withFee = async () => {
      const o = await online();
      const feeTx = { ...o.tx, transactionId: 'tx-fee', kind: 'expense', reference: 'ONLINE-FEE:pi1', totalAmount: toKurus(3_265) } as Transaction;
      o.snap.transactions.push(feeTx);
      Object.assign(o.intent, { transactionIds: [o.tx.transactionId, 'tx-fee'], settlement: { status: 'approved', commission: 3_265, subMerchantTotal: 0, approvals: [] } });
      return { ...o, feeTx };
    };
    const ok = await withFee();
    expect(checkOnlinePayments(ok.snap)).toEqual([]);

    const missing = await withFee();
    missing.intent.transactionIds = [missing.tx.transactionId];
    expect(checkOnlinePayments(missing.snap)).toEqual([expect.objectContaining({ code: 'online_payment_unposted', detail: 'komisyon gideri defterde yok', expected: 3_265 })]);

    const wrong = await withFee();
    wrong.feeTx.totalAmount = toKurus(3_000);
    expect(checkOnlinePayments(wrong.snap)).toEqual([
      expect.objectContaining({ detail: 'komisyon gideri tutari uyusmuyor', transactionId: 'tx-fee', expected: 3_265, actual: 3_000 }),
    ]);
  });
});

describe('defter denetimi - DynamoDB kaynagi', () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => {
    ddb.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-central-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  it('tutarli okumayla ve yanlis alarmi onleyen sirayla okur; salt okunur', async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(GetCommand).resolves({ Item: { value: 7 } });
    const snap = await createDynamoAuditSource().load(APT);
    const prefixes = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input.ExpressionAttributeValues?.[':skp']);
    expect(prefixes).toEqual(['PI#', 'CLOSURE#', 'TX#', 'LE#', 'ACCT#', 'PAY#']);
    expect(ddb.commandCalls(QueryCommand).every((c) => c.args[0].input.ConsistentRead === true)).toBe(true);
    expect(ddb.commandCalls(GetCommand)[0]!.args[0].input.Key).toEqual({ PK: 'APT#apt-1', SK: 'CTR#receipt' });
    expect(snap.receiptCounter).toBe(7);
    // Yazma komutu yok.
    expect(ddb.calls().every((c) => ['QueryCommand', 'GetCommand'].includes(c.args[0].constructor.name))).toBe(true);
  });
});

describe('zamanlayici - ledger_audit isi', () => {
  const site = (id: string, status: Site['status']) => ({ siteId: id, status, settings: {} }) as unknown as Site;

  it('pasif siteler dahil her apartmani denetler; sapma is hatasi degil, metrik + hata logu', async () => {
    const metrics = { emit: vi.fn() };
    const log = { info: vi.fn(), error: vi.fn() };
    const auditor = {
      run: vi.fn(async (apt: string) => ({
        apartmentId: apt,
        counts: { transactions: 1, entries: 2, accounts: 2, payments: 0, closures: 0, intents: 0 },
        findings: apt === 'apt-2' ? [{ code: 'balance_mismatch' as const, accountId: 'recv-u1-occupant', expected: 1, actual: 2 }] : [],
        unstable: [],
      })),
    };
    const sites = [site('apt-1', 'active'), site('apt-2', 'inactive')];
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => sites.map((s) => s.siteId), getSite: async (id: string) => sites.find((s) => s.siteId === id) },
      auditor, metrics, log, now: () => new Date('2026-11-21T00:40:00.000Z'),
      finance: {} as never, payments: null, events: { publish: vi.fn() }, outbox: {} as never,
      auditChain: {
        verify: vi.fn(async (scope: string) => ({
          scope,
          checked: 3,
          findings: scope === 'APT#apt-1' ? [{ code: 'audit_chain_hash_mismatch' as const, scope, seq: 2 }] : [],
        })),
      },
    });
    const res = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'ledger_audit', scheduledTime: '2026-11-21T00:40:00Z' }) }] });

    expect(res.batchItemFailures).toEqual([]);
    expect(auditor.run.mock.calls.map((c) => c[0])).toEqual(['apt-1', 'apt-2']);
    // apt-1: defter temiz ama denetim zincirinde kurcalama -> sapma; apt-2: defter sapmasi.
    expect(metrics.emit).toHaveBeenCalledWith({ LedgerDrift: 1, LedgerAuditUnstable: 0, AuditChainBroken: 1 }, expect.objectContaining({ apartmentId: 'apt-1' }));
    expect(metrics.emit).toHaveBeenCalledWith({ LedgerDrift: 1, LedgerAuditUnstable: 0, AuditChainBroken: 0 }, expect.objectContaining({ apartmentId: 'apt-2' }));
    // Platform zinciri tum apartmanlar turunda bir kez dogrulanir.
    expect(metrics.emit).toHaveBeenCalledWith({ LedgerDrift: 0, AuditChainBroken: 0 }, expect.objectContaining({ apartmentId: '_platform' }));
    // Kalp atisi: gece denetimi calisti (alarm: 1 gun veri yoksa).
    expect(metrics.emit).toHaveBeenCalledWith({ AuditRun: 1 }, { msg: 'ledger_audit_run' });
    const lines = log.error.mock.calls.map((c) => JSON.parse(c[0] as string)).filter((l) => l.msg === 'ledger_audit');
    expect(lines.find((l) => l.apartmentId === 'apt-2')).toMatchObject({ findings: [{ code: 'balance_mismatch' }] });
    expect(lines.find((l) => l.apartmentId === 'apt-1')).toMatchObject({ findings: [{ code: 'audit_chain_hash_mismatch', seq: 2 }], counts: { auditEntriesChecked: 3 } });
  });

  it('denetim okuma hatasi o apartman icin is hatasidir (SQS tekrar dener)', async () => {
    const worker = createSchedulerWorker({
      core: { listSiteIds: async () => ['apt-1'], getSite: async () => site('apt-1', 'active') },
      auditor: { run: async () => { throw new Error('throttled'); } },
      metrics: { emit: vi.fn() }, log: { info: vi.fn(), error: vi.fn() },
      finance: {} as never, payments: null, events: { publish: vi.fn() }, outbox: {} as never,
      auditChain: { verify: async (scope: string) => ({ scope, checked: 0, findings: [] }) },
    });
    const res = await worker({ Records: [{ messageId: 'm1', body: JSON.stringify({ job: 'ledger_audit', scheduledTime: '2026-11-21T00:40:00Z' }) }] });
    expect(res.batchItemFailures).toEqual([{ itemIdentifier: 'm1' }]);
  });
});
