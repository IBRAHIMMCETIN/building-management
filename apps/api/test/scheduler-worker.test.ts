import { describe, expect, it, vi } from 'vitest';
import { createInMemoryEventPublisher } from '../src/events/publisher.js';
import { type Site, toKurus } from '../src/modules/core/types.js';
import { defaultSiteSettings } from '../src/modules/core/service.js';
import { financeKeys } from '../src/modules/finance/repository.js';
import { buildDueReminders } from '../src/modules/finance/reports.js';
import type { Transaction } from '../src/modules/finance/types.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { buildNotifications } from '../src/workers/notification-worker.js';
import { createSchedulerWorker, istanbulDate, parseJobMessage } from '../src/workers/scheduler-worker.js';

const NOW = new Date('2026-12-01T00:30:00.000Z'); // Istanbul 1 Aralik 03:30
const quiet = { info: () => {}, error: () => {} };

function site(id: string, over: Partial<Site> = {}): Site {
  return {
    PK: `APT#${id}`,
    SK: 'SITE',
    entityType: 'SITE',
    siteId: id,
    tenantId: 't',
    name: id,
    type: 'apartment',
    address: { line1: 'x', district: 'y', city: 'z' },
    fiscalYearStartMonth: 1,
    settings: {
      ...defaultSiteSettings(),
      dueDayOfMonth: 5,
      monthlyDuesPlan: { enabled: true, totalAmount: toKurus(300_000), distributionKey: 'equal', liableParty: 'occupant' },
    },
    status: 'active',
    createdAt: NOW.toISOString(),
    createdBy: 'seed',
    updatedAt: NOW.toISOString(),
    updatedBy: 'seed',
    version: 1,
    ...over,
  } as Site;
}

function setup(sites: Site[] = [site('apt-1'), site('apt-2')], options: { payments?: { reconcile: (apt: string) => Promise<unknown>; reconcileRefunds?: () => Promise<unknown> } | null } = {}) {
  const events = createInMemoryEventPublisher();
  const finance = {
    autoChargeDues: vi.fn(async () => ({
      status: 'charged' as const,
      batchId: 'b',
      distributionKey: 'equal' as const,
      totalAmount: toKurus(300_000),
      distributedAmount: toKurus(300_000),
      count: 3,
      replayed: false,
      items: [],
      exempt: [],
      vacant: [],
    })),
    postLateFees: vi.fn(async (_apt: string, p: { period: string }) => ({
      period: p.period,
      count: 1,
      totalAmount: toKurus(8667),
      items: [
        { accountId: 'recv-u1-occupant', unitId: 'u1', liableParty: 'occupant' as const, amount: toKurus(8667), transactionId: 'tx-new', replayed: false },
        { accountId: 'recv-u2-occupant', unitId: 'u2', liableParty: 'occupant' as const, amount: toKurus(100), transactionId: 'tx-old', replayed: true },
      ],
    })),
    dueReminders: vi.fn(async () => [
      { unitId: 'u1', liableParty: 'occupant' as const, kind: 'upcoming' as const, dueDate: '2026-12-04', amount: 100_000 },
    ]),
  };
  const core = {
    listSiteIds: vi.fn(async () => sites.map((s) => s.siteId)),
    getSite: vi.fn(async (id: string) => sites.find((s) => s.siteId === id)),
  };
  const payments =
    options.payments === undefined
      ? {
          reconcile: vi.fn(async () => ({ checked: 1, succeeded: 1, failed: 0, review: 0, stillPending: 0 })),
          reconcileRefunds: vi.fn(async () => ({ checked: 0, refunded: 0, stillPending: 0 })),
        }
      : options.payments === null
        ? null
        : { reconcileRefunds: vi.fn(async () => ({ checked: 0, refunded: 0, stillPending: 0 })), ...options.payments };
  const worker = createSchedulerWorker({ core, finance, events, now: () => NOW, log: quiet, payments: payments as never });
  const run = (body: object, messageId = 'm1') => worker({ Records: [{ messageId, body: JSON.stringify(body) }] });
  return { worker, run, finance, core, events, payments };
}

const at = '2026-11-30T23:30:00Z'; // Scheduler planlanan zamani: Istanbul 1 Aralik 02:30

describe('scheduler worker - mesaj ve tarih', () => {
  it('planlanan zaman Istanbul gunune cevrilir (UTC gece yarisi kaymasi)', () => {
    expect(istanbulDate(at)).toBe('2026-12-01');
    expect(istanbulDate('2026-12-01T20:59:00Z')).toBe('2026-12-01');
    expect(istanbulDate('2026-12-01T21:00:00Z')).toBe('2026-12-02');
  });

  it('gecersiz mesajlar reddedilir', () => {
    expect(() => parseJobMessage('x')).toThrow(/JSON/);
    expect(() => parseJobMessage(JSON.stringify({ job: 'sil', scheduledTime: at }))).toThrow(/Bilinmeyen/);
    expect(() => parseJobMessage(JSON.stringify({ job: 'late_fees', scheduledTime: 'dun' }))).toThrow(/scheduledTime/);
    expect(() => parseJobMessage(JSON.stringify({ job: 'late_fees', scheduledTime: at, apartmentId: 'a/b' }))).toThrow(/apartmentId/);
    expect(parseJobMessage(JSON.stringify({ job: 'late_fees', scheduledTime: at }))).toEqual({ job: 'late_fees', scheduledTime: at });
  });

  it('bozuk mesaj hata olarak isaretlenir (DLQ + alarm icin)', async () => {
    const { worker } = setup();
    expect(await worker({ Records: [{ messageId: 'bad', body: '{}' }] })).toEqual({ batchItemFailures: [{ itemIdentifier: 'bad' }] });
  });
});

describe('scheduler worker - isler', () => {
  it('monthly_dues: tum apartmanlar icin donem ve son odeme gunuyle otomatik tahakkuk', async () => {
    const { run, finance } = setup();
    expect(await run({ job: 'monthly_dues', scheduledTime: at })).toEqual({ batchItemFailures: [] });
    expect(finance.autoChargeDues).toHaveBeenCalledTimes(2);
    expect(finance.autoChargeDues).toHaveBeenCalledWith('apt-1', {
      period: '2026-12',
      plan: expect.objectContaining({ enabled: true, totalAmount: 300_000 }),
      dueDayOfMonth: 5,
    });
  });

  it('late_fees: ONCEKI ayi kesinlestirir; olaylar defterle birlikte outbox\'a girdigi icin worker ayrica yayinlamaz', async () => {
    const { run, finance, events } = setup([site('apt-1')]);
    await run({ job: 'late_fees', scheduledTime: at });
    expect(finance.postLateFees).toHaveBeenCalledWith('apt-1', { period: '2026-11', monthlyBasisPoints: 500, dueDayOfMonth: 5 });
    expect(events.published).toHaveLength(0);
  });

  it('dues_reminders: gunun hatirlatmalari tek, deterministik kimlikli olayla yayinlanir', async () => {
    const { run, finance, events } = setup([site('apt-1')]);
    await run({ job: 'dues_reminders', scheduledTime: '2026-12-01T07:00:00Z' });
    expect(finance.dueReminders).toHaveBeenCalledWith('apt-1', '2026-12-01');
    expect(events.published[0]).toMatchObject({
      eventId: 'DUES_REMINDER:apt-1:2026-12-01',
      type: 'DUES_REMINDER',
      payload: { date: '2026-12-01', items: [{ unitId: 'u1', kind: 'upcoming', amount: 100_000 }] },
    });
  });

  it('pasif apartman atlanir; apartmentId verilirse yalnizca o apartman islenir', async () => {
    const { run, finance, core } = setup([site('apt-1', { status: 'inactive' }), site('apt-2')]);
    await run({ job: 'monthly_dues', scheduledTime: at });
    expect(finance.autoChargeDues).toHaveBeenCalledTimes(1);
    expect(finance.autoChargeDues).toHaveBeenCalledWith('apt-2', expect.anything());

    finance.autoChargeDues.mockClear();
    core.listSiteIds.mockClear();
    await run({ job: 'monthly_dues', scheduledTime: at, apartmentId: 'apt-2' });
    expect(core.listSiteIds).not.toHaveBeenCalled();
    expect(finance.autoChargeDues).toHaveBeenCalledTimes(1);
  });

  it('bir apartman hata verirse digerleri islenir, mesaj tekrar denenmek uzere hatali doner', async () => {
    const { run, finance } = setup();
    finance.autoChargeDues.mockRejectedValueOnce(new Error('db patladi'));
    expect(await run({ job: 'monthly_dues', scheduledTime: at }, 'm9')).toEqual({ batchItemFailures: [{ itemIdentifier: 'm9' }] });
    expect(finance.autoChargeDues).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Hatirlatma hesaplama (saf)
// ---------------------------------------------------------------------------

function tx(id: string, over: Partial<Transaction>): Transaction {
  return {
    ...financeKeys.transaction('apt-1', id),
    entityType: 'TRANSACTION',
    transactionId: id,
    siteId: 'apt-1',
    kind: 'dues_charge',
    date: '2026-11-01',
    description: 'x',
    lines: [],
    totalAmount: toKurus(0),
    createdAt: NOW.toISOString(),
    createdBy: 'u',
    ...over,
  };
}

const charge = (id: string, unitId: string, amount: number, dueDate: string) =>
  tx(id, {
    dueDate,
    lines: [
      { accountId: `recv-${unitId}-occupant`, side: 'debit', amount: toKurus(amount), unitId, liableParty: 'occupant' },
      { accountId: 'income-dues', side: 'credit', amount: toKurus(amount) },
    ],
  });

const payment = (id: string, unitId: string, amount: number, date: string) =>
  tx(id, {
    kind: 'payment',
    date,
    lines: [
      { accountId: 'cash', side: 'debit', amount: toKurus(amount) },
      { accountId: `recv-${unitId}-occupant`, side: 'credit', amount: toKurus(amount), unitId, liableParty: 'occupant' },
    ],
  });

describe('scheduler worker - online odeme mutabakati (Adim 8b)', () => {
  it('payment_reconcile: her aktif apartman icin mutabakat calisir', async () => {
    const { run, payments } = setup();
    expect(await run({ job: 'payment_reconcile', scheduledTime: '2026-11-20T10:15:00Z' })).toEqual({ batchItemFailures: [] });
    expect(payments!.reconcile).toHaveBeenCalledTimes(2);
    expect(payments!.reconcile).toHaveBeenCalledWith('apt-1');
    // Iadeler apartmandan bagimsiz tek sefer; tek apartmanlik mesajda calismaz.
    expect(payments!.reconcileRefunds).toHaveBeenCalledTimes(1);
    await run({ job: 'payment_reconcile', scheduledTime: '2026-11-20T10:30:00Z', apartmentId: 'apt-1' });
    expect(payments!.reconcileRefunds).toHaveBeenCalledTimes(1);
  });

  it('iade mutabakati hata verirse mesaj tekrar denenir', async () => {
    const w = setup(undefined, {
      payments: { reconcile: vi.fn(async () => ({})), reconcileRefunds: vi.fn(async () => { throw new Error('iyzico'); }) },
    });
    expect(await w.run({ job: 'payment_reconcile', scheduledTime: '2026-11-20T10:15:00Z' }, 'm7')).toEqual({
      batchItemFailures: [{ itemIdentifier: 'm7' }],
    });
  });

  it('online odeme kapaliysa apartmanlar atlanir; mutabakat hatasi mesaji tekrar denetir', async () => {
    const off = setup(undefined, { payments: null });
    expect(await off.run({ job: 'payment_reconcile', scheduledTime: '2026-11-20T10:15:00Z' })).toEqual({ batchItemFailures: [] });
    const failing = setup(undefined, { payments: { reconcile: vi.fn(async () => { throw new Error('iyzico'); }) } });
    expect(await failing.run({ job: 'payment_reconcile', scheduledTime: '2026-11-20T10:15:00Z' }, 'm9')).toEqual({
      batchItemFailures: [{ itemIdentifier: 'm9' }],
    });
  });
});

describe('buildDueReminders', () => {
  const recv = new Set(['recv-u1-occupant', 'recv-u2-occupant', 'recv-u3-occupant']);

  it('vadeden 3 gun once, 1 ve 7 gun sonra; acik tutar FIFO ile', () => {
    const txs = [
      charge('a', 'u1', 100_000, '2026-12-04'), // 3 gun sonra
      charge('b', 'u2', 100_000, '2026-11-30'), // 1 gun once
      payment('p', 'u2', 40_000, '2026-11-29'),
      charge('c', 'u3', 50_000, '2026-11-24'), // 7 gun once
      charge('d', 'u3', 50_000, '2026-11-20'), // hedef degil
    ];
    expect(buildDueReminders(txs, recv, '2026-12-01')).toEqual([
      { unitId: 'u1', liableParty: 'occupant', kind: 'upcoming', dueDate: '2026-12-04', amount: 100_000 },
      { unitId: 'u2', liableParty: 'occupant', kind: 'overdue_1', dueDate: '2026-11-30', amount: 60_000 },
      { unitId: 'u3', liableParty: 'occupant', kind: 'overdue_7', dueDate: '2026-11-24', amount: 50_000 },
    ]);
  });

  it('odenmis veya ters kayitla iptal edilmis kalem hatirlatilmaz', () => {
    const txs = [
      charge('a', 'u1', 100_000, '2026-12-04'),
      payment('p', 'u1', 100_000, '2026-11-15'),
      charge('b', 'u2', 100_000, '2026-11-30'),
      tx('r', { kind: 'reversal', reversalOf: 'b', lines: [] }),
    ];
    expect(buildDueReminders(txs, recv, '2026-12-01')).toEqual([]);
  });
});

describe('bildirimler - zamanlanmis gorev olaylari', () => {
  const members = [
    { userId: 'kiraci', unitId: 'u1', apartmentId: 'apt-1', relation: 'tenant', residesInUnit: true, status: 'active', startDate: '2026-01-01' },
    { userId: 'malik', unitId: 'u1', apartmentId: 'apt-1', relation: 'owner', residesInUnit: false, status: 'active', startDate: '2026-01-01' },
  ] as UnitMembership[];

  it('LATE_FEE_POSTED ve DUES_REMINDER ilgili alt cariyi goren uyeye gider', () => {
    const base = { version: 1 as const, occurredAt: NOW.toISOString(), apartmentId: 'apt-1', actorId: 'system-scheduler', groupKey: 'apt-1' };
    const fee = buildNotifications(
      { ...base, eventId: 'e1', type: 'LATE_FEE_POSTED', payload: { period: '2026-11', items: [{ unitId: 'u1', liableParty: 'occupant', amount: toKurus(8667), transactionId: 't' }] } },
      members,
      new Map(),
      '2026-12-01',
    );
    expect(fee).toEqual([expect.objectContaining({ userId: 'kiraci', template: 'late_fee_posted', data: { unitId: 'u1', amount: 8667, period: '2026-11' } })]);

    const rem = buildNotifications(
      {
        ...base,
        eventId: 'e2',
        type: 'DUES_REMINDER',
        payload: { date: '2026-12-01', items: [{ unitId: 'u1', liableParty: 'owner', kind: 'overdue_7', dueDate: '2026-11-24', amount: toKurus(500) }] },
      },
      members,
      new Map(),
      '2026-12-01',
    );
    expect(rem).toEqual([expect.objectContaining({ userId: 'malik', template: 'dues_reminder_overdue_7' })]);
  });
});

