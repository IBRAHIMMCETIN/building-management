import { SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import type { Site } from '../src/modules/core/types.js';
import { toKurus } from '../src/modules/core/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import {
  boundaryBalances,
  boundaryBalancesFromAll,
  computePayableSummaryFull,
  loadPayableSummary,
  type PayableSummaryItem,
  type PayableSummaryStore,
} from '../src/modules/finance/boundedReads.js';
import { financeKeys, postBatch, toLedgerEntries } from '../src/modules/finance/repository.js';
import type { LedgerEntry, Payment, Transaction } from '../src/modules/finance/types.js';
import {
  type UnitPaymentIndexState,
  type UnitPaymentStore,
  createUnitPaymentReader,
  expectedPaymentIndex,
  hasExpectedIndex,
  reconcileUnitPayments,
  stripIndex,
  unitPaymentKeys,
  withPaymentIndex,
} from '../src/modules/finance/unitPayments.js';
import { createMemoryJobFanout, createSqsJobFanout, JobFanoutError } from '../src/workers/jobFanout.js';
import { createSchedulerWorker } from '../src/workers/scheduler-worker.js';
import { backfillUnitPayments } from '../scripts/backfill-unit-payments.js';

const APT = 'apt-scale';
const NOW = new Date('2026-11-28T00:30:00.000Z');

/** Deterministik sozde rastgele (tekrar uretilebilir testler). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const dayOf = (r: () => number, years = 3) => {
  const y = 2024 + Math.floor(r() * years);
  return `${y}-${pad(1 + Math.floor(r() * 12))}-${pad(1 + Math.floor(r() * 28))}`;
};

// ---------------------------------------------------------------------------
// 2-1: daire makbuz dizini
// ---------------------------------------------------------------------------

function payment(i: number, unitId: string, paidAt: string, amount: number, siteId = APT): Payment {
  const paymentId = `pay-${pad(i, 6)}`;
  return {
    ...financeKeys.payment(siteId, paymentId),
    entityType: 'PAYMENT',
    paymentId,
    siteId,
    unitId,
    liableParty: i % 3 === 0 ? 'owner' : 'occupant',
    method: 'bank_transfer',
    amount: toKurus(amount),
    depositAccountId: 'bank',
    receiptNumber: `MKB-${pad(i, 6)}`,
    transactionId: `${paidAt.replaceAll('-', '')}-tx-${i}`,
    paidAt,
    createdAt: `${paidAt}T09:00:00.000Z`,
    createdBy: 'seed',
  };
}

/** Bellekte tablo + GSI1 benzetimi. */
function memoryStore(initial: (Payment & { GSI1PK?: string; GSI1SK?: string })[]) {
  const items = new Map(initial.map((p) => [p.SK, { ...p }]));
  let state: UnitPaymentIndexState | undefined;
  const calls = { all: 0, gsi: 0, writes: 0 };
  const store: UnitPaymentStore = {
    getState: async () => state,
    markReady: async (apartmentId, source) => {
      state = { ...unitPaymentKeys.state(apartmentId), entityType: 'UNIT_PAYMENT_INDEX_STATE', siteId: apartmentId, ready: true, source, readyAt: NOW.toISOString() };
      return true;
    },
    listAllPayments: async () => {
      calls.all++;
      return [...items.values()].map((p) => ({ ...p }));
    },
    queryUnitPayments: async (apartmentId, unitId) => {
      calls.gsi++;
      const pk = unitPaymentKeys.index(apartmentId, unitId, '', '').GSI1PK;
      return [...items.values()]
        .filter((p) => p.GSI1PK === pk)
        .sort((a, b) => (a.GSI1SK ?? '').localeCompare(b.GSI1SK ?? ''))
        .map((p) => stripIndex(p) as Payment);
    },
    setPaymentIndex: async (p) => {
      const cur = items.get(p.SK);
      const idx = expectedPaymentIndex(p);
      if (!cur || (cur.GSI1PK && cur.GSI1PK !== idx.GSI1PK)) return 'skipped';
      calls.writes++;
      items.set(p.SK, { ...cur, ...idx });
      return 'written';
    },
  };
  return { store, items, calls, setState: (s: UnitPaymentIndexState | undefined) => (state = s) };
}

/** 400 daire x yillara yayilmis makbuzlar (Diyarbakir hedef olcegi). */
function scalePayments(units = 400, perUnit = 6) {
  const r = rng(42);
  const list: Payment[] = [];
  let i = 0;
  for (let u = 1; u <= units; u++) {
    for (let k = 0; k < perUnit; k++) list.push(payment(++i, `u${pad(u, 3)}`, dayOf(r), 10_000 + Math.floor(r() * 400_000)));
  }
  return list;
}

const fp = (list: Payment[]) =>
  list
    .map((p) => `${p.paymentId}|${p.amount}|${p.paidAt}|${p.liableParty}|${p.receiptNumber}`)
    .sort()
    .join('\n');

describe('Adim 2-1: daire makbuz dizini', () => {
  it('yalnizca PAYMENT kayitlari dizin anahtari alir; nesne kopyalanir', () => {
    const p = payment(1, 'u001', '2026-03-05', 150050);
    const indexed = withPaymentIndex(p);
    expect(indexed).toMatchObject({ GSI1PK: `UPAY#${APT}#u001`, GSI1SK: '2026-03-05#pay-000001' });
    expect(p).not.toHaveProperty('GSI1PK');
    const expense = { ...financeKeys.expense(APT, 'e1'), entityType: 'EXPENSE' };
    expect(withPaymentIndex(expense)).toBe(expense);
    expect(hasExpectedIndex(indexed as Payment & { GSI1PK: string; GSI1SK: string })).toBe(true);
  });

  it('dizin yolu eski tam taramayla her dairede kurus kurus ayni (400 daire, 2.400 makbuz)', async () => {
    const all = scalePayments();
    const m = memoryStore(all.map((p) => withPaymentIndex(p)));
    const legacy = createUnitPaymentReader({ ...m.store, getState: async () => undefined });
    m.setState({ ...unitPaymentKeys.state(APT), entityType: 'UNIT_PAYMENT_INDEX_STATE', siteId: APT, ready: true, source: 'backfill', readyAt: '' });
    const indexed = createUnitPaymentReader(m.store);
    for (let u = 1; u <= 400; u++) {
      const unitId = `u${pad(u, 3)}`;
      const a = await legacy.list(APT, unitId);
      const b = await indexed.list(APT, unitId);
      expect(b.length).toBe(6);
      expect(fp(b)).toBe(fp(a));
      expect(b.reduce((s, p) => s + p.amount, 0)).toBe(a.reduce((s, p) => s + p.amount, 0));
      expect(b.every((p) => !('GSI1PK' in p))).toBe(true);
    }
    // Hazir sitede her daire tek dizin sorgusu; tum makbuzlar yalnizca eski okuyucuda okundu.
    expect(m.calls.gsi).toBe(400);
  });

  it('hazir olmayan sitede ve consistent istekte eski yol', async () => {
    const all = scalePayments(5, 2);
    const m = memoryStore(all);
    const reader = createUnitPaymentReader(m.store);
    expect((await reader.list(APT, 'u001')).map((p) => p.paymentId)).toEqual(all.filter((p) => p.unitId === 'u001').map((p) => p.paymentId));
    expect(m.calls.gsi).toBe(0);
    await m.store.markReady(APT, 'backfill');
    await reader.list(APT, 'u001', { consistent: true });
    expect(m.calls.gsi).toBe(0);
  });

  it('backfill: dry-run yazmaz; uygulama eksik anahtarlari yazar ve siteyi hazir isaretler; verify kurus karsilastirir', async () => {
    const all = scalePayments(30, 3);
    // Yarisi Adim 2 sonrasi yazilmis (dizinli), yarisi eski.
    const m = memoryStore(all.map((p, i) => (i % 2 === 0 ? withPaymentIndex(p) : p)));
    const dry = await reconcileUnitPayments(m.store, APT, 'dry-run');
    expect(dry).toMatchObject({ payments: 90, missing: 45, written: 0, ready: false });
    expect(m.calls.writes).toBe(0);

    const applied = await reconcileUnitPayments(m.store, APT, 'apply');
    expect(applied).toMatchObject({ missing: 45, written: 45, conflicts: [], ready: true });

    const again = await reconcileUnitPayments(m.store, APT, 'apply');
    expect(again).toMatchObject({ missing: 0, written: 0, ready: true });

    const verify = await reconcileUnitPayments(m.store, APT, 'verify');
    expect(verify).toMatchObject({ missing: 0, unitMismatches: [], ready: true });

    // Dizin kaydi bozulursa verify daireyi raporlar.
    const victim = [...m.items.values()].find((p) => p.unitId === 'u007') as Payment & { GSI1PK?: string };
    m.items.set(victim.SK, { ...victim, GSI1PK: 'UPAY#baska#u007' });
    const broken = await reconcileUnitPayments(m.store, APT, 'verify');
    expect(broken.missing).toBe(1);
    expect(broken.unitMismatches).toEqual([expect.objectContaining({ unitId: 'u007', legacy: 3, indexed: 2 })]);
  });

  it('baska amacla dolu GSI1 anahtari ezilmez; site hazir isaretlenmez', async () => {
    const p = payment(1, 'u001', '2026-01-01', 1000);
    const m = memoryStore([{ ...p, GSI1PK: 'BASKA#x', GSI1SK: 'y' }]);
    const r = await reconcileUnitPayments(m.store, APT, 'apply');
    expect(r).toMatchObject({ conflicts: ['pay-000001'], ready: false });
  });

  it('backfill betigi: site ozetleri ve cikis ayrintilari', async () => {
    const m = memoryStore(scalePayments(4, 2));
    const log: string[] = [];
    const r = await backfillUnitPayments({ core: { listSiteIds: async () => [APT] }, store: m.store, log: { info: (s: string) => log.push(s) } }, { mode: 'apply' });
    expect(r).toMatchObject({ sites: 1, ready: 1, payments: 8, missing: 8, written: 8, conflictSites: [], mismatchedSites: [], notReady: [] });
    expect(log.join('\n')).toContain('hazir');
  });

  describe('postBatch makbuz kaydina dizin anahtarini ayni yazimda ekler', () => {
    const ddb = mockClient(DynamoDBDocumentClient);
    beforeEach(() => {
      ddb.reset();
      resetDynamoCache();
      // Sahte ortam (core.test.ts ile ayni): gercek AWS bolgesi / tablo / uc nokta gerekmez.
      vi.stubEnv('DYNAMODB_TABLE_NAME', 'bm-test-table');
      vi.stubEnv('AWS_REGION', 'eu-central-1');
      vi.stubEnv('DYNAMODB_ENDPOINT', '');
      ddb.on(TransactWriteCommand).resolves({});
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      resetDynamoCache();
    });

    it('PAYMENT kaydi GSI1 UPAY anahtarlariyla yazilir; islem ve satirlar degismez', async () => {
      const tx: Transaction = {
        ...financeKeys.transaction(APT, '20261105-abc'),
        entityType: 'TRANSACTION',
        transactionId: '20261105-abc',
        siteId: APT,
        kind: 'payment',
        date: '2026-11-05',
        description: 'Tahsilat',
        lines: [
          { accountId: 'bank', side: 'debit', amount: toKurus(150050) },
          { accountId: 'recv-u001-occupant', side: 'credit', amount: toKurus(150050), unitId: 'u001', liableParty: 'occupant' },
        ],
        totalAmount: toKurus(150050),
        createdAt: '2026-11-05T10:00:00.000Z',
        createdBy: 'm1',
      };
      const p = { ...payment(9, 'u001', '2026-11-05', 150050), transactionId: tx.transactionId };
      await postBatch({ transactions: [tx], idempotency: { id: 'pay-9', fingerprint: 'f', recordId: p.SK }, records: [p] });
      const items = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input.TransactItems ?? [];
      const record = items.map((i) => i.Put?.Item).find((it) => it?.entityType === 'PAYMENT');
      expect(record).toMatchObject({ paymentId: 'pay-000009', GSI1PK: `UPAY#${APT}#u001`, GSI1SK: '2026-11-05#pay-000009' });
      const entries = items.map((i) => i.Put?.Item).filter((it) => it?.entityType === 'LEDGER_ENTRY');
      expect(entries).toHaveLength(2);
      expect(entries.every((e) => !('GSI1PK' in (e as object)))).toBe(true);
      expect(p).not.toHaveProperty('GSI1PK');
    });
  });
});

// ---------------------------------------------------------------------------
// 2-2: ledger_audit fan-out
// ---------------------------------------------------------------------------

function site(id: string): Site {
  return {
    PK: `APT#${id}`,
    SK: 'SITE',
    entityType: 'SITE',
    siteId: id,
    tenantId: 't',
    name: id,
    type: 'site',
    address: { line1: 'x', district: 'Kayapinar', city: 'Diyarbakir' },
    fiscalYearStartMonth: 1,
    settings: defaultSiteSettings(),
    status: 'active',
    createdAt: NOW.toISOString(),
    createdBy: 'seed',
    updatedAt: NOW.toISOString(),
    updatedBy: 'seed',
    version: 1,
  } as Site;
}

function auditWorker(opts: { failSite?: string; fanout?: boolean } = {}) {
  const sites = Array.from({ length: 23 }, (_, i) => site(`s${pad(i + 1, 3)}`));
  const emitted: { metrics: Record<string, number>; props?: Record<string, unknown> }[] = [];
  const run = vi.fn(async (apartmentId: string) => {
    if (apartmentId === opts.failSite) throw new Error('ddb throttled');
    return { counts: {}, findings: [], unstable: [] };
  });
  const verify = vi.fn(async (scope: string) => ({ scope, checked: 3, findings: [] }));
  const mem = createMemoryJobFanout();
  const worker = createSchedulerWorker({
    core: { listSiteIds: async () => sites.map((s) => s.siteId), getSite: async (id: string) => sites.find((s) => s.siteId === id) },
    auditor: { run } as never,
    auditChain: { verify } as never,
    metrics: { emit: (metrics, props) => emitted.push({ metrics, ...(props ? { props } : {}) }) },
    fanout: opts.fanout === false ? null : mem.fanout,
    now: () => NOW,
    log: { info: () => {}, error: () => {} },
    payments: null,
    payouts: null,
    invoices: null,
  });
  const send = (body: object, messageId = 'm1') => worker({ Records: [{ messageId, body: JSON.stringify(body) }] });
  return { send, run, verify, emitted, messages: mem.messages, sites };
}

describe('Adim 2-2: ledger_audit site basina mesajlar', () => {
  const at = '2026-11-28T00:40:00Z';

  it('tur mesaji her site icin ayri mesaj uretir; siteleri kendisi denetlemez, platform zincirini dogrular', async () => {
    const w = auditWorker();
    expect(await w.send({ job: 'ledger_audit', scheduledTime: at })).toEqual({ batchItemFailures: [] });
    expect(w.messages).toHaveLength(23);
    expect(w.messages[0]).toEqual({ job: 'ledger_audit', scheduledTime: at, apartmentId: 's001' });
    expect(w.run).not.toHaveBeenCalled();
    expect(w.verify).toHaveBeenCalledWith('PLATFORM');
    expect(w.emitted.find((e) => 'LedgerAuditFanout' in e.metrics)?.metrics.LedgerAuditFanout).toBe(23);
    expect(w.emitted.some((e) => e.metrics.AuditRun === 1)).toBe(true);
  });

  it('site mesaji yalnizca o siteyi denetler; sure ve hata metrigi yayinlar', async () => {
    const w = auditWorker();
    expect(await w.send({ job: 'ledger_audit', scheduledTime: at, apartmentId: 's005' })).toEqual({ batchItemFailures: [] });
    expect(w.run).toHaveBeenCalledTimes(1);
    expect(w.run).toHaveBeenCalledWith('s005');
    expect(w.messages).toHaveLength(0);
    const duration = w.emitted.find((e) => 'LedgerAuditDurationMs' in e.metrics);
    expect(duration?.props).toMatchObject({ apartmentId: 's005', status: 'done' });
    expect(w.emitted.find((e) => 'LedgerAuditSiteFailed' in e.metrics)?.metrics.LedgerAuditSiteFailed).toBe(0);
  });

  it('hata veren site yalnizca kendi mesajini yeniden denetir ve hata metrigi 1 olur', async () => {
    const w = auditWorker({ failSite: 's009' });
    expect(await w.send({ job: 'ledger_audit', scheduledTime: at, apartmentId: 's009' }, 'm9')).toEqual({ batchItemFailures: [{ itemIdentifier: 'm9' }] });
    expect(w.emitted.find((e) => 'LedgerAuditSiteFailed' in e.metrics)).toMatchObject({ metrics: { LedgerAuditSiteFailed: 1 }, props: { apartmentId: 's009' } });
  });

  it('kuyruk yoksa (yerel) siteler ayni cagrida sirayla denetlenir', async () => {
    const w = auditWorker({ fanout: false });
    await w.send({ job: 'ledger_audit', scheduledTime: at });
    expect(w.run).toHaveBeenCalledTimes(23);
    expect(w.emitted.filter((e) => 'LedgerAuditDurationMs' in e.metrics)).toHaveLength(23);
  });

  it('SQS fan-out 10\'arli gruplarla gonderir; basarisiz girdi hata olarak doner', async () => {
    const send = vi.fn(async (cmd: SendMessageBatchCommand) => ({ Successful: (cmd.input.Entries ?? []).map((e) => ({ Id: e.Id })), Failed: [] }));
    const fanout = createSqsJobFanout('https://sqs/q', { send } as never);
    const list = Array.from({ length: 23 }, (_, i) => ({ job: 'ledger_audit', scheduledTime: at, apartmentId: `s${i}` }));
    expect(await fanout.enqueue(list)).toEqual({ queued: 23 });
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map((c) => c[0].input.Entries?.length)).toEqual([10, 10, 3]);

    const partial = createSqsJobFanout('https://sqs/q', {
      send: async (cmd: SendMessageBatchCommand) => ({ Successful: [{ Id: '0' }], Failed: [{ Id: '1', Code: 'x', SenderFault: false }] }),
    } as never);
    await expect(partial.enqueue(list.slice(0, 2))).rejects.toMatchObject({ name: 'JobFanoutError', failed: ['s1'] });
    expect(new JobFanoutError('x', ['a']).failed).toEqual(['a']);
  });
});

// ---------------------------------------------------------------------------
// 2-3: banka mutabakati ve tedarikci ozeti - sinirli okuma
// ---------------------------------------------------------------------------

function entry(i: number, accountId: string, date: string, side: 'debit' | 'credit', amount: number): LedgerEntry {
  const transactionId = `${date.replaceAll('-', '')}-t${pad(i, 6)}`;
  return {
    ...financeKeys.entry(APT, accountId, transactionId, 1),
    entityType: 'LEDGER_ENTRY',
    entryId: `${transactionId}#1`,
    transactionId,
    siteId: APT,
    accountId,
    side,
    amount: toKurus(amount),
    date,
    lineNo: 1,
    createdAt: `${date}T10:00:00.000Z`,
    createdBy: 'seed',
  };
}

function bankLedger(n = 3_000) {
  const r = rng(7);
  const entries = Array.from({ length: n }, (_, i) => entry(i, 'bank', dayOf(r), r() < 0.6 ? 'debit' : 'credit', 100 + Math.floor(r() * 2_000_000)));
  const balance = entries.reduce((t, e) => t + (e.side === 'debit' ? e.amount : -e.amount), 0);
  let version = entries.length;
  const reads = { all: 0, ranged: 0, rangedRows: 0 };
  const deps = {
    getAccount: vi.fn(async () => ({ balance: toKurus(balance), version })),
    listAccountEntries: vi.fn(async (_a: string, accountId: string, range: { from?: string; to?: string } = {}) => {
      reads.ranged++;
      // Anahtar araligi benzetimi: `LE#<hesap>#<YYYYMMDD-...>`
      const rows = entries.filter((e) => e.accountId === accountId && (!range.from || e.date >= range.from) && (!range.to || e.date <= range.to));
      reads.rangedRows += rows.length;
      return rows;
    }),
    listAllEntries: vi.fn(async () => {
      reads.all++;
      return entries;
    }),
  };
  return { entries, balance, deps, reads, bump: () => version++ };
}

describe('Adim 2-3: banka mutabakati sinirli okuma', () => {
  it('kesim gunu bakiyeleri eski tam okumayla kurus kurus ayni (3.000 satir, 200 rastgele aralik)', async () => {
    const b = bankLedger();
    const r = rng(99);
    for (let k = 0; k < 200; k++) {
      const a = dayOf(r);
      const c = dayOf(r);
      const [before, through] = a < c ? [a, c] : [c, a];
      const got = await boundaryBalances(b.deps, APT, 'bank', { through, before });
      expect(got.mode).toBe('bounded');
      expect({ through: got.through, before: got.before }).toEqual(boundaryBalancesFromAll(b.entries, 'bank', { through, before }));
    }
    expect(b.reads.all).toBe(0);
  });

  it('yakin tarihli ekstrede yalnizca kesimden sonraki satirlar okunur', async () => {
    const b = bankLedger();
    const got = await boundaryBalances(b.deps, APT, 'bank', { through: '2026-11-30', before: '2026-11-01' });
    expect(got.mode).toBe('bounded');
    // ~2/36 ay: tam okumanin yaklasik %6'si.
    expect(got.entriesRead).toBeLessThan(b.entries.length / 10);
    expect({ through: got.through, before: got.before }).toEqual(boundaryBalancesFromAll(b.entries, 'bank', { through: '2026-11-30', before: '2026-11-01' }));
  });

  it('okuma sirasinda hesap surumu degisirse tekrar denenir; tutmazsa tam okumaya duser', async () => {
    const b = bankLedger(200);
    let calls = 0;
    const getAccount = vi.fn(async () => ({ balance: toKurus(b.balance), version: calls++ < 1 ? 1 : 2 }));
    const once = await boundaryBalances({ ...b.deps, getAccount }, APT, 'bank', { through: '2025-06-30' });
    expect(once).toMatchObject({ mode: 'bounded', attempts: 2 });

    let v = 0;
    const flapping = vi.fn(async () => ({ balance: toKurus(b.balance), version: v++ }));
    const full = await boundaryBalances({ ...b.deps, getAccount: flapping }, APT, 'bank', { through: '2025-06-30' });
    expect(full.mode).toBe('full');
    expect(full.through).toBe(boundaryBalancesFromAll(b.entries, 'bank', { through: '2025-06-30' }).through);

    const noRange = await boundaryBalances({ getAccount: b.deps.getAccount, listAllEntries: b.deps.listAllEntries }, APT, 'bank', { before: '2025-01-01' });
    expect(noRange.mode).toBe('full');
  });
});

describe('Adim 2-3: tedarikci ozeti onbellegi', () => {
  function payableWorld() {
    const r = rng(5);
    const entries: LedgerEntry[] = [];
    const txs: Transaction[] = [];
    let i = 0;
    const add = (kind: Transaction['kind'], side: 'debit' | 'credit', amount: number, date: string, reversalOf?: string) => {
      const e = entry(++i, 'payable-ab', date, side, amount);
      entries.push(e);
      txs.push({
        ...financeKeys.transaction(APT, e.transactionId),
        entityType: 'TRANSACTION',
        transactionId: e.transactionId,
        siteId: APT,
        kind,
        date,
        description: `${kind} ${i}`,
        ...(reversalOf ? { reversalOf } : {}),
        lines: [],
        totalAmount: toKurus(amount),
        createdAt: e.createdAt,
        createdBy: 'seed',
      } as Transaction);
      return e.transactionId;
    };
    for (let k = 0; k < 300; k++) {
      const d = dayOf(r);
      const id = add('expense', 'credit', 50_000 + Math.floor(r() * 500_000), d);
      if (k % 25 === 0) add('reversal', 'debit', entries.at(-1)!.amount, d, id);
      if (k % 3 === 0) add('payable_payment', 'debit', 40_000 + Math.floor(r() * 300_000), dayOf(r));
    }
    const listAllEntries = vi.fn(async () => entries);
    const getTransactions = vi.fn(async (_a: string, ids: string[]) => txs.filter((t) => ids.includes(t.transactionId)));
    const saved = new Map<string, PayableSummaryItem>();
    const store: PayableSummaryStore = {
      get: async (_a, acc) => saved.get(acc),
      put: async (item) => {
        const cur = saved.get(item.accountId);
        if (cur && cur.sourceVersion > item.sourceVersion) return false;
        saved.set(item.accountId, item);
        return true;
      },
    };
    return { listAllEntries, getTransactions, store, saved, add };
  }

  it('surum tutarken defter okunmaz; sonuc eski tam hesapla kurus kurus ayni', async () => {
    const w = payableWorld();
    const account = { siteId: APT, accountId: 'payable-ab', version: 17 };
    const first = await loadPayableSummary({ ...w, now: () => NOW }, account);
    expect(first.source).toBe('computed');
    expect(first.summary).toEqual(await computePayableSummaryFull(w, APT, 'payable-ab'));
    expect(first.summary.openBalance).toBeGreaterThan(0);
    const reads = w.listAllEntries.mock.calls.length;

    const second = await loadPayableSummary({ ...w, now: () => NOW }, account);
    expect(second).toEqual({ summary: first.summary, source: 'cache' });
    expect(w.listAllEntries.mock.calls.length).toBe(reads);
  });

  it('yeni hareket (surum artisi) ozeti yeniler; eski surumlu ozet asla donmez', async () => {
    const w = payableWorld();
    await loadPayableSummary(w, { siteId: APT, accountId: 'payable-ab', version: 1 });
    w.add('expense', 'credit', 123_456, '2026-11-27');
    const after = await loadPayableSummary(w, { siteId: APT, accountId: 'payable-ab', version: 2 });
    expect(after.source).toBe('computed');
    expect(after.summary).toEqual(await computePayableSummaryFull(w, APT, 'payable-ab'));
    expect(w.saved.get('payable-ab')?.sourceVersion).toBe(2);
    // Daha eski surumle istek (yaris) yeni ozeti ezmez ve onbellegi kullanmaz.
    const stale = await loadPayableSummary(w, { siteId: APT, accountId: 'payable-ab', version: 1 });
    expect(stale.source).toBe('computed');
    expect(w.saved.get('payable-ab')?.sourceVersion).toBe(2);
  });

  it('onbellek yazimi basarisiz olsa da sonuc doner; surumsuz hesapta onbellek kullanilmaz', async () => {
    const w = payableWorld();
    const warn = vi.fn();
    const broken: PayableSummaryStore = { get: async () => undefined, put: async () => Promise.reject(new Error('ddb')) };
    const r = await loadPayableSummary({ ...w, store: broken, log: { warn } }, { siteId: APT, accountId: 'payable-ab', version: 3 });
    expect(r.source).toBe('computed');
    expect(warn).toHaveBeenCalled();
    const noVersion = await loadPayableSummary(w, { siteId: APT, accountId: 'payable-ab' } as never);
    expect(noVersion.source).toBe('computed');
    expect(w.saved.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2-4: tohumlama ve yuk testi yardimcilari (saf)
// ---------------------------------------------------------------------------

describe('Adim 2-4: sentetik site ve yuk testi', () => {
  it('daire plani Diyarbakir olcegine uyar ve deterministiktir', async () => {
    const { unitPlan, monthsBack, assertSafeTable, ownerIdOf } = await import('../scripts/seed-scale-test.js');
    const plan = unitPlan(400, 5);
    expect(plan).toHaveLength(400);
    expect(new Set(plan.map((p) => p.block))).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
    expect(plan.filter((p) => p.block === 'C')).toHaveLength(80);
    expect(plan.every((p) => p.areaM2 >= 85 && p.areaM2 <= 160)).toBe(true);
    expect(unitPlan(400, 5)).toEqual(plan);
    expect(unitPlan(500, 5).at(-1)).toMatchObject({ block: 'E', number: '100' });
    expect(unitPlan(333, 4)).toHaveLength(333);
    expect(monthsBack('2026-02', 3)).toEqual(['2025-12', '2026-01', '2026-02']);
    expect(ownerIdOf('A', '12')).toBe('scale-owner-a12');
    expect(assertSafeTable('building-management-local')).toBe('building-management-local');
    expect(assertSafeTable('building-management-dev')).toBe('building-management-dev');
    expect(() => assertSafeTable('building-management-prod')).toThrow(/Guvenlik/);
    expect(() => assertSafeTable('building-management')).toThrow(/Guvenlik/);
    expect(assertSafeTable('ozel-tablo', 'ozel-tablo')).toBe('ozel-tablo');
  });

  it('yuk testi: yuzdelik, hedef ve hata orani degerlendirmesi; agirlikli secim', async () => {
    const { percentile, summarize, scenarios, picker, mockToken } = await import('../scripts/load-test.js');
    const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 50)).toBe(50);
    expect(percentile(sorted, 95)).toBe(95);
    expect(percentile([], 95)).toBe(0);

    const list = scenarios('2026-11');
    expect(new Set(list.map((s) => s.group))).toEqual(new Set(['portal', 'raporlar', 'tahakkuk', 'sayac', 'banka']));
    expect(list.filter((s) => s.method === 'POST').every((s) => s.write)).toBe(true);
    const portal = list[0]!;
    const fast = summarize(list, new Map([[portal.name, { ms: Array.from({ length: 100 }, () => 100), errors: 0 }]]));
    expect(fast.ok).toBe(true);
    const slow = summarize(list, new Map([[portal.name, { ms: Array.from({ length: 100 }, () => portal.p95 + 1), errors: 0 }]]));
    expect(slow.ok).toBe(false);
    const erroring = summarize(list, new Map([[portal.name, { ms: Array.from({ length: 95 }, () => 10), errors: 5 }]]));
    expect(erroring.results[0]).toMatchObject({ count: 100, errors: 5, ok: false });

    const r = rng(1);
    const pick = picker(list, r);
    const counts = new Map<string, number>();
    for (let i = 0; i < 20_000; i++) {
      const s = pick();
      counts.set(s.group, (counts.get(s.group) ?? 0) + 1);
    }
    expect((counts.get('portal') ?? 0) / 20_000).toBeGreaterThan(0.5);
    expect(mockToken({ sub: 'x' })).toMatch(/^mock\./);
  });
});
