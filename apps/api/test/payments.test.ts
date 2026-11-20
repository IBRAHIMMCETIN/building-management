import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import type { Role } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
import { createInMemoryEventPublisher } from '../src/events/publisher.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Kurus, type LiableParty, type Site, type Unit, toKurus } from '../src/modules/core/types.js';
import {
  LedgerConflictError,
  createFinanceRepository,
  financeKeys,
  toLedgerEntries,
} from '../src/modules/finance/repository.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import type { LedgerEntry, Transaction } from '../src/modules/finance/types.js';
import { loadPaymentsConfig } from '../src/modules/payments/config.js';
import { createFakePaymentProvider } from '../src/modules/payments/fakeProvider.js';
import { allocateSelection, buildQuote, platformFeeOf } from '../src/modules/payments/quote.js';
import {
  PaymentsConflictError,
  createPaymentsRepository,
  paymentKeys,
} from '../src/modules/payments/repository.js';
import { createPaymentsService, utcStamp } from '../src/modules/payments/service.js';
import type { PaymentAccount, PaymentIntent } from '../src/modules/payments/types.js';
import type { PortalRepository } from '../src/modules/portal/repository.js';
import { createPortalService } from '../src/modules/portal/service.js';
import type { UnitMembership } from '../src/modules/portal/types.js';
import { createFakeFinanceRepo } from './fakes/financeRepo.js';
import { createFakePaymentsRepo } from './fakes/paymentsRepo.js';

// ---------------------------------------------------------------------------
// Ortak dunya: sahte defter + portal okuma modeli + sahte saglayici, ayni veriyi paylasir
// ---------------------------------------------------------------------------

const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const SEED_TS = '2026-01-01T00:00:00.000Z';
const audit = { createdAt: SEED_TS, createdBy: 'seed', updatedAt: SEED_TS, updatedBy: 'seed', version: 1 };
const TL = (n: number) => Math.round(n * 100);

function unit(id: string, apt = APT): Unit {
  return {
    PK: `APT#${apt}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    status: 'active',
    ...audit,
    unitId: id,
    siteId: apt,
    blockId: 'b1',
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
  };
}

function member(userId: string, unitId: string, relation: UnitMembership['relation'], over: Partial<UnitMembership> = {}): UnitMembership {
  const apartmentId = over.apartmentId ?? APT;
  return {
    PK: `APT#${apartmentId}`,
    SK: `MEMBER#${userId}#${unitId}`,
    entityType: 'UNIT_MEMBERSHIP',
    ...audit,
    userId,
    apartmentId,
    unitId,
    relation,
    residesInUnit: relation === 'tenant',
    status: 'active',
    startDate: '2026-01-01',
    ...over,
  };
}

const site: Site = {
  PK: `APT#${APT}`,
  SK: 'SITE',
  entityType: 'SITE',
  status: 'active',
  ...audit,
  siteId: APT,
  tenantId: 'org-1',
  name: 'Lale Apartmani',
  type: 'apartment',
  address: { line1: 'x', district: 'Kadikoy', city: 'Istanbul' },
  fiscalYearStartMonth: 1,
  settings: {
    landShareEnabled: false,
    expenseGroupRules: [],
    dueDayOfMonth: 10,
    lateFeeMonthlyBasisPoints: 500,
    timezone: 'Europe/Istanbul',
    currency: 'TRY',
  },
};

function setup(options: { provider?: boolean; at?: string } = {}) {
  const clock = { now: new Date(options.at ?? '2026-11-06T10:00:00.000Z') }; // Istanbul 13:00
  const units = [unit('u1'), unit('u2'), unit('x1', OTHER_APT)];
  const memberships = [
    member('tenant-1', 'u1', 'tenant'),
    member('owner-2', 'u2', 'owner', { residesInUnit: true }), // malik + oturan: iki alt cari
    member('foreign', 'x1', 'tenant', { apartmentId: OTHER_APT }),
  ];
  const fin = createFakeFinanceRepo(APT);
  const payRepo = createFakePaymentsRepo(fin.docs as never);
  const events = createInMemoryEventPublisher();
  let n = 0;
  const newId = () => `id${String(++n).padStart(4, '0')}`;
  const now = () => clock.now;

  const core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getBlock' | 'getSite'> = {
    getUnit: async (apt, id) => units.find((u) => u.siteId === apt && u.unitId === id),
    listUnits: async (apt) => units.filter((u) => u.siteId === apt),
    getBlock: async () => undefined,
    getSite: async (apt) => (apt === APT ? site : undefined),
  };

  const allEntries = (apt: string): LedgerEntry[] =>
    [...fin.transactions.values()].filter((t) => t.siteId === apt).flatMap((t) => toLedgerEntries(t));

  const portalRepo: PortalRepository = {
    listMemberships: async (apt, userId) => memberships.filter((m) => m.apartmentId === apt && m.userId === userId),
    listLedgerEntries: async (apt, accountId) => allEntries(apt).filter((e) => e.accountId === accountId),
    getTransactions: async (apt, ids) =>
      ids.map((id) => fin.transactions.get(`${apt}|${id}`)).filter((t): t is Transaction => !!t),
    listUnitPayments: async (apt, unitId) => [...fin.payments.values()].filter((p) => p.siteId === apt && p.unitId === unitId),
    listPublishedAnnouncements: async () => [],
  };

  const finance = createFinanceService({ repository: fin.repo, core, now, newId, events });
  const portal = createPortalService({ repository: portalRepo, core, now });
  const fake = createFakePaymentProvider({ apiBaseUrl: 'https://api.test' });
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const payments = createPaymentsService({
    repository: payRepo.repo,
    portal,
    ledger: portalRepo,
    finance,
    provider: options.provider === false ? undefined : fake,
    apiBaseUrl: 'https://api.test',
    webAppUrl: 'https://web.test',
    now,
    newId,
    log: (level, message, fields) => logs.push({ level, message, fields }),
  });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    financeService: finance,
    portalService: portal,
    paymentsService: payments,
    fakePaymentProvider: fake,
  });

  const token = (sub: string, role: Role | string = 'resident', apartmentId: string = APT) =>
    `Bearer ${encodeMockToken({ sub, role, apartmentId })}`;

  async function call(method: string, path: string, auth?: string, body?: unknown) {
    const res = await app.request(path, {
      method,
      headers: {
        ...(auth ? { authorization: auth } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        'x-forwarded-for': '203.0.113.7, 10.0.0.1',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      /* html / bos */
    }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  const mgr = { apartmentId: APT, userId: 'mgr-1' };
  const charge = (unitId: string, liableParty: LiableParty, amount: number, dueDate: string, key: string, date = '2026-10-01') =>
    finance.chargeUnit(mgr, { idempotencyKey: key, unitId, liableParty, amount, date, dueDate, description: `Aidat ${dueDate}` });
  const cashPayment = (unitId: string, liableParty: LiableParty, amount: number, paidAt: string, key: string) =>
    finance.recordPayment(mgr, { idempotencyKey: key, unitId, liableParty, amount, method: 'cash', paidAt });

  /** Sakin akisi: niyet -> sahte sayfada odeme -> tarayici callback'i. */
  async function payThroughProvider(intentId: string, outcome: 'success' | 'failure' = 'success') {
    const session = fake.sessions.get(`fake_${intentId}`)!;
    fake.complete(`fake_${intentId}`, outcome);
    const ref = new URL(session.request.callbackUrl).searchParams.get('ref')!;
    return app.request(`/api/payments/fake/callback?ref=${encodeURIComponent(ref)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(`fake_${intentId}`)}`,
    });
  }

  const intentOf = (id: string) => fin.docs.get(`APT#${APT}|PI#${id}`) as unknown as PaymentIntent;

  return { clock, app, call, token, fin, payRepo, finance, portal, payments, fake, events, logs, charge, cashPayment, payThroughProvider, intentOf, portalRepo };
}

// ---------------------------------------------------------------------------
// Saf hesap: quote + secim
// ---------------------------------------------------------------------------

describe('odeme - odenebilir tutar (quote)', () => {
  it('toplam borc: islemis kistelyevm tazminati dahil (bilinen sonuc)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(3000), '2026-10-10', 'c1');
    const res = await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'));
    expect(res.status).toBe(200);
    // 3.000 TL x %5/30 x 27 gun (11 Ekim - 6 Kasim) = 135,00 TL
    expect(res.body).toMatchObject({
      unitId: 'u1',
      asOf: '2026-11-06',
      onlinePaymentEnabled: true,
      totalDue: TL(3135),
      parties: [{ liableParty: 'occupant', debt: TL(3000), accruedLateFee: TL(135), totalDue: TL(3135) }],
    });
    expect(res.body.parties[0].items).toHaveLength(1);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('aylik kesinlestirme yazildiysa yalnizca kalan tazminat islemis gorunur; toplam ayni kalir', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(3000), '2026-10-10', 'c1');
    // 1 Kasim: Ekim tazminati (11-31 Ekim, 21 gun) = 105,00 TL deftere yazilir.
    await w.finance.postLateFees(APT, { period: '2026-10', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    const q = (await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'))).body;
    expect(q.parties[0]).toMatchObject({ debt: TL(3105), accruedLateFee: TL(30), totalDue: TL(3135) });
    expect(q.parties[0].postedLateFees).toHaveLength(1);
    expect(q.parties[0].items).toHaveLength(1); // tazminat kalemi secilemez
  });

  it('avansli hesapta odenecek tutar yok', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1');
    await w.cashPayment('u1', 'occupant', TL(1500), '2026-11-02', 'p1');
    const q = (await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'))).body;
    expect(q.parties[0]).toMatchObject({ debt: 0, advance: TL(500), totalDue: 0 });
    expect(q.totalDue).toBe(0);
  });

  it('kismi odenmis ilk kalemin kalan tutari secilir; secim bastan kesintisiz olmali', async () => {
    const w = setup();
    const a = (await w.charge('u1', 'occupant', TL(1000), '2026-09-10', 'c1', '2026-09-01')).transaction.transactionId;
    const b = (await w.charge('u1', 'occupant', TL(1000), '2026-10-10', 'c2')).transaction.transactionId;
    const c = (await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c3', '2026-11-01')).transaction.transactionId;
    await w.cashPayment('u1', 'occupant', TL(400), '2026-09-05', 'p1');
    const data = await w.portal.getPayableLedgers({ apartmentId: APT, userId: 'tenant-1', role: 'resident' });
    const quote = buildQuote({ ledgers: data.ledgers, txById: data.txById, today: data.today, lateFeeMonthlyBasisPoints: 500 });
    expect(quote.parties[0]!.items.map((i) => [i.transactionId, i.remaining])).toEqual([
      [a, TL(600)],
      [b, TL(1000)],
      [c, TL(1000)],
    ]);

    const two = allocateSelection(quote, {
      mode: 'items',
      items: [
        { liableParty: 'occupant', transactionId: b },
        { liableParty: 'occupant', transactionId: a },
      ],
    });
    // Karar A: secili kalem odemesi yalnizca anapara; tazminat tahsil edilmez.
    expect(two.allocations).toEqual([
      { liableParty: 'occupant', principal: TL(1600), lateFee: 0, amount: TL(1600), subMerchantPrice: TL(1600), transactionIds: [a, b] },
    ]);

    expect(() => allocateSelection(quote, { mode: 'items', items: [{ liableParty: 'occupant', transactionId: b }] })).toThrow(
      /en eski vadeliden/,
    );
    expect(() =>
      allocateSelection(quote, {
        mode: 'items',
        items: [
          { liableParty: 'occupant', transactionId: a },
          { liableParty: 'occupant', transactionId: c },
        ],
      }),
    ).toThrow(/atlamadan/);
    expect(() => allocateSelection(quote, { mode: 'items', items: [{ liableParty: 'owner', transactionId: a }] })).toThrow(
      /size ait/,
    );
    expect(() => allocateSelection(quote, { mode: 'items', items: [] })).toThrow(/En az bir/);
  });

  it('malik + oturan: alt cari basina ayri dagilim (owner, occupant sirasiyla)', async () => {
    const w = setup();
    await w.charge('u2', 'occupant', TL(500), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'owner', TL(2000), '2026-11-10', 'c2', '2026-11-01');
    const data = await w.portal.getPayableLedgers({ apartmentId: APT, userId: 'owner-2', role: 'resident' });
    const quote = buildQuote({ ledgers: data.ledgers, txById: data.txById, today: data.today, lateFeeMonthlyBasisPoints: 500 });
    const plan = allocateSelection(quote, { mode: 'total' });
    expect(plan.allocations.map((x) => [x.liableParty, x.amount])).toEqual([
      ['occupant', TL(500)],
      ['owner', TL(2000)],
    ]);
    expect(plan.amount).toBe(TL(2500));
  });

  it('platform payi (Karar B) apartmandan kesilir, yarim yukari yuvarlanir', () => {
    expect(platformFeeOf(0, 150)).toBe(0);
    expect(platformFeeOf(TL(100), 0)).toBe(0);
    expect(platformFeeOf(10_001, 150)).toBe(150); // 150,015 -> 150
    expect(platformFeeOf(10_034, 150)).toBe(151); // 150,51 -> 151
    const quote = {
      asOf: '2026-11-06',
      lateFeeMonthlyBasisPoints: 500,
      totalDue: toKurus(10_000),
      parties: [
        { liableParty: 'occupant' as const, balance: toKurus(10_000), debt: toKurus(10_000), advance: toKurus(0), accruedLateFee: toKurus(0), totalDue: toKurus(10_000), items: [], postedLateFees: [] },
      ],
    };
    const plan = allocateSelection(quote, { mode: 'total' }, 250);
    expect(plan).toMatchObject({ amount: 10_000, platformFee: 250 });
    expect(plan.allocations[0]).toMatchObject({ amount: 10_000, subMerchantPrice: 9_750 });
  });
});

// ---------------------------------------------------------------------------
// Uctan uca: niyet -> saglayici -> callback -> defter
// ---------------------------------------------------------------------------

describe('odeme - uctan uca (sahte saglayici)', () => {
  it('toplam borc odemesi: tazminat kesinlesir, tahsilat + makbuz tek atomik yazimla islenir', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(3000), '2026-10-10', 'c1');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: 'PENDING',
      mode: 'total',
      amount: TL(3135),
      allocations: [{ liableParty: 'occupant', principal: TL(3000), lateFee: TL(135), amount: TL(3135) }],
    });
    const intentId = created.body.intentId as string;
    expect(intentId).toMatch(/^20261106100000-id\d+$/);
    expect(created.body.paymentPageUrl).toBe(`https://api.test/api/payments/fake/checkout?token=fake_${intentId}`);
    // Platform payi / alt uye tutari sakine donmez.
    expect(JSON.stringify(created.body)).not.toMatch(/subMerchant|platformFee/);

    // Saglayiciya giden istek
    const request = w.fake.sessions.get(`fake_${intentId}`)!.request;
    expect(request).toMatchObject({
      amount: TL(3135),
      conversationId: `${APT}:${intentId}`,
      callbackUrl: `https://api.test/api/payments/fake/callback?ref=${encodeURIComponent(`${APT}:${intentId}`)}`,
      buyer: { id: 'tenant-1', identityNumber: '11111111111', ip: '203.0.113.7' },
      items: [{ id: `${intentId}-occupant`, amount: TL(3135), subMerchantKey: 'fake-submerchant', subMerchantPrice: TL(3135) }],
    });

    // Sahte odeme sayfasi
    const pageRes = await w.app.request(`/api/payments/fake/checkout?token=fake_${intentId}`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('3.135,00 TL');

    const cb = await w.payThroughProvider(intentId);
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe(`https://web.test/portal/odeme/sonuc?intent=${intentId}`);

    const status = await w.call('GET', `/api/portal/payments/${intentId}`, w.token('tenant-1'));
    expect(status.body).toMatchObject({ status: 'SUCCEEDED', paidAt: '2026-11-06', receiptNumbers: ['MKB-000001'] });
    expect(status.body.paymentPageUrl).toBeUndefined();

    // Defter: tek postBatch (tazminat + tahsilat + makbuz + niyet durumu)
    expect(w.fin.batches).toHaveLength(1);
    const kinds = [...w.fin.transactions.values()].map((t) => [t.kind, t.totalAmount, t.reference]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['late_fee', TL(135), `LATE_FEE:PAY:${intentId}`],
        ['payment', TL(3135), 'FAKE:fakepay-1'],
      ]),
    );
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
    expect(w.fin.balanceOf('online-collection')).toBe(TL(3135));
    expect(w.fin.balanceOf('income-late-fee')).toBe(-TL(135));
    expect(w.fin.trialBalance()).toBe(0);

    const payment = [...w.fin.payments.values()][0]!;
    expect(payment).toMatchObject({
      method: 'card',
      amount: TL(3135),
      depositAccountId: 'online-collection',
      receiptNumber: 'MKB-000001',
      intentId,
      provider: 'fake',
      providerPaymentId: 'fakepay-1',
    });
    expect(w.events.published.filter((e) => e.type === 'PAYMENT_RECEIVED')).toHaveLength(1);

    // Portal ozeti: borc kapandi, islemis tazminat sifir.
    const summary = await w.call('GET', '/api/portal/my-summary', w.token('tenant-1'));
    expect(summary.body).toMatchObject({ debt: 0, accruedLateFee: 0, status: 'paid' });
  });

  it('cift sayim yok: odeme aninda yazilan tazminattan sonra aylik kesinlestirme yalnizca farki yazar', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(3000), '2026-10-10', 'c1');
    await w.finance.postLateFees(APT, { period: '2026-10', monthlyBasisPoints: 500, dueDayOfMonth: 10 }); // 105 TL
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.body.allocations[0]).toMatchObject({ principal: TL(3105), lateFee: TL(30), amount: TL(3135) });
    await w.payThroughProvider(created.body.intentId);

    // 1 Aralik: Kasim kesinlestirmesi. Anapara 6 Kasim'da kapandi; toplam tazminat 135 TL, hepsi yazili.
    w.clock.now = new Date('2026-12-01T00:00:00.000Z');
    const nov = await w.finance.postLateFees(APT, { period: '2026-11', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    expect(nov.count).toBe(0);
    const fees = [...w.fin.transactions.values()].filter((t) => t.kind === 'late_fee').reduce((s, t) => s + t.totalAmount, 0);
    expect(fees).toBe(TL(135));
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
  });

  it('niyet ile onay arasinda aylik kesinlestirme calistiysa tazminat ikinci kez yazilmaz (ust sinir)', async () => {
    const w = setup({ at: '2026-10-31T20:00:00.000Z' }); // Istanbul 31 Ekim 23:00
    await w.charge('u1', 'occupant', TL(3000), '2026-10-10', 'c1');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.body).toMatchObject({ amount: TL(3105), allocations: [{ lateFee: TL(105) }] });

    // 1 Kasim 02:30: Ekim tazminati (105 TL) zamanlanmis gorevle yazilir; callback sonra gelir.
    w.clock.now = new Date('2026-11-01T00:30:00.000Z');
    await w.finance.postLateFees(APT, { period: '2026-10', monthlyBasisPoints: 500, dueDayOfMonth: 10 });
    await w.payThroughProvider(created.body.intentId);

    const lateFees = [...w.fin.transactions.values()].filter((t) => t.kind === 'late_fee');
    expect(lateFees.map((t) => t.reference)).toEqual(['LATE_FEE:2026-10']); // odeme aninda ek kayit yok
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0); // 3000 + 105 - 3105
    expect(w.intentOf(created.body.intentId).status).toBe('SUCCEEDED');
  });

  it('secili kalem odemesi yalnizca anapara oder; tazminat islemeye devam eder', async () => {
    const w = setup();
    const a = (await w.charge('u1', 'occupant', TL(1000), '2026-09-10', 'c1', '2026-09-01')).transaction.transactionId;
    await w.charge('u1', 'occupant', TL(1000), '2026-10-10', 'c2');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'items',
      items: [{ liableParty: 'occupant', transactionId: a }],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ amount: TL(1000), allocations: [{ principal: TL(1000), lateFee: 0, transactionIds: [a] }] });
    await w.payThroughProvider(created.body.intentId);
    expect([...w.fin.transactions.values()].some((t) => t.kind === 'late_fee')).toBe(false);
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(TL(1000));
    const q = (await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'))).body;
    expect(q.parties[0].accruedLateFee).toBeGreaterThan(0);
  });

  it('kesintisiz olmayan secim 400 doner ve niyet olusmaz', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-09-10', 'c1', '2026-09-01');
    const b = (await w.charge('u1', 'occupant', TL(1000), '2026-10-10', 'c2')).transaction.transactionId;
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'items',
      items: [{ liableParty: 'occupant', transactionId: b }],
    });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'validation_error', field: 'items' });
    expect(w.payRepo.intents()).toHaveLength(0);
  });

  it('malik + oturan toplam odeme: iki makbuz, tek atomik yazim', async () => {
    const w = setup();
    await w.charge('u2', 'occupant', TL(500), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'owner', TL(2000), '2026-11-10', 'c2', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('owner-2'), { idempotencyKey: 'k-1', mode: 'total' });
    await w.payThroughProvider(created.body.intentId);
    const intent = w.intentOf(created.body.intentId);
    expect(intent).toMatchObject({ status: 'SUCCEEDED', receiptNumbers: ['MKB-000001', 'MKB-000002'] });
    expect(w.fin.batches).toHaveLength(1);
    expect(w.fin.batches[0]!.counter).toEqual({ name: 'receipt', expected: 0, increment: 2 });
    expect(w.fin.balanceOf('recv-u2-owner')).toBe(0);
    expect(w.fin.balanceOf('recv-u2-occupant')).toBe(0);
    expect(w.fin.balanceOf('online-collection')).toBe(TL(2500));
    expect(w.fin.trialBalance()).toBe(0);
  });

  it('basarisiz odeme: FAILED, defterde iz yok', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    const cb = await w.payThroughProvider(created.body.intentId, 'failure');
    expect(cb.status).toBe(303);
    const status = await w.call('GET', `/api/portal/payments/${created.body.intentId}`, w.token('tenant-1'));
    expect(status.body).toMatchObject({ status: 'FAILED', failureMessage: 'Kart reddedildi (sahte)' });
    expect(w.fin.batches).toHaveLength(0);
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(TL(1000));
  });
});

// ---------------------------------------------------------------------------
// Idempotency, yarislar, dogrulama
// ---------------------------------------------------------------------------

describe('odeme - idempotency ve dogrulama', () => {
  it('ayni idempotencyKey ayni niyeti dondurur; farkli istek 409', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const first = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    const again = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ intentId: first.body.intentId, paymentPageUrl: first.body.paymentPageUrl, replayed: true });
    expect(w.payRepo.intents()).toHaveLength(1);

    const tx = [...w.fin.transactions.values()][0]!.transactionId;
    const conflict = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'items',
      items: [{ liableParty: 'occupant', transactionId: tx }],
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('idempotency_conflict');
  });

  it('callback + tekrar callback + mutabakat: deftere tek yazim', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    await w.payThroughProvider(intentId);
    await w.payThroughProvider(intentId); // tarayici geri/yenile
    await w.call('GET', `/api/portal/payments/${intentId}?refresh=1`, w.token('tenant-1'));
    w.clock.now = new Date(w.clock.now.getTime() + 60 * 60_000);
    await w.payments.reconcile(APT);
    expect(w.fin.batches).toHaveLength(1);
    expect(w.fin.payments.size).toBe(1);
    expect(w.fin.balanceOf('online-collection')).toBe(TL(1000));
  });

  it('es zamanli sonuclandirma: niyet surumu degistiyse defter yazimi reddedilir (precondition)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success');
    const stale = structuredClone(w.intentOf(intentId));
    // Baska bir istek niyeti once FAILED yapmis olsun (surum ilerledi).
    await w.payRepo.repo.updateIntent({ ...stale, status: 'FAILED', version: stale.version + 1 }, stale.version);
    await expect(
      w.finance.recordOnlinePayment(
        { apartmentId: APT, userId: 'tenant-1' },
        {
          intentId,
          unitId: 'u1',
          paidAt: '2026-11-06',
          provider: 'fake',
          providerPaymentId: 'x',
          allocations: [{ liableParty: 'occupant', amount: toKurus(TL(1000)), lateFee: toKurus(0) }],
          intentUpdate: () => ({ item: { ...stale, version: stale.version + 1 }, expectedVersion: stale.version, label: 'intent' }),
        },
      ),
    ).rejects.toMatchObject({ name: 'LedgerConflictError', reason: 'precondition', label: 'intent' });
    expect(w.fin.batches).toHaveLength(0);
  });

  it.each([
    ['tutar', { paidAmount: 1 as Kurus }],
    ['sepet', { basketId: 'baska' }],
    ['conversationId', { conversationId: 'apt-2:x' }],
    ['para birimi', { currency: 'USD' }],
    ['fraud', { fraudApproved: false }],
  ])('saglayici basarili ama %s uyusmuyor: NEEDS_REVIEW + alarm, defter yok', async (_label, override) => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success', { override });
    const res = await w.call('GET', `/api/portal/payments/${intentId}?refresh=1`, w.token('tenant-1'));
    expect(res.body.status).toBe('NEEDS_REVIEW');
    expect(res.body.failureMessage).toMatch(/kontrol edilmesi gerekiyor/);
    expect(w.fin.batches).toHaveLength(0);
    expect(w.logs.some((l) => l.level === 'error' && l.fields?.alert === 'PAYMENT_NEEDS_REVIEW')).toBe(true);
  });

  it('callback: token niyetle eslesmezse saglayici sorgulanmaz ve durum degismez', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success');
    const res = await w.app.request(`/api/payments/fake/callback?ref=${APT}:${intentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=fake_baska',
    });
    expect(res.status).toBe(303);
    expect(w.intentOf(intentId).status).toBe('PENDING');
    expect(w.logs.some((l) => l.message.includes('token niyetle eslesmiyor'))).toBe(true);
  });

  it.each([
    ['ref yok', '/api/payments/fake/callback', 'token=x', 'error=invalid'],
    ['bozuk ref', '/api/payments/fake/callback?ref=apt-1', 'token=x', 'error=invalid'],
    ['bilinmeyen saglayici', '/api/payments/iyzico/callback?ref=apt-1:20261106100000-id1', 'token=x', 'error=invalid'],
    ['olmayan niyet', '/api/payments/fake/callback?ref=apt-1:20261106100000-yok', 'token=x', 'error=not_found'],
    ['token yok', '/api/payments/fake/callback?ref=apt-1:20261106100000-id1', '', 'error=invalid'],
  ])('callback: %s -> web uygulamasina hata ile yonlenir', async (_label, path, body, query) => {
    const w = setup();
    const res = await w.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://web.test/portal/odeme/sonuc?${query}`);
  });

  it('gecersiz TCKN 400; gecerli TCKN sandbox saglayicida test numarasiyla degisir ve hic saklanmaz', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const bad = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-0', mode: 'total', identityNumber: '0123' });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe('identityNumber');
    const ok = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'total',
      identityNumber: '12345678950',
    });
    expect(ok.status).toBe(201);
    expect(w.fake.sessions.get(`fake_${ok.body.intentId}`)!.request.buyer.identityNumber).toBe('11111111111');
    expect(JSON.stringify([...w.fin.docs.values()])).not.toContain('12345678950');
  });

  it('saglayici kesintisi: 502 ve niyet FAILED (tekrar denemede yeni anahtar gerekir)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    w.fake.failNextCheckout();
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('provider_unavailable');
    expect(w.payRepo.intents()[0]).toMatchObject({ status: 'FAILED', failure: { code: 'unavailable' } });
  });

  it('borc yoksa 422 no_debt; online odeme kapaliysa 422 payments_disabled', async () => {
    const w = setup();
    const none = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(none).toMatchObject({ status: 422, body: { error: 'no_debt' } });

    const off = setup({ provider: false });
    await off.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const q = await off.call('GET', '/api/portal/payments/quote', off.token('tenant-1'));
    expect(q.body).toMatchObject({ onlinePaymentEnabled: false, totalDue: TL(1000) });
    const res = await off.call('POST', '/api/portal/payments', off.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res).toMatchObject({ status: 422, body: { error: 'payments_disabled' } });
  });

  it('pasif alt uye hesabi: online odeme kapali', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const account: PaymentAccount = {
      ...paymentKeys.account(APT, 'fake'),
      entityType: 'PAYMENT_ACCOUNT',
      apartmentId: APT,
      provider: 'fake',
      subMerchantKey: 'sm-1',
      subMerchantType: 'PRIVATE_COMPANY',
      status: 'disabled',
      platformFeeBasisPoints: 0,
      ...audit,
    };
    await w.payRepo.repo.putAccount(account);
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res).toMatchObject({ status: 422, body: { error: 'payments_disabled' } });

    await w.payRepo.repo.putAccount({ ...account, status: 'active', platformFeeBasisPoints: 200, version: 2 }, 1);
    const ok = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-2', mode: 'total' });
    expect(ok.status).toBe(201);
    const intent = w.intentOf(ok.body.intentId);
    expect(intent).toMatchObject({ subMerchantKey: 'sm-1', platformFee: TL(20), allocations: [{ subMerchantPrice: TL(980) }] });
  });
});

// ---------------------------------------------------------------------------
// Erisim ve tenant izolasyonu
// ---------------------------------------------------------------------------

describe('odeme - erisim kontrolu', () => {
  it('token yoksa 401; sakin olmayan rol 403', async () => {
    const w = setup();
    expect((await w.call('GET', '/api/portal/payments/quote')).status).toBe(401);
    expect((await w.call('GET', '/api/portal/payments/quote', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);
    expect((await w.call('POST', '/api/portal/payments', w.token('mgr-1', 'apartment_manager'), { idempotencyKey: 'k', mode: 'total' })).status).toBe(403);
  });

  it('baskasinin veya baska apartmanin niyeti 404 (varligi sizdirilmaz)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    expect((await w.call('GET', `/api/portal/payments/${intentId}`, w.token('owner-2'))).status).toBe(404);
    expect((await w.call('GET', `/api/portal/payments/${intentId}`, w.token('foreign', 'resident', OTHER_APT))).status).toBe(404);
    expect((await w.call('GET', `/api/portal/payments/${intentId}`, w.token('tenant-1'))).status).toBe(200);
  });

  it('baskasinin dairesi icin odeme baslatilamaz (portal uyelik kurali)', async () => {
    const w = setup();
    await w.charge('u2', 'owner', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total', unitId: 'u2' });
    expect(res.status).toBe(403);
    expect(w.payRepo.intents()).toHaveLength(0);
  });

  it('callback ref ile baska apartmanin niyeti hedeflenemez (token/conversation uyusmaz)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success');
    const res = await w.app.request(`/api/payments/fake/callback?ref=${OTHER_APT}:${intentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=fake_${intentId}`,
    });
    expect(res.headers.get('location')).toContain('error=not_found');
    expect(w.intentOf(intentId).status).toBe('PENDING');
  });
});

// ---------------------------------------------------------------------------
// Mutabakat
// ---------------------------------------------------------------------------

describe('odeme - mutabakat', () => {
  it('kaybolan callback: 30 dk sonra saglayicidan sorgulanip yazilir', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success', { paidAt: '2026-11-06' });

    w.clock.now = new Date('2026-11-06T10:20:00.000Z'); // 20 dk: henuz kapsam disi
    expect(await w.payments.reconcile(APT)).toMatchObject({ checked: 0 });

    w.clock.now = new Date('2026-11-06T10:31:00.000Z');
    expect(await w.payments.reconcile(APT)).toEqual({ checked: 1, succeeded: 1, failed: 0, review: 0, stillPending: 0 });
    expect(w.intentOf(intentId)).toMatchObject({ status: 'SUCCEEDED', paidAt: '2026-11-06' });
  });

  it('saglayici erisilemezse niyet PENDING kalir; 24 saat sonra hala pending ise FAILED (expired)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;

    w.clock.now = new Date('2026-11-06T11:00:00.000Z');
    w.fake.failNextRetrieve();
    expect(await w.payments.reconcile(APT)).toMatchObject({ checked: 1, stillPending: 1 });

    w.clock.now = new Date('2026-11-07T10:01:00.000Z');
    expect(await w.payments.reconcile(APT)).toMatchObject({ checked: 1, failed: 1 });
    expect(w.intentOf(intentId)).toMatchObject({ status: 'FAILED', failure: { code: 'expired' } });
  });

  it('suresi gecmis ama saglayici basarili diyorsa yine yazilir (para tahsil edilmis)', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.complete(`fake_${intentId}`, 'success');
    w.clock.now = new Date('2026-11-06T22:00:00.000Z'); // expiresAt (10:30) cok gecti
    await w.payments.reconcile(APT);
    expect(w.intentOf(intentId).status).toBe('SUCCEEDED');
  });

  it('utcStamp siralanabilir 14 hane uretir', () => {
    expect(utcStamp(new Date('2026-11-06T10:00:00.123Z'))).toBe('20261106100000');
  });
});

// ---------------------------------------------------------------------------
// Yapilandirma
// ---------------------------------------------------------------------------

describe('odeme - yapilandirma', () => {
  it('saglayici tanimsizsa kapali; fake production`da reddedilir; https zorunlu', () => {
    expect(loadPaymentsConfig({}).provider).toBeUndefined();
    expect(loadPaymentsConfig({ PAYMENTS_PROVIDER: 'disabled' }).provider).toBeUndefined();
    const local = loadPaymentsConfig({
      PAYMENTS_PROVIDER: 'fake',
      PAYMENTS_API_BASE_URL: 'http://localhost:3000/',
      WEB_APP_URL: 'http://localhost:5173',
    });
    expect(local.provider?.name).toBe('fake');
    expect(local.apiBaseUrl).toBe('http://localhost:3000');
    expect(() =>
      loadPaymentsConfig({ PAYMENTS_PROVIDER: 'fake', NODE_ENV: 'production', PAYMENTS_API_BASE_URL: 'https://a.b', WEB_APP_URL: 'https://c.d' }),
    ).toThrow(/production/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDER: 'fake', PAYMENTS_API_BASE_URL: 'http://evil.example', WEB_APP_URL: 'https://c.d' })).toThrow(/https/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDER: 'fake', WEB_APP_URL: 'https://c.d' })).toThrow(/PAYMENTS_API_BASE_URL/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDER: 'paypal' })).toThrow(/Bilinmeyen/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDER: 'fake', PAYMENTS_INTENT_TTL_MINUTES: '1' })).toThrow(/TTL/);
  });
});

// ---------------------------------------------------------------------------
// DynamoDB depolari (aws-sdk-client-mock)
// ---------------------------------------------------------------------------

describe('finans deposu - postBatch', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createFinanceRepository();
  const meta = { $metadata: {} };

  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const tx = (id: string, lines: Transaction['lines'], kind: Transaction['kind'] = 'payment'): Transaction => ({
    ...financeKeys.transaction(APT, id),
    entityType: 'TRANSACTION',
    transactionId: id,
    siteId: APT,
    kind,
    date: '2026-11-06',
    description: 't',
    lines,
    totalAmount: toKurus(lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)),
    createdAt: '2026-11-06T10:00:00.000Z',
    createdBy: 'u',
  });
  const fee = tx('20261106-a', [
    { accountId: 'recv-u1-occupant', side: 'debit', amount: toKurus(500) },
    { accountId: 'income-late-fee', side: 'credit', amount: toKurus(500) },
  ], 'late_fee');
  const pay = tx('20261106-b', [
    { accountId: 'online-collection', side: 'debit', amount: toKurus(10_500) },
    { accountId: 'recv-u1-occupant', side: 'credit', amount: toKurus(10_500) },
  ]);
  const intent = { PK: `APT#${APT}`, SK: 'PI#x', version: 3, status: 'SUCCEEDED' };

  it('ayni hesap tek Update ile birlesik delta alir; sayac N artar; niyet surum kosullu yazilir', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await repo.postBatch({
      transactions: [fee, pay],
      idempotency: { id: 'pay-x', fingerprint: 'fp', transactionIds: ['20261106-a', '20261106-b'], recordIds: ['p1'] },
      counter: { name: 'receipt', expected: 7, increment: 2 },
      records: [{ PK: `APT#${APT}`, SK: 'PAY#p1', entityType: 'PAYMENT' } as never],
      replaceRecords: [{ item: intent, expectedVersion: 2, label: 'intent' }],
    });
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    // idem + 2x(tx + 2 satir) + 3 hesap + sayac + makbuz + niyet
    expect(items).toHaveLength(1 + 6 + 3 + 1 + 1 + 1);
    expect(items[0]!.Put!.Item).toMatchObject({ SK: 'IDEM#pay-x', transactionIds: ['20261106-a', '20261106-b'], recordIds: ['p1'] });
    const updates = items.filter((i) => i.Update?.Key?.SK?.toString().startsWith('ACCT#')).map((i) => [i.Update!.Key!.SK, i.Update!.ExpressionAttributeValues![':delta']]);
    expect(updates).toEqual([
      ['ACCT#recv-u1-occupant', 500 - 10_500],
      ['ACCT#income-late-fee', -500],
      ['ACCT#online-collection', 10_500],
    ]);
    const counter = items.find((i) => i.Update?.Key?.SK === 'CTR#receipt')!.Update!;
    expect(counter.ExpressionAttributeValues).toMatchObject({ ':next': 9, ':expected': 7 });
    const last = items.at(-1)!.Put!;
    expect(last.Item).toEqual(intent);
    expect(last.ConditionExpression).toBe('attribute_exists(PK) AND #version = :expectedVersion');
    expect(last.ExpressionAttributeValues).toEqual({ ':expectedVersion': 2 });
  });

  it('surumlu belge kosulu tutmazsa LedgerConflictError(precondition, label)', async () => {
    const reasons = Array.from({ length: 12 }, () => ({ Code: 'None' }));
    reasons[11] = { Code: 'ConditionalCheckFailed' };
    ddbMock.on(TransactWriteCommand).rejects(new TransactionCanceledException({ message: 'x', CancellationReasons: reasons, ...meta }));
    const err = await repo
      .postBatch({
        transactions: [fee, pay],
        idempotency: { id: 'pay-x', fingerprint: 'fp' },
        counter: { name: 'receipt', expected: 7, increment: 2 },
        replaceRecords: [{ item: intent, expectedVersion: 2, label: 'intent' }],
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LedgerConflictError);
    expect(err).toMatchObject({ reason: 'precondition', label: 'intent' });
  });

  it('programlama hatalarini DynamoDB cagrisi yapmadan reddeder', async () => {
    const idempotency = { id: 'k', fingerprint: 'fp' };
    await expect(repo.postBatch({ transactions: [], idempotency })).rejects.toThrow(/En az bir/);
    await expect(repo.postBatch({ transactions: [pay, pay], idempotency })).rejects.toThrow(/iki kez/);
    await expect(repo.postBatch({ transactions: [pay, { ...fee, siteId: OTHER_APT }], idempotency })).rejects.toThrow(/tenant/);
    await expect(
      repo.postBatch({ transactions: [pay], idempotency, replaceRecords: [{ item: intent, expectedVersion: 3, label: 'i' }] }),
    ).rejects.toThrow(/bir artirilmali/);
    await expect(
      repo.postBatch({ transactions: [pay], idempotency, replaceRecords: [{ item: { ...intent, PK: 'APT#apt-2' }, expectedVersion: 2, label: 'i' }] }),
    ).rejects.toThrow(/tenant/);
    await expect(repo.postBatch({ transactions: [pay], idempotency, counter: { name: 'receipt', expected: 0, increment: 0 } })).rejects.toThrow(/sayac/);
    const many = Array.from({ length: 34 }, (_, i) => tx(`20261106-m${i}`, pay.lines));
    await expect(repo.postBatch({ transactions: many, idempotency })).rejects.toThrow(/100/);
    expect(ddbMock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });
});

describe('odeme deposu (DynamoDB)', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createPaymentsRepository();
  const meta = { $metadata: {} };

  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const intent = {
    ...paymentKeys.intent(APT, '20261106100000-a'),
    entityType: 'PAYMENT_INTENT',
    intentId: '20261106100000-a',
    apartmentId: APT,
    version: 1,
  } as unknown as PaymentIntent;
  const key = { ...paymentKeys.intentKey(APT, 'user-1', 'k-1'), entityType: 'PAYMENT_INTENT_KEY' as const, intentId: 'x', fingerprint: 'fp', createdAt: 't' };

  it('niyet + anahtar tek atomik yazim; varsa PaymentsConflictError', async () => {
    ddbMock.on(TransactWriteCommand).resolves({});
    await repo.createIntent(intent, key);
    const items = ddbMock.commandCalls(TransactWriteCommand)[0]!.args[0].input.TransactItems!;
    expect(items.map((i) => [i.Put!.Item!.SK, i.Put!.ConditionExpression])).toEqual([
      ['PIKEY#user-1#k-1', 'attribute_not_exists(PK)'],
      ['PI#20261106100000-a', 'attribute_not_exists(PK)'],
    ]);

    ddbMock.on(TransactWriteCommand).rejects(
      new TransactionCanceledException({ message: 'x', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }], ...meta }),
    );
    await expect(repo.createIntent(intent, key)).rejects.toBeInstanceOf(PaymentsConflictError);
    await expect(repo.createIntent(intent, { ...key, PK: 'APT#apt-2' })).rejects.toThrow(/ayni tenant/);
  });

  it('zaman araligi sorgusu SK BETWEEN ile ve yalnizca tenant niyetleri', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [intent, { ...intent, apartmentId: 'apt-2' }, { PK: 'x', entityType: 'OTHER' }] });
    const out = await repo.listIntentsBetween(APT, '20261030000000', '20261106093000~');
    expect(out).toHaveLength(1);
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'APT#apt-1', ':lo': 'PI#20261030000000', ':hi': 'PI#20261106093000~' });
  });
});
