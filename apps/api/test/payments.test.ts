import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import type { Role } from '../src/auth/claims.js';
import { resetDynamoCache } from '../src/config/dynamodb.js';
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
  InvalidIntentCursorError,
  PaymentsConflictError,
  createPaymentsRepository,
  paymentKeys,
  toStoredIntent,
} from '../src/modules/payments/repository.js';
import { createPaymentsService, payoutReleaseAfter, utcStamp } from '../src/modules/payments/service.js';
import type { PaymentAccount, PaymentIntent, PaymentProviderName } from '../src/modules/payments/types.js';
import { createProviderRegistry, resolveProvider } from '../src/modules/payments/registry.js';
import { type PayeeVault, createLocalPayeeVault } from '../src/modules/payments/payee.js';
import { createPayoutService } from '../src/modules/payments/payouts.js';
import { createInvoiceService } from '../src/modules/payments/invoices.js';
import { createPaytrClient, notificationHash, paytrHash, paytrToken } from '../src/modules/payments/paytr/client.js';
import { createPaytrProvider, paytrMerchantOid } from '../src/modules/payments/paytr/provider.js';
import { type PaymentProvider, PaymentProviderError } from '../src/modules/payments/provider.js';
import { createIyzicoClient, hmacHex, responseSignature, signaturePrice } from '../src/modules/payments/iyzico/client.js';
import { IYZICO_PATHS, createIyzicoProvider } from '../src/modules/payments/iyzico/provider.js';
import { type Person, personKeys } from '../src/modules/residents/repository.js';
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

const person = (userId: string, fullName: string, email: string, apt = APT): Person => ({
  ...personKeys.person(apt, userId),
  entityType: 'PERSON',
  ...audit,
  apartmentId: apt,
  userId,
  fullName,
  email,
});

function setup(
  options: {
    provider?: boolean | 'live';
    at?: string;
    customProvider?: PaymentProvider;
    /** P2: birden fazla saglayici (sahte saglayici `fake` her zaman eklenir) + varsayilan. */
    extraProviders?: PaymentProvider[];
    defaultProvider?: PaymentProviderName;
    /** P4: transfer gonderimi (`send`: zamanlanmis worker gibi). */
    payoutMode?: 'send' | 'defer';
    /** P4: alici kasasi (varsayilan bellek ici; `false` = yok). */
    vault?: PayeeVault | false;
  } = {},
) {
  const clock = { now: new Date(options.at ?? '2026-11-06T10:00:00.000Z') }; // Istanbul 13:00
  const units = [unit('u1'), unit('u2'), unit('x1', OTHER_APT)];
  const memberships = [
    member('tenant-1', 'u1', 'tenant'),
    member('owner-2', 'u2', 'owner', { residesInUnit: true }), // malik + oturan: iki alt cari
    member('foreign', 'x1', 'tenant', { apartmentId: OTHER_APT }),
  ];
  const fin = createFakeFinanceRepo(APT);
  const payRepo = createFakePaymentsRepo(fin.docs as never);
  let n = 0;
  const newId = () => `id${String(++n).padStart(4, '0')}`;
  const now = () => clock.now;

  const core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getBlock' | 'getSite' | 'listSiteIds'> = {
    listSiteIds: async () => [APT, 'apt-yok'],
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

  const finance = createFinanceService({ repository: fin.repo, core, now, newId });
  const portal = createPortalService({ repository: portalRepo, core, now });
  const fake = createFakePaymentProvider({ apiBaseUrl: 'https://api.test' });
  const people = [person('tenant-1', 'Ayşe Nur Yılmaz', 'ayse@example.com'), person('owner-2', 'Mehmet Kaya', 'mehmet@example.com')];
  // Canli (sandbox olmayan) saglayici davranisi: ayni sahte oturumlar, sandbox=false.
  const provider: PaymentProvider | undefined =
    options.customProvider ?? (options.provider === false ? undefined : options.provider === 'live' ? { ...fake, sandbox: false } : fake);
  const logs: { level: string; message: string; fields?: Record<string, unknown> }[] = [];
  const vault = options.vault === false ? undefined : (options.vault ?? createLocalPayeeVault());
  const log = (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => logs.push({ level, message, fields });
  const payments = createPaymentsService({
    repository: payRepo.repo,
    portal,
    ledger: portalRepo,
    finance,
    people: { get: async (apt, userId) => people.find((p) => p.apartmentId === apt && p.userId === userId) },
    core,
    ...(options.extraProviders
      ? { providers: createProviderRegistry([fake, ...options.extraProviders], options.defaultProvider) }
      : { provider }),
    ...(vault ? { vault } : {}),
    ...(options.payoutMode ? { payoutMode: options.payoutMode } : {}),
    apiBaseUrl: 'https://api.test',
    webAppUrl: 'https://web.test',
    now,
    newId,
    log,
  });
  const registry = payments.providers;
  const payouts = createPayoutService({ repository: payRepo.repo, providers: registry, ...(vault ? { vault } : {}), core, now, log });
  const invoices = createInvoiceService({ repository: payRepo.repo, core, settings: { mode: 'monthly', vatRateBasisPoints: 2000, vatMode: 'exclusive' }, now, log });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    financeService: finance,
    portalService: portal,
    paymentsService: payments,
    payoutService: payouts,
    invoiceService: invoices,
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

  return { clock, app, call, token, fin, payRepo, finance, portal, payments, payouts, invoices, vault, fake, logs, charge, cashPayment, payThroughProvider, intentOf, portalRepo, people };
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
      { liableParty: 'occupant', principal: TL(1600), lateFee: 0, amount: TL(1600), subMerchantPrice: TL(1600), platformFee: 0, posEstimate: 0, transactionIds: [a, b] },
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
      buyer: {
        id: 'tenant-1',
        identityNumber: '11111111111',
        ip: '203.0.113.7',
        name: 'Ayşe Nur',
        surname: 'Yılmaz',
        email: 'ayse@example.com',
        gsmNumber: '+905350000000',
        address: 'x, Kadikoy',
        city: 'Istanbul',
      },
      items: [{ id: `${intentId}-occupant`, amount: TL(3135), subMerchantKey: 'fake-submerchant', subMerchantPrice: TL(3135) }],
    });

    // Sahte odeme sayfasi
    const pageRes = await w.app.request(`/api/payments/fake/checkout?token=fake_${intentId}`);
    expect(pageRes.status).toBe(200);
    expect(await pageRes.text()).toContain('3.135,00 TL');

    const cb = await w.payThroughProvider(intentId);
    expect(cb.status).toBe(303);
    expect(cb.headers.get('location')).toBe(`https://web.test/app/odeme/sonuc?intent=${intentId}`);

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
    // Olay, tahsilat + niyet durum gecisiyle ayni atomik yazimda outbox'ta.
    const received = w.fin.events('PAYMENT_RECEIVED');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ eventId: `PAYMENT_RECEIVED:${payment.paymentId}`, payload: { paymentId: payment.paymentId, method: 'card' } });
    expect(w.fin.batches.at(-1)!.outbox!.map((e) => e.eventId)).toEqual([`PAYMENT_RECEIVED:${payment.paymentId}`]);

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
    expect(res.headers.get('location')).toBe(`https://web.test/app/odeme/sonuc?${query}`);
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
    expect(await w.payments.reconcile(APT)).toEqual({
      checked: 1,
      succeeded: 1,
      failed: 0,
      review: 0,
      stillPending: 0,
      // Bu turda sonuclanan niyetin onayi ayni turda gonderildi; ikinci kez denenmez.
      approvals: { checked: 0, approved: 0, pending: 0, failed: 0 },
    });
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
    expect(loadPaymentsConfig({}).providers.list()).toEqual([]);
    expect(loadPaymentsConfig({ PAYMENTS_PROVIDER: 'disabled' }).providers.defaultName).toBeUndefined();
    const local = loadPaymentsConfig({
      PAYMENTS_PROVIDER: 'fake',
      PAYMENTS_API_BASE_URL: 'http://localhost:3000/',
      WEB_APP_URL: 'http://localhost:5173',
    });
    // Eski tekil PAYMENTS_PROVIDER hala okunur: tek saglayici = varsayilan.
    expect(local.providers.defaultName).toBe('fake');
    expect(local.fake).toBe(local.providers.get('fake'));
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

// ---------------------------------------------------------------------------
// Adim 8b-2: alici bilgisi, iyzico saglayicisi (sahte HTTP), webhook, alt uye isyeri
// ---------------------------------------------------------------------------

describe('odeme - alici bilgisi (Karar C)', () => {
  it('canli saglayicida: telefon zorunlu ve normalize edilir; TCKN/telefon saklanmaz', async () => {
    const w = setup({ provider: 'live' });
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const noGsm = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-0', mode: 'total' });
    expect(noGsm).toMatchObject({ status: 400, body: { field: 'gsmNumber' } });
    const badGsm = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-0', mode: 'total', gsmNumber: '0212 000 00 00' });
    expect(badGsm).toMatchObject({ status: 400, body: { field: 'gsmNumber' } });
    expect(w.payRepo.intents()).toHaveLength(0); // yarim niyet olusmadi

    const ok = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'total',
      identityNumber: '12345678950',
      gsmNumber: '0532 123 45 67',
    });
    expect(ok.status).toBe(201);
    const buyer = w.fake.sessions.get(`fake_${ok.body.intentId}`)!.request.buyer;
    expect(buyer).toMatchObject({ identityNumber: '12345678950', gsmNumber: '+905321234567', email: 'ayse@example.com' });
    const stored = JSON.stringify([...w.fin.docs.values()]);
    expect(stored).not.toContain('12345678950');
    expect(stored).not.toContain('5321234567');
  });

  it('canli saglayicida sakin dizini kaydi yoksa 422 profile_incomplete', async () => {
    const w = setup({ provider: 'live' });
    w.people.length = 0;
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total', gsmNumber: '05321234567' });
    expect(res).toMatchObject({ status: 422, body: { error: 'profile_incomplete' } });
    expect(w.payRepo.intents()).toHaveLength(0);
  });
});

/** iyzico API'sini taklit eden sahte fetch: baslatilan oturumlari hatirlar, imzali yanit doner. */
function fakeIyzicoServer(secretKey: string) {
  const sessions = new Map<string, { body: Record<string, any>; paid?: boolean; paidPrice?: string }>();
  const refunds: Record<string, any>[] = [];
  const approvals: Record<string, any>[] = [];
  let n = 0;
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, any>;
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const items = (token: string, s: { body: Record<string, any> }) =>
      (s.body.basketItems as Record<string, any>[]).map((it, i) => ({
        itemId: it.id,
        paymentTransactionId: `ptx-${token}-${i + 1}`,
        price: it.price,
        paidPrice: it.price,
        // iyzico komisyonu (kalem bazli; kurus alti ondalik tasiyabilir)
        iyziCommissionRateAmount: '24.9',
        iyziCommissionFee: '0.250000',
      }));
    if (path === IYZICO_PATHS.initialize) {
      const token = `iyz-tok-${++n}`;
      sessions.set(token, { body });
      return json({ status: 'success', conversationId: body.conversationId, token, paymentPageUrl: `https://sandbox-cpp.iyzipay.com?token=${token}`, signature: responseSignature(secretKey, [body.conversationId, token]) });
    }
    if (path === IYZICO_PATHS.retrieve) {
      const s = sessions.get(body.token);
      if (!s?.paid) return json({ status: 'success', paymentStatus: 'INIT_THREEDS', token: body.token });
      const r = { paymentStatus: 'SUCCESS', paymentId: `pay-${body.token}`, currency: 'TRY', basketId: s.body.basketId, conversationId: s.body.conversationId, paidPrice: s.paidPrice ?? s.body.paidPrice, price: s.body.price, token: body.token };
      const signature = responseSignature(secretKey, [r.paymentStatus, r.paymentId, r.currency, r.basketId, r.conversationId, signaturePrice(r.paidPrice), signaturePrice(r.price), r.token]);
      return json({ status: 'success', fraudStatus: 1, ...r, signature, itemTransactions: items(body.token, s) });
    }
    if (path === IYZICO_PATHS.refund) {
      refunds.push(body);
      return json({ status: 'success', conversationId: body.conversationId, paymentTransactionId: body.paymentTransactionId, price: Number(body.price), currency: 'TRY', refundHostReference: `rf-${refunds.length}` });
    }
    if (path === IYZICO_PATHS.paymentDetails && init?.method === 'GET') {
      const token = (url.searchParams.get('paymentId') ?? '').replace(/^pay-/, '');
      const s = sessions.get(token);
      if (!s) return json({ status: 'failure', errorCode: '5000', errorMessage: 'yok' });
      return json({
        status: 'success',
        payments: [
          {
            paymentId: `pay-${token}`,
            itemTransactions: items(token, s).map((t) => ({
              ...t,
              refunds: refunds.filter((r) => r.paymentTransactionId === t.paymentTransactionId).map((r) => ({ refundPrice: Number(r.price), refundStatus: 1 })),
            })),
          },
        ],
      });
    }
    if (path === '/onboarding/submerchant') return json({ status: 'success', subMerchantKey: `smk-${body.subMerchantExternalId}` });
    if (path === IYZICO_PATHS.approve) {
      approvals.push(body);
      return json({ status: 'success', conversationId: body.conversationId, paymentTransactionId: body.paymentTransactionId });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, sessions, refunds, approvals };
}

describe('odeme - iyzico saglayicisi ile uctan uca (sahte HTTP)', () => {
  const SECRET = 'sandbox-secret';
  function iyzicoWorld() {
    const server = fakeIyzicoServer(SECRET);
    const client = createIyzicoClient({ baseUrl: 'https://sandbox-api.iyzipay.com', credentials: async () => ({ apiKey: 'k', secretKey: SECRET }), fetch: server.fetchFn });
    const w = setup({ customProvider: createIyzicoProvider({ client, sandbox: true, now: () => new Date('2026-11-06T10:00:00Z') }) });
    return { w, server };
  }
  const webhookSig = (b: Record<string, unknown>) =>
    hmacHex(SECRET, `${SECRET}${b.iyziEventType}${b.iyziPaymentId}${b.token}${b.paymentConversationId}${b.status}`);

  it('alt uye kaydi -> niyet -> imzali webhook -> saglayici sorgusu -> defter', async () => {
    const { w, server } = iyzicoWorld();
    const admin = w.token('ops-1', 'platform_admin', '');
    const onboard = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, {
      email: 'yonetim@lale.test',
      gsmNumber: '0532 123 45 67',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR33 0006 1005 1978 6457 8413 26',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
      platformFeeBasisPoints: 100,
    });
    expect(onboard.status).toBe(201);
    expect(onboard.body).toMatchObject({ subMerchantKey: `smk-${APT}`, subMerchantType: 'PRIVATE_COMPANY', status: 'active', ibanMasked: 'TR** **** **** **** **** **13 26' });

    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.status).toBe(201);
    expect(created.body.paymentPageUrl).toBe('https://sandbox-cpp.iyzipay.com?token=iyz-tok-1');
    const init = server.sessions.get('iyz-tok-1')!.body;
    expect(init.basketItems[0]).toMatchObject({ price: '1000.00', subMerchantKey: `smk-${APT}`, subMerchantPrice: '990.00' });

    // Kullanici 3DS'i tamamladi; callback kayboldu, webhook geldi.
    server.sessions.get('iyz-tok-1')!.paid = true;
    const hook = { paymentConversationId: `${APT}:${created.body.intentId}`, token: 'iyz-tok-1', status: 'SUCCESS', iyziEventType: 'CHECKOUT_FORM_AUTH', iyziPaymentId: 1 };
    const bad = await w.app.request('/api/payments/iyzico/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-IYZ-SIGNATURE-V3': '00' },
      body: JSON.stringify(hook),
    });
    expect(bad.status).toBe(401);
    expect(w.intentOf(created.body.intentId).status).toBe('PENDING');

    const good = await w.app.request('/api/payments/iyzico/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-IYZ-SIGNATURE-V3': webhookSig(hook) },
      body: JSON.stringify(hook),
    });
    expect(good.status).toBe(200);
    expect(w.intentOf(created.body.intentId)).toMatchObject({ status: 'SUCCEEDED', providerPaymentId: 'pay-iyz-tok-1', platformFee: TL(10) });
    // Pazaryeri onayi (Online Odeme v2 · P1): kalem bazli gonderildi; gercek komisyon mutabakatta.
    expect(server.approvals).toEqual([
      { locale: 'tr', conversationId: `approve:${created.body.intentId}:${created.body.intentId}-occupant`, paymentTransactionId: 'ptx-iyz-tok-1-1' },
    ]);
    expect(w.intentOf(created.body.intentId).settlement).toMatchObject({
      status: 'approved',
      commission: TL(10),
      subMerchantTotal: TL(990),
      providerFee: 2_515, // 24,90 + 0,25
      posFeeDrift: -2_515, // POS orani tanimsiz (0): komisyonu bu ortamda platform karsiladi
      approvals: [{ paymentTransactionId: 'ptx-iyz-tok-1-1', status: 'approved', attempts: 1 }],
    });
    // Platform payi apartmanin gideri: online tahsilat hesabinda aktarilacak tutar kalir.
    expect(w.fin.balanceOf('online-collection')).toBe(TL(990));
    expect(w.fin.balanceOf('exp-online-collection-fee')).toBe(TL(10));
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
    expect([...w.fin.payments.values()][0]).toMatchObject({ provider: 'iyzico', providerPaymentId: 'pay-iyz-tok-1', method: 'card' });

    // Ayni webhook tekrar: deftere ikinci yazim yok.
    await w.app.request('/api/payments/iyzico/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-IYZ-SIGNATURE-V3': webhookSig(hook) },
      body: JSON.stringify(hook),
    });
    expect(w.fin.batches).toHaveLength(1);
  });

  it('3DS tamamlanmadan gelen callback niyeti PENDING birakir', async () => {
    const { w } = iyzicoWorld();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    await w.payRepo.repo.putAccount({ ...paymentKeys.account(APT, 'iyzico'), entityType: 'PAYMENT_ACCOUNT', apartmentId: APT, provider: 'iyzico', subMerchantKey: 'smk', subMerchantType: 'PRIVATE_COMPANY', status: 'active', platformFeeBasisPoints: 0, ...audit });
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    const cb = await w.app.request(`/api/payments/iyzico/callback?ref=${APT}:${intentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=iyz-tok-1',
    });
    expect(cb.status).toBe(303);
    expect(w.intentOf(intentId).status).toBe('PENDING');
  });

  it('inceleme -> tam iade: kalem bazli /payment/refund, raporlamadan iade tutari okunur', async () => {
    const { w, server } = iyzicoWorld();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    await w.payRepo.repo.putAccount({ ...paymentKeys.account(APT, 'iyzico'), entityType: 'PAYMENT_ACCOUNT', apartmentId: APT, provider: 'iyzico', subMerchantKey: 'smk', subMerchantType: 'PRIVATE_COMPANY', status: 'active', platformFeeBasisPoints: 0, ...audit });
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    // Saglayicinin bildirdigi tutar niyetten farkli -> inceleme.
    Object.assign(server.sessions.get('iyz-tok-1')!, { paid: true, paidPrice: '999.00' });
    await w.app.request(`/api/payments/iyzico/callback?ref=${APT}:${intentId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=iyz-tok-1',
    });
    expect(w.intentOf(intentId)).toMatchObject({
      status: 'NEEDS_REVIEW',
      itemTransactions: [{ itemId: `${intentId}-occupant`, paymentTransactionId: 'ptx-iyz-tok-1-1', paidAmount: TL(1000) }],
    });

    const ops = w.token('ops-1', 'platform_admin', '');
    const r = await w.call('POST', `/api/admin/payments/apartments/${APT}/intents/${intentId}/resolve`, ops, {
      action: 'refund',
      note: 'Tutar uyuşmazlığı, tam iade',
      expectedVersion: w.intentOf(intentId).version,
    });
    expect(r.status).toBe(200);
    expect(r.body.intent).toMatchObject({ status: 'REFUNDED', refundedAmount: TL(1000) });
    expect(server.refunds).toEqual([
      { locale: 'tr', conversationId: `refund-${intentId}-1`, paymentTransactionId: 'ptx-iyz-tok-1-1', price: '1000.00', currency: 'TRY', ip: '203.0.113.7' },
    ]);
    expect(r.body.intent.refund.items[0]).toMatchObject({ providerRefundId: 'rf-1' });
    expect(w.fin.batches).toHaveLength(0);

    // Raporlama: kalem bazinda iade edilen tutar.
    const provider = w.payments.providers.get('iyzico')!;
    expect(await provider.refundedAmounts({ providerPaymentId: 'pay-iyz-tok-1', conversationId: `${APT}:${intentId}`, items: [] })).toEqual(new Map([['ptx-iyz-tok-1-1', TL(1000)]]));
  });

  it('iyzico saglayicisinda alt uye kaydi yoksa online odeme kapali (varsayilan hesap yalnizca sahte saglayicida)', async () => {
    const { w } = iyzicoWorld();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const q = await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'));
    expect(q.body.onlinePaymentEnabled).toBe(false);
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res).toMatchObject({ status: 422, body: { error: 'payments_disabled' } });
  });

  it('sahte saglayicida webhook ucu yok (404); bilinmeyen niyet icin imzali webhook 200 (tekrar denemesin)', async () => {
    const plain = setup();
    const r1 = await plain.app.request('/api/payments/fake/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r1.status).toBe(404);
    const { w } = iyzicoWorld();
    const hook = { paymentConversationId: `${APT}:20261106100000-yok`, token: 't', status: 'SUCCESS', iyziEventType: 'X', iyziPaymentId: 1 };
    const r2 = await w.app.request('/api/payments/iyzico/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-iyz-signature-v3': webhookSig(hook) },
      body: JSON.stringify(hook),
    });
    expect(r2.status).toBe(200);
    const r3 = await w.app.request('/api/payments/iyzico/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'bozuk' });
    expect(r3.status).toBe(400);
  });
});

describe('odeme - alt uye isyeri yonetimi (platform_admin)', () => {
  const body = {
    email: 'yonetim@lale.test',
    gsmNumber: '05321234567',
    address: 'Lale Sk. 1, Kadıköy',
    iban: 'TR330006100519786457841326',
    taxOffice: 'Kadıköy',
    legalCompanyTitle: 'Lale Apartmanı Yönetimi',
    taxNumber: '1234567890',
  };

  it('yalnizca platform_admin; yonetici ve sakin 403, token yoksa 401', async () => {
    const w = setup();
    const path = `/api/admin/payments/apartments/${APT}/account`;
    expect((await w.call('POST', path, undefined, body)).status).toBe(401);
    expect((await w.call('POST', path, w.token('mgr-1', 'apartment_manager'), body)).status).toBe(403);
    expect((await w.call('GET', path, w.token('tenant-1'))).status).toBe(403);
  });

  it('kayit: KYC verisi saklanmaz (IBAN yalnizca sifreli), audit logu yazilir, ikinci kayit 409, olmayan apartman 404', async () => {
    const w = setup();
    const admin = w.token('ops-1', 'platform_admin', '');
    const path = `/api/admin/payments/apartments/${APT}/account`;
    const res = await w.call('POST', path, admin, body);
    expect(res.status).toBe(201);
    // Varsayilan platform payi %0,75 (Online Odeme v2 · P1 karari).
    expect(res.body).toMatchObject({ provider: 'fake', subMerchantKey: `fake-sm-${APT}`, platformFeeBasisPoints: 75, version: 1, createdBy: 'ops-1', payeeOnFile: true });
    expect(res.body.PK).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/payeeCiphertext|TR330006100519786457841326/);
    // P4: sirket VKN'si platform faturasinin muhatabi olarak tutulur; IBAN duz metin olarak hicbir yerde yok.
    expect(res.body.invoiceRecipient).toEqual({ title: 'Lale Apartmanı Yönetimi', taxNumber: '1234567890', taxOffice: 'Kadıköy' });
    const stored = JSON.stringify([...w.fin.docs.values()]);
    expect(stored).not.toContain('TR330006100519786457841326');
    expect(stored).not.toContain('11111111111');
    expect(JSON.stringify(w.logs)).not.toContain('TR330006100519786457841326');
    expect(w.fake.subMerchants.get(`fake-sm-${APT}`)).toMatchObject({ taxNumber: '1234567890', gsmNumber: '+905321234567' });
    expect(w.logs.some((l) => l.fields?.audit === 'PAYMENT_ACCOUNT_ONBOARDED' && l.fields.by === 'ops-1')).toBe(true);

    expect((await w.call('POST', path, admin, body)).status).toBe(409);
    expect((await w.call('GET', path, admin)).body.subMerchantKey).toBe(`fake-sm-${APT}`);
    expect((await w.call('POST', `/api/admin/payments/apartments/yok/account`, admin, body)).status).toBe(404);
    expect((await w.call('GET', `/api/admin/payments/apartments/${OTHER_APT}/account`, admin)).status).toBe(404);
  });

  it.each([
    ['gecersiz tip', { subMerchantType: 'X' }, 'subMerchantType'],
    ['IBAN', { iban: 'TR330006100519786457841327' }, 'iban'],
    ['telefon', { gsmNumber: '123' }, 'gsmNumber'],
    ['e-posta', { email: 'x' }, 'email'],
    ['sirket unvani eksik', { legalCompanyTitle: undefined }, 'legalCompanyTitle'],
    ['limited vergi no eksik', { subMerchantType: 'LIMITED_OR_JOINT_STOCK_COMPANY', taxNumber: undefined }, 'taxNumber'],
    ['bireysel TCKN eksik', { subMerchantType: 'PERSONAL', contactName: 'Ali', contactSurname: 'Veli' }, 'identityNumber'],
    ['platform payi', { platformFeeBasisPoints: 5000 }, 'platformFeeBasisPoints'],
  ])('dogrulama: %s', async (_label, over, field) => {
    const w = setup();
    const res = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, w.token('ops-1', 'platform_admin', ''), { ...body, ...over });
    expect(res).toMatchObject({ status: 400, body: { field } });
  });

  it('PATCH: pasife alinan apartmanda odeme baslatilamaz; platform payi guncellenir', async () => {
    const w = setup();
    const admin = w.token('ops-1', 'platform_admin', '');
    const path = `/api/admin/payments/apartments/${APT}/account`;
    await w.call('POST', path, admin, body);
    const off = await w.call('PATCH', path, admin, { status: 'disabled', platformFeeBasisPoints: 150 });
    expect(off.body).toMatchObject({ status: 'disabled', platformFeeBasisPoints: 150, version: 2, updatedBy: 'ops-1' });
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res.body.error).toBe('payments_disabled');
    expect((await w.call('PATCH', path, admin, { status: 'x' })).status).toBe(400);
  });

  it('saglayici kaydi reddederse 422 provider_rejected; ulasilamazsa 502', async () => {
    const reject: PaymentProvider = { ...createFakePaymentProvider({ apiBaseUrl: 'https://api.test' }), registerSubMerchant: async () => { throw new PaymentProviderError('iyzico_2001', 'IBAN hatali'); } };
    const w = setup({ customProvider: reject });
    const admin = w.token('ops-1', 'platform_admin', '');
    const res = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, body);
    expect(res).toMatchObject({ status: 422, body: { error: 'provider_rejected' } });
    const down: PaymentProvider = { ...reject, registerSubMerchant: async () => { throw new PaymentProviderError('unavailable', 'x', true); } };
    const w2 = setup({ customProvider: down });
    expect((await w2.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, body)).status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
// Web icin ekler: requiresGsmNumber, yonetici listesi/durum karti, platform apartman listesi
// ---------------------------------------------------------------------------

describe('odeme - web ekleri', () => {
  it('quote: sandbox saglayicida telefon istenmez, canlida istenir', async () => {
    const sandbox = setup();
    await sandbox.charge('u1', 'occupant', TL(100), '2026-11-10', 'c1', '2026-11-01');
    expect((await sandbox.call('GET', '/api/portal/payments/quote', sandbox.token('tenant-1'))).body.requiresGsmNumber).toBe(false);
    const live = setup({ provider: 'live' });
    await live.charge('u1', 'occupant', TL(100), '2026-11-10', 'c1', '2026-11-01');
    expect((await live.call('GET', '/api/portal/payments/quote', live.token('tenant-1'))).body.requiresGsmNumber).toBe(true);
    const off = setup({ provider: false });
    await off.charge('u1', 'occupant', TL(100), '2026-11-10', 'c1', '2026-11-01');
    expect((await off.call('GET', '/api/portal/payments/quote', off.token('tenant-1'))).body).toMatchObject({ onlinePaymentEnabled: false, requiresGsmNumber: false });
  });

  async function withIntents() {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'owner', TL(500), '2026-11-10', 'c2', '2026-11-01');
    const a = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body.intentId as string;
    await w.payThroughProvider(a);
    w.clock.now = new Date('2026-11-06T10:05:00.000Z');
    const b = (await w.call('POST', '/api/portal/payments', w.token('owner-2'), { idempotencyKey: 'k-2', mode: 'total' })).body.intentId as string;
    await w.payThroughProvider(b, 'failure');
    w.clock.now = new Date('2026-11-06T10:10:00.000Z');
    await w.charge('u1', 'occupant', TL(300), '2026-11-20', 'c3', '2026-11-06');
    const c = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-3', mode: 'total' })).body.intentId as string;
    return { w, a, b, c };
  }

  it('yonetici listesi: en yeni once, durum filtresi, sayfalama; sakin ve platform rolu 403', async () => {
    const { w, a, b, c } = await withIntents();
    const mgr = w.token('mgr-1', 'apartment_manager');
    const all = await w.call('GET', '/api/finance/online-payments', mgr);
    expect(all.status).toBe(200);
    expect(all.headers.get('cache-control')).toBe('no-store');
    expect(all.body.items.map((i: { intentId: string }) => i.intentId)).toEqual([c, b, a]);
    expect(all.body.items[2]).toMatchObject({
      status: 'SUCCEEDED',
      unitId: 'u1',
      userId: 'tenant-1',
      amount: TL(1000),
      platformFee: 0,
      providerPaymentId: 'fakepay-1',
      receiptNumbers: ['MKB-000001'],
      allocations: [{ liableParty: 'occupant', principal: TL(1000), lateFee: 0, amount: TL(1000) }],
    });
    expect(all.body.items[1]).toMatchObject({ status: 'FAILED', failure: { code: 'card_declined' } });
    expect(JSON.stringify(all.body)).not.toMatch(/subMerchantKey|checkout|token/);

    const failed = await w.call('GET', '/api/finance/online-payments?status=FAILED', mgr);
    expect(failed.body.items.map((i: { intentId: string }) => i.intentId)).toEqual([b]);

    const p1 = await w.call('GET', '/api/finance/online-payments?limit=2', mgr);
    expect(p1.body.items).toHaveLength(2);
    const p2 = await w.call('GET', `/api/finance/online-payments?limit=2&cursor=${p1.body.nextCursor}`, mgr);
    expect(p2.body.items.map((i: { intentId: string }) => i.intentId)).toEqual([a]);
    expect(p2.body.nextCursor).toBeUndefined();

    expect((await w.call('GET', '/api/finance/online-payments?status=X', mgr)).status).toBe(400);
    expect((await w.call('GET', '/api/finance/online-payments?limit=500', mgr)).status).toBe(400);
    expect((await w.call('GET', '/api/finance/online-payments', w.token('obs-1', 'observer'))).status).toBe(200);
    expect((await w.call('GET', '/api/finance/online-payments', w.token('tenant-1'))).status).toBe(403);
    expect((await w.call('GET', '/api/finance/online-payments', w.token('ops-1', 'platform_admin', ''))).status).toBe(403);
    expect((await w.call('GET', '/api/finance/online-payments')).status).toBe(401);
  });

  it('yonetici listesi tenant izolasyonlu: baska apartmanin yoneticisi bos liste gorur', async () => {
    const { w } = await withIntents();
    const other = await w.call('GET', '/api/finance/online-payments', w.token('mgr-2', 'apartment_manager', OTHER_APT));
    expect(other.body.items).toEqual([]);
  });

  it('yonetici durum karti: kayit yok / aktif; alt uye anahtari donmez', async () => {
    const w = setup();
    const mgr = w.token('mgr-1', 'apartment_manager');
    expect((await w.call('GET', '/api/finance/online-payments/account', mgr)).body).toEqual({
      configured: true,
      provider: 'fake',
      sandbox: true,
      status: 'not_registered',
    });
    await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, w.token('ops-1', 'platform_admin', ''), {
      email: 'yonetim@lale.test',
      gsmNumber: '05321234567',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR330006100519786457841326',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
      platformFeeBasisPoints: 150,
    });
    const res = await w.call('GET', '/api/finance/online-payments/account', mgr);
    expect(res.body).toMatchObject({ status: 'active', ibanMasked: 'TR** **** **** **** **** **13 26', platformFeeBasisPoints: 150, subMerchantType: 'PRIVATE_COMPANY' });
    expect(res.body.subMerchantKey).toBeUndefined();
    const off = setup({ provider: false });
    expect((await off.call('GET', '/api/finance/online-payments/account', off.token('mgr-1', 'apartment_manager'))).body).toEqual({
      configured: false,
      status: 'not_registered',
    });
  });

  it('platform apartman listesi: siteler + hesap durumu, olmayan site atlanir; yalnizca platform_admin', async () => {
    const w = setup();
    const admin = w.token('ops-1', 'platform_admin', '');
    const empty = await w.call('GET', '/api/admin/payments/apartments', admin);
    expect(empty.body).toEqual({
      provider: 'fake',
      sandbox: true,
      providers: [{ name: 'fake', sandbox: true, capabilities: { checkout: 'redirect', settlement: 'item_approval', requiresBuyerGsm: true } }],
      items: [
        {
          apartmentId: APT,
          name: 'Lale Apartmani',
          city: 'Istanbul',
          district: 'Kadikoy',
          siteStatus: 'active',
          paymentProvider: null,
          effectiveProvider: 'fake',
          account: null,
        },
      ],
    });
    await w.payRepo.repo.putAccount({ ...paymentKeys.account(APT, 'fake'), entityType: 'PAYMENT_ACCOUNT', apartmentId: APT, provider: 'fake', subMerchantKey: 'sm-1', subMerchantType: 'PRIVATE_COMPANY', status: 'disabled', platformFeeBasisPoints: 0, ...audit });
    const list = await w.call('GET', '/api/admin/payments/apartments', admin);
    expect(list.body.items[0].account).toMatchObject({ status: 'disabled', subMerchantKey: 'sm-1' });
    expect(list.body.items[0].account.PK).toBeUndefined();
    expect((await w.call('GET', '/api/admin/payments/apartments', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);
  });
});

describe('odeme deposu - yonetici listesi (DynamoDB)', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createPaymentsRepository();
  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });
  const intent = (id: string, apt = APT) => ({ PK: `APT#${apt}`, SK: `PI#${id}`, entityType: 'PAYMENT_INTENT', intentId: id, apartmentId: apt });

  it('en yeni once, durum filtresiyle, limit dolana kadar sayfalar; imlec doner', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [intent('3')], LastEvaluatedKey: { PK: `APT#${APT}`, SK: 'PI#3' } })
      .resolvesOnce({ Items: [intent('1')], LastEvaluatedKey: { PK: `APT#${APT}`, SK: 'PI#1' } });
    const out = await repo.listIntents(APT, { status: 'FAILED', limit: 2 });
    expect(out.items.map((i) => i.intentId)).toEqual(['3', '1']);
    expect(Buffer.from(out.cursor!, 'base64url').toString()).toBe(JSON.stringify({ PK: `APT#${APT}`, SK: 'PI#1' }));
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :pfx)',
      FilterExpression: '#status = :status',
      ExpressionAttributeValues: { ':pk': `APT#${APT}`, ':pfx': 'PI#', ':status': 'FAILED' },
      ScanIndexForward: false,
      Limit: 2,
    });
    expect(ddbMock.commandCalls(QueryCommand)[1]!.args[0].input).toMatchObject({ Limit: 1, ExclusiveStartKey: { PK: `APT#${APT}`, SK: 'PI#3' } });
  });

  it('baska apartmanin veya baska kayit turunun imleci reddedilir', async () => {
    const enc = (k: object) => Buffer.from(JSON.stringify(k)).toString('base64url');
    await expect(repo.listIntents(APT, { limit: 5, cursor: enc({ PK: 'APT#apt-2', SK: 'PI#1' }) })).rejects.toBeInstanceOf(InvalidIntentCursorError);
    await expect(repo.listIntents(APT, { limit: 5, cursor: enc({ PK: `APT#${APT}`, SK: 'TX#1' }) })).rejects.toBeInstanceOf(InvalidIntentCursorError);
    await expect(repo.listIntents(APT, { limit: 5, cursor: 'bozuk' })).rejects.toBeInstanceOf(InvalidIntentCursorError);
    expect(ddbMock.commandCalls(QueryCommand)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// NEEDS_REVIEW elle sonuclandirma (deftere yaz / tam iade / kapat) - yalnizca platform_admin
// ---------------------------------------------------------------------------

describe('odeme - inceleme sonuclandirma', () => {
  type W = ReturnType<typeof setup>;
  const ops = (w: W) => w.token('ops-1', 'platform_admin', '');
  /** Olustur (1) -> odeme sayfasi (2) -> inceleme (3). */
  const REVIEW_V = 3;
  const base = (id: string) => `/api/admin/payments/apartments/${APT}/intents/${id}`;

  /** Odeme saglayicida basarili ama dogrulama tutmuyor -> NEEDS_REVIEW. */
  async function reviewed(
    override: Parameters<W['fake']['complete']>[2] extends infer O ? (O extends { override?: infer V } ? V : never) : never,
    opts: { userId?: string; unitId?: string } = {},
  ) {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'owner', TL(400), '2026-11-10', 'c2', '2026-11-01');
    await w.charge('u2', 'occupant', TL(600), '2026-11-10', 'c3', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token(opts.userId ?? 'tenant-1'), {
      idempotencyKey: 'k-1',
      mode: 'total',
      ...(opts.unitId ? { unitId: opts.unitId } : {}),
    });
    expect(created.status).toBe(201);
    const id = created.body.intentId as string;
    const session = w.fake.sessions.get(`fake_${id}`)!;
    w.fake.complete(`fake_${id}`, 'success', { override });
    const ref = new URL(session.request.callbackUrl).searchParams.get('ref')!;
    await w.app.request(`/api/payments/fake/callback?ref=${encodeURIComponent(ref)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(`fake_${id}`)}`,
    });
    expect(w.intentOf(id).status).toBe('NEEDS_REVIEW');
    return { w, id, session };
  }

  const resolve = (w: W, id: string, action: string, version: number, note = 'Sağlayıcı paneli kontrol edildi') =>
    w.call('POST', `${base(id)}/resolve`, ops(w), { action, note, expectedVersion: version });

  it('kuyruk: tum apartmanlardaki incelemeler, apartman adiyla; yalnizca platform_admin', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    const q = await w.call('GET', '/api/admin/payments/review', ops(w));
    expect(q.status).toBe(200);
    expect(q.body.items).toHaveLength(1);
    expect(q.body.items[0]).toMatchObject({ intentId: id, apartmentId: APT, apartmentName: 'Lale Apartmani', status: 'NEEDS_REVIEW', version: REVIEW_V });
    expect(JSON.stringify(q.body)).not.toMatch(/subMerchantKey|checkout|token|GSI1/);
    // Kuyruk kaydi yalnizca inceleme durumunda (seyrek indeks).
    expect(w.fin.docs.get(`APT#${APT}|PI#${id}`)).toMatchObject({ GSI1PK: 'PAYMENT_REVIEW', GSI1SK: `PI#${id}#APT#${APT}` });

    expect((await w.call('GET', '/api/admin/payments/review', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);
    expect((await w.call('GET', '/api/admin/payments/review', w.token('tenant-1'))).status).toBe(403);
    expect((await w.call('POST', `${base(id)}/resolve`, w.token('mgr-1', 'apartment_manager'), { action: 'refund', note: 'xxxxx', expectedVersion: REVIEW_V })).status).toBe(403);
    expect((await w.call('GET', `${base(id)}/check`)).status).toBe(401);
  });

  it('tutar uyusmuyorsa deftere isleme kapali; yalnizca tam iade', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.status).toBe(200);
    expect(check.body.check).toMatchObject({ status: 'success', paidAmount: TL(999), problems: [expect.stringMatching(/tutar uyusmuyor/)] });
    expect(check.body.actions).toEqual([
      { action: 'approve', allowed: false, reason: expect.stringMatching(/Doğrulama tutmuyor/) },
      { action: 'refund', allowed: true },
      { action: 'close', allowed: false, reason: expect.stringMatching(/başarılı çekim var/) },
    ]);
    const r = await resolve(w, id, 'approve', REVIEW_V);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('action_not_allowed');
    expect(w.fin.batches).toHaveLength(0);
  });

  it('deftere isle: dogrulama artik tutuyorsa (fraud onaylandi) SUCCEEDED, makbuz, iz kaydi; kuyruktan duser', async () => {
    const { w, id, session } = await reviewed({ fraudApproved: false });
    expect((await w.call('GET', `${base(id)}/check`, ops(w))).body.actions[0]).toMatchObject({ action: 'approve', allowed: false });
    // iyzico fraud incelemesini onayladi:
    session.override = undefined;
    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.body.actions.map((a: { allowed: boolean }) => a.allowed)).toEqual([true, true, false]);

    // Eski surumla karar: 409 (siz incelerken degisti).
    expect((await resolve(w, id, 'approve', REVIEW_V - 1)).status).toBe(409);
    const ok = await resolve(w, id, 'approve', REVIEW_V, 'Fraud incelemesi iyzico panelinde onaylandı');
    expect(ok.status).toBe(200);
    expect(ok.body.intent).toMatchObject({
      status: 'SUCCEEDED',
      receiptNumbers: ['MKB-000001'],
      resolution: { action: 'approve', note: 'Fraud incelemesi iyzico panelinde onaylandı', by: 'ops-1', providerCheck: { status: 'success', problems: [] } },
    });
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
    expect(w.fin.batches).toHaveLength(1);
    const stored = w.fin.docs.get(`APT#${APT}|PI#${id}`)!;
    expect(stored.GSI1PK).toBeUndefined();
    expect((await w.call('GET', '/api/admin/payments/review', ops(w))).body.items).toEqual([]);
    expect(w.logs.some((l) => l.fields?.audit === 'PAYMENT_REVIEW_RESOLVED' && l.fields?.action === 'approve')).toBe(true);

    // Ikinci karar: artik inceleme beklemiyor.
    const again = await resolve(w, id, 'approve', (stored.version as number));
    expect(again.status).toBe(422);
    // Sakin: basarili; yonetici: karar ve gerekce (saglayici ayrintisi yok).
    expect((await w.call('GET', `/api/portal/payments/${id}`, w.token('tenant-1'))).body.status).toBe('SUCCEEDED');
    const mgr = await w.call('GET', '/api/finance/online-payments', w.token('mgr-1', 'apartment_manager'));
    expect(mgr.body.items[0].resolution).toEqual({ action: 'approve', note: 'Fraud incelemesi iyzico panelinde onaylandı', at: expect.any(String) });
    expect(JSON.stringify(mgr.body)).not.toMatch(/providerCheck/);
  });

  it('tam iade: her sepet kalemi kendi paymentTransactionId ile tam tutarda bir kez iade edilir; defterde iz yok', async () => {
    // Malik + oturan: iki sepet kalemi.
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(1001)) }, { userId: 'owner-2', unitId: 'u2' });
    const r = await resolve(w, id, 'refund', REVIEW_V, 'Tutar uyuşmazlığı, tam iade');
    expect(r.status).toBe(200);
    expect(r.body.intent).toMatchObject({ status: 'REFUNDED', refundedAmount: TL(1000) });
    expect(r.body.intent.refund.items).toEqual([
      expect.objectContaining({ itemId: `${id}-occupant`, paymentTransactionId: 'fakepay-1-t1', amount: TL(600), status: 'succeeded', attempts: 1, conversationId: `refund-${id}-1` }),
      expect.objectContaining({ itemId: `${id}-owner`, paymentTransactionId: 'fakepay-1-t2', amount: TL(400), status: 'succeeded', attempts: 1, conversationId: `refund-${id}-2` }),
    ]);
    expect(Object.fromEntries([...w.fake.refunds].map(([k, list]) => [k, list.map((x) => x.amount)]))).toEqual({
      'fakepay-1-t1': [TL(600)],
      'fakepay-1-t2': [TL(400)],
    });
    expect(w.fin.batches).toHaveLength(0);
    expect(w.fin.balanceOf('recv-u2-owner')).toBe(TL(400));
    expect(w.fin.docs.get(`APT#${APT}|PI#${id}`)!.GSI1PK).toBeUndefined();
    expect(w.logs.some((l) => l.fields?.audit === 'PAYMENT_REFUNDED')).toBe(true);

    const resident = await w.call('GET', `/api/portal/payments/${id}`, w.token('owner-2'));
    expect(resident.body).toMatchObject({ status: 'REFUNDED', failureMessage: expect.stringMatching(/iade edildi/) });
    // Iade edilmis odemede yeni islem yok.
    expect((await resolve(w, id, 'refund', 99)).status).toBe(409);
  });

  it('iade yaniti kaybolursa (zaman asimi): tekrar denemeden once saglayicida iade edilmis tutar sorulur; cift iade yok', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    w.fake.failNextRefund(new PaymentProviderError('timeout', 'Zaman asimi', true), { applied: true });
    const r = await resolve(w, id, 'refund', REVIEW_V);
    expect(r.status).toBe(200);
    expect(r.body.intent).toMatchObject({ status: 'REFUND_PENDING' });
    expect(r.body.intent.refund.items[0]).toMatchObject({ status: 'pending', attempts: 1, error: { code: 'timeout' } });
    expect(w.fake.refunds.get('fakepay-1-t1')).toHaveLength(1);

    // Hemen calisan mutabakat devam eden cagri ile yarismaz.
    expect(await w.payments.reconcileRefunds()).toEqual({ checked: 1, refunded: 0, stillPending: 1 });
    // 5 dk sonra: saglayicida iade gorulur, tekrar gonderilmez.
    w.clock.now = new Date(w.clock.now.getTime() + 6 * 60_000);
    expect(await w.payments.reconcileRefunds()).toEqual({ checked: 1, refunded: 1, stillPending: 0 });
    expect(w.fake.refunds.get('fakepay-1-t1')).toHaveLength(1);
    expect(w.intentOf(id)).toMatchObject({ status: 'REFUNDED' });
    expect(w.intentOf(id).refund!.items[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(await w.payments.reconcileRefunds()).toEqual({ checked: 0, refunded: 0, stillPending: 0 });
  });

  it('ag hatasi (iade gerceklesmedi): sure dolunca mutabakat yeniden gonderir', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    w.fake.failNextRefund(new PaymentProviderError('unavailable', 'Ulasilamadi', true));
    expect((await resolve(w, id, 'refund', REVIEW_V)).body.intent.status).toBe('REFUND_PENDING');
    expect(w.fake.refunds.size).toBe(0);
    w.clock.now = new Date(w.clock.now.getTime() + 6 * 60_000);
    await w.payments.reconcileRefunds();
    expect(w.intentOf(id).status).toBe('REFUNDED');
    expect(w.fake.refunds.get('fakepay-1-t1')).toHaveLength(1);
  });

  it('saglayici iadeyi reddederse alarm; mutabakat tekrar denemez, platform ekibi yeniden deneyebilir', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    w.fake.failNextRefund(new PaymentProviderError('refund_rejected', 'Iade reddedildi', false));
    const r = await resolve(w, id, 'refund', REVIEW_V);
    expect(r.body.intent.refund.items[0]).toMatchObject({ status: 'failed', error: { code: 'refund_rejected' } });
    expect(w.logs.some((l) => l.fields?.alert === 'PAYMENT_REFUND_FAILED')).toBe(true);

    w.clock.now = new Date(w.clock.now.getTime() + 60 * 60_000);
    expect(await w.payments.reconcileRefunds()).toEqual({ checked: 1, refunded: 0, stillPending: 1 });
    expect(w.fake.refunds.size).toBe(0);

    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.body).toMatchObject({ check: null, actions: [{ allowed: false }, { action: 'refund', allowed: true }, { allowed: false }] });
    // REFUND_PENDING'de yalnizca iade tekrar denenebilir.
    expect((await resolve(w, id, 'close', check.body.intent.version)).status).toBe(422);
    const retry = await resolve(w, id, 'refund', check.body.intent.version, 'Sağlayıcıyla görüşüldü, tekrar');
    expect(retry.body.intent.status).toBe('REFUNDED');
    expect(w.fake.refunds.get('fakepay-1-t1')).toHaveLength(1);
  });

  it('kapat: saglayicida basarili cekim yoksa FAILED; varsa kapatilamaz', async () => {
    const { w, id, session } = await reviewed({ fraudApproved: false });
    expect((await resolve(w, id, 'close', REVIEW_V)).status).toBe(422);
    // Fraud incelemesi sonunda iyzico odemeyi iptal etti:
    session.outcome = 'failure';
    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.body.actions).toEqual([
      { action: 'approve', allowed: false, reason: 'Sağlayıcıda başarılı çekim yok' },
      { action: 'refund', allowed: false, reason: 'Sağlayıcıda başarılı çekim yok' },
      { action: 'close', allowed: true },
    ]);
    const r = await resolve(w, id, 'close', REVIEW_V, 'iyzico ödemeyi iptal etmiş');
    expect(r.body.intent).toMatchObject({ status: 'FAILED', failure: { code: 'review_closed' }, resolution: { action: 'close' } });
    expect(w.fin.batches).toHaveLength(0);
    expect(w.fake.refunds.size).toBe(0);
  });

  it('odeme bu kayitla eslesmiyorsa (sepet/conversation) iade de kapali: saglayici panelinden', async () => {
    const { w, id } = await reviewed({ basketId: 'baska-sepet' });
    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.body.actions.find((a: { action: string }) => a.action === 'refund')).toEqual({
      action: 'refund',
      allowed: false,
      reason: expect.stringMatching(/eşleşmiyor/),
    });
  });

  it('dogrulama: gerekce, islem, surum; olmayan niyet 404; saglayiciya ulasilamazsa 502', async () => {
    const { w, id } = await reviewed({ paidAmount: toKurus(TL(999)) });
    expect((await resolve(w, id, 'refund', REVIEW_V, 'kısa')).body).toMatchObject({ error: 'validation_error', field: 'note' });
    expect((await resolve(w, id, 'sil', REVIEW_V)).body.field).toBe('action');
    expect((await w.call('POST', `${base(id)}/resolve`, ops(w), { action: 'refund', note: 'yeterli gerekçe' })).body.field).toBe('expectedVersion');
    expect((await resolve(w, '20261106100000-yok', 'refund', 1)).status).toBe(404);
    expect((await w.call('GET', `/api/admin/payments/apartments/${OTHER_APT}/intents/${id}/check`, ops(w))).status).toBe(404);
    w.fake.failNextRetrieve();
    expect((await resolve(w, id, 'refund', REVIEW_V)).status).toBe(502);
    expect(w.intentOf(id).status).toBe('NEEDS_REVIEW');
  });

  it('PENDING / SUCCEEDED niyet inceleme islemlerine kapali', async () => {
    const w = setup();
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    const id = created.body.intentId as string;
    const check = await w.call('GET', `${base(id)}/check`, ops(w));
    expect(check.body.actions.every((a: { allowed: boolean }) => !a.allowed)).toBe(true);
    expect((await resolve(w, id, 'close', w.intentOf(id).version)).body.error).toBe('action_not_allowed');
  });
});

describe('odeme deposu - inceleme kuyrugu (DynamoDB GSI1)', () => {
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const repo = createPaymentsRepository();

  beforeEach(() => {
    ddbMock.reset();
    resetDynamoCache();
    process.env.DYNAMODB_TABLE_NAME = 'bm-test-table';
    process.env.AWS_REGION = 'eu-north-1';
    process.env.DYNAMODB_ENDPOINT = '';
  });

  const intent = (status: string) =>
    ({ ...paymentKeys.intent(APT, '20261106100000-a'), entityType: 'PAYMENT_INTENT', intentId: '20261106100000-a', apartmentId: APT, status, version: 2 }) as unknown as PaymentIntent;

  it('kuyruk alanlari durumdan turetilir: inceleme durumunda yazilir, cikinca silinir', async () => {
    expect(toStoredIntent(intent('NEEDS_REVIEW'))).toMatchObject({ GSI1PK: 'PAYMENT_REVIEW', GSI1SK: `PI#20261106100000-a#APT#${APT}` });
    expect(toStoredIntent(intent('REFUND_PENDING'))).toMatchObject({ GSI1PK: 'PAYMENT_REVIEW' });
    const leaving = { ...intent('SUCCEEDED'), GSI1PK: 'PAYMENT_REVIEW', GSI1SK: 'x' } as PaymentIntent;
    expect(toStoredIntent(leaving)).not.toHaveProperty('GSI1PK');

    ddbMock.on(PutCommand).resolves({});
    await repo.updateIntent({ ...leaving, version: 3 }, 2);
    expect(ddbMock.commandCalls(PutCommand)[0]!.args[0].input.Item).not.toHaveProperty('GSI1PK');
  });

  it('kuyruk sorgusu GSI1 ile; durumu artik incelemede olmayan (gecikmeli indeks) kayitlar elenir; indeks alanlari donmez', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { ...intent('NEEDS_REVIEW'), GSI1PK: 'PAYMENT_REVIEW', GSI1SK: 'a' },
        { ...intent('SUCCEEDED'), intentId: 'b' },
        { PK: 'x', entityType: 'SITE', status: 'NEEDS_REVIEW' },
      ],
    });
    const out = await repo.listReviewQueue(50);
    expect(out).toHaveLength(1);
    expect(out[0]).not.toHaveProperty('GSI1PK');
    const input = ddbMock.commandCalls(QueryCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :pk', ExpressionAttributeValues: { ':pk': 'PAYMENT_REVIEW' }, Limit: 50 });
  });
});

// ---------------------------------------------------------------------------
// Online Odeme v2 · P1: komisyonu apartman oder + pazaryeri onayi
// ---------------------------------------------------------------------------

describe('odeme - komisyon (apartman oder) ve pazaryeri onayi', () => {
  const feeAccount = (over: Partial<PaymentAccount> = {}): PaymentAccount => ({
    ...paymentKeys.account(APT, 'fake'),
    entityType: 'PAYMENT_ACCOUNT',
    apartmentId: APT,
    provider: 'fake',
    subMerchantKey: 'sm-1',
    subMerchantType: 'PRIVATE_COMPANY',
    status: 'active',
    platformFeeBasisPoints: 75,
    posRateBasisPoints: 249,
    posFixedFeeKurus: 25,
    ...audit,
    ...over,
  });

  it('sakin borcunu net oder; %0,75 + POS tahmini aktarilacak tutardan duser ve apartmanin giderine yazilir', async () => {
    const w = setup();
    await w.payRepo.repo.putAccount(feeAccount());
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.status).toBe(201);
    const intentId = created.body.intentId as string;
    // Sakine ek ucret yok: odenen tutar = borc; komisyon alanlari sakine donmez.
    expect(created.body.amount).toBe(TL(1000));
    expect(JSON.stringify(created.body)).not.toMatch(/subMerchant|platformFee|posEstimate|commission/);
    expect(w.fake.sessions.get(`fake_${intentId}`)!.request).toMatchObject({
      amount: TL(1000),
      items: [{ amount: TL(1000), subMerchantKey: 'sm-1', subMerchantPrice: 96_735 }], // 1000 - 7,50 - 24,90 - 0,25
    });
    expect(w.intentOf(intentId)).toMatchObject({ platformFee: 750, posEstimate: 2_515 });

    w.fake.setProviderFeePerItem(2_600 as Kurus); // gercek komisyon 26,00 TL
    await w.payThroughProvider(intentId);

    // Defter: tahsilat 1000 TL + komisyon gideri 32,65 TL (tek atomik yazim).
    expect(w.fin.batches).toHaveLength(1);
    const feeTx = [...w.fin.transactions.values()].find((t) => t.reference === `ONLINE-FEE:${intentId}`)!;
    expect(feeTx).toMatchObject({ kind: 'expense', totalAmount: 3_265, date: '2026-11-06' });
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);
    expect(w.fin.balanceOf('online-collection')).toBe(96_735);
    expect(w.fin.balanceOf('exp-online-collection-fee')).toBe(3_265);
    expect(w.fin.trialBalance()).toBe(0);
    expect(w.intentOf(intentId).transactionIds).toContain(feeTx.transactionId);

    // Mutabakat: gercek komisyon ve tahmin farki (platformun kaybi; apartmanin defteri degismez).
    expect(w.intentOf(intentId).settlement).toEqual({
      status: 'approved',
      commission: 3_265,
      subMerchantTotal: 96_735,
      providerFee: 2_600,
      posFeeDrift: -85,
      approvals: [
        expect.objectContaining({ itemId: `${intentId}-occupant`, paymentTransactionId: 'fakepay-1-t1', status: 'approved', attempts: 1 }),
      ],
    });
    expect(w.fake.approvals.get('fakepay-1-t1')).toBe(1);

    // Yonetici komisyonu ve aktarilacak tutari gorur.
    const list = await w.call('GET', '/api/finance/online-payments', w.token('mgr-1', 'apartment_manager'));
    expect(list.body.items[0]).toMatchObject({ amount: TL(1000), commission: 3_265, transferAmount: 96_735, settlementStatus: 'approved' });
  });

  it('malik + oturan: sabit POS ucreti islem basina bir kez (ilk kalem)', async () => {
    const w = setup();
    await w.payRepo.repo.putAccount(feeAccount());
    await w.charge('u2', 'owner', TL(500), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'occupant', TL(1000), '2026-11-10', 'c2', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('owner-2'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.status).toBe(201);
    const items = w.fake.sessions.get(`fake_${created.body.intentId}`)!.request.items;
    expect(items.map((i) => [i.id.split('-').at(-1), i.amount, i.subMerchantPrice])).toEqual([
      ['occupant', TL(1000), 96_735],
      ['owner', TL(500), 48_380], // 500 - 3,75 - 12,45
    ]);
  });

  it('onay gecici hatada bekler, mutabakatta yeniden denenir; kalici hatada alarm', async () => {
    const w = setup();
    await w.payRepo.repo.putAccount(feeAccount());
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const { intentId } = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body;
    w.fake.failNextApprove();
    await w.payThroughProvider(intentId);
    expect(w.intentOf(intentId)).toMatchObject({
      status: 'SUCCEEDED',
      settlement: { status: 'pending', approvals: [{ status: 'pending', attempts: 1, error: { code: 'unavailable' } }] },
    });
    // Defter onaydan bagimsiz: tahsilat yazildi.
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);

    w.clock.now = new Date('2026-11-06T10:40:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals).toEqual({ checked: 1, approved: 1, pending: 0, failed: 0 });
    expect(w.intentOf(intentId).settlement).toMatchObject({ status: 'approved', approvals: [{ status: 'approved', attempts: 2 }] });

    // Kalici red (iyzico retryable=false): kalem failed + alarm, bir daha denenmez.
    await w.charge('u1', 'occupant', TL(200), '2026-11-20', 'c2', '2026-11-01');
    const second = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-2', mode: 'total' })).body;
    w.fake.failNextApprove(new PaymentProviderError('iyzico_10208', 'Gecersiz islem', false));
    await w.payThroughProvider(second.intentId);
    expect(w.intentOf(second.intentId).settlement).toMatchObject({ status: 'failed', approvals: [{ status: 'failed', attempts: 1 }] });
    expect(w.logs).toContainEqual(expect.objectContaining({ level: 'error', fields: expect.objectContaining({ alert: 'PAYMENT_APPROVAL_FAILED', intentId: second.intentId }) }));
    w.clock.now = new Date('2026-11-06T11:30:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals.checked).toBe(0);
  });

  it('komisyonu karsilamayan cok kucuk tutar online odenemez (400)', async () => {
    const w = setup();
    await w.payRepo.repo.putAccount(feeAccount({ posFixedFeeKurus: 5_000 }));
    await w.charge('u1', 'occupant', TL(40), '2026-11-10', 'c1', '2026-11-01');
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res).toMatchObject({ status: 400, body: { error: 'validation_error' } });
    expect(w.fake.sessions.size).toBe(0);
  });

  it('platform: POS orani hesap bazinda gecersiz kilinir, null ile ortam varsayilanina doner; etkin politika gorunur', async () => {
    const w = setup();
    await w.payRepo.repo.putAccount(feeAccount({ posRateBasisPoints: undefined, posFixedFeeKurus: undefined }));
    const admin = w.token('ops-1', 'platform_admin', '');
    const path = `/api/admin/payments/apartments/${APT}/account`;
    const set = await w.call('PATCH', path, admin, { posRateBasisPoints: 199, posFixedFeeKurus: 30 });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({ posRateBasisPoints: 199, posFixedFeeKurus: 30, effectiveFees: { platformBasisPoints: 75, posRateBasisPoints: 199, posFixedFeeKurus: 30 } });
    const reset = await w.call('PATCH', path, admin, { posRateBasisPoints: null });
    expect(reset.body.posRateBasisPoints).toBeUndefined();
    expect(reset.body.effectiveFees).toEqual({ platformBasisPoints: 75, posRateBasisPoints: 0, posFixedFeeKurus: 30 });
    expect((await w.call('PATCH', path, admin, { posRateBasisPoints: 5_000 })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Online Odeme v2 · P2: coklu saglayici (kayit, cozumleyici, apartman tercihi)
// ---------------------------------------------------------------------------

describe('odeme saglayici kaydi ve cozumleyici (P2)', () => {
  const fakeA = createFakePaymentProvider({ apiBaseUrl: 'https://api.test' });
  const iyz = { ...createFakePaymentProvider({ apiBaseUrl: 'https://api.test' }), name: 'iyzico' as const };

  it('kayit: tek saglayici varsayilandir; birden fazlasinda varsayilan zorunlu ve acik olmali; ad tekil', () => {
    expect(createProviderRegistry([fakeA]).defaultName).toBe('fake');
    expect(() => createProviderRegistry([fakeA, iyz])).toThrow(/varsayilan/);
    expect(() => createProviderRegistry([fakeA], 'iyzico')).toThrow(/acik degil/);
    expect(() => createProviderRegistry([fakeA, fakeA], 'fake')).toThrow(/iki kez/);
    const r = createProviderRegistry([fakeA, iyz], 'iyzico');
    expect(r.list().map((p) => p.name)).toEqual(['iyzico', 'fake']);
    expect(r.get('paytr')).toBeUndefined();
    expect(r.get('__proto__')).toBeUndefined();
    expect(r.has('fake')).toBe(true);
  });

  it('cozumleme: apartman tercihi > ortam varsayilani; kapali tercih sessizce baska saglayiciya dusmez', () => {
    const r = createProviderRegistry([fakeA, iyz], 'iyzico');
    expect(resolveProvider(r, undefined)).toMatchObject({ name: 'iyzico', source: 'default', provider: iyz });
    expect(resolveProvider(r, 'fake')).toMatchObject({ name: 'fake', source: 'apartment', provider: fakeA });
    expect(resolveProvider(r, 'paytr')).toEqual({ name: 'paytr', provider: undefined, source: 'apartment' });
    expect(resolveProvider(createProviderRegistry([]), undefined)).toEqual({ source: 'none' });
  });

  it('yapilandirma: PAYMENTS_PROVIDERS + DEFAULT_PAYMENT_PROVIDER kurallari', () => {
    const urls = { PAYMENTS_API_BASE_URL: 'https://a.b', WEB_APP_URL: 'https://c.d' };
    expect(loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'fake', ...urls }).providers.defaultName).toBe('fake');
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'fake,iyzico', ...urls })).toThrow(/DEFAULT_PAYMENT_PROVIDER zorunlu/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'fake', DEFAULT_PAYMENT_PROVIDER: 'iyzico', ...urls })).toThrow(/PAYMENTS_PROVIDERS icinde/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'fake', DEFAULT_PAYMENT_PROVIDER: 'stripe', ...urls })).toThrow(/Bilinmeyen/);
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'fake,fake', ...urls })).toThrow(/iki kez/);
    expect(() => loadPaymentsConfig({ DEFAULT_PAYMENT_PROVIDER: 'iyzico' })).toThrow(/acik saglayici yok/);
    // P3: PayTR fabrikasi bagli; anahtar kaynagi zorunlu.
    expect(() => loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'paytr', ...urls })).toThrow(/PAYTR_MERCHANT_ID/);
    // Yeni ad eski tekil adi gecersiz kilar.
    expect(loadPaymentsConfig({ PAYMENTS_PROVIDERS: 'disabled', PAYMENTS_PROVIDER: 'fake', ...urls }).providers.list()).toEqual([]);
  });

  it('saglayici sozlesmesi: yetenekler ve tarayici donusu (token yoksa gecersiz)', () => {
    for (const p of [fakeA, createIyzicoProvider({ client: createIyzicoClient({ baseUrl: 'https://sandbox-api.iyzipay.com', credentials: async () => ({ apiKey: 'k', secretKey: 's' }) }), sandbox: true })]) {
      expect(p.capabilities).toEqual({ checkout: 'redirect', settlement: 'item_approval', requiresBuyerGsm: true });
      expect(typeof p.releaseItem).toBe('function');
      expect(p.parseCallback({ query: {}, body: { token: 't-1' } })).toEqual({ token: 't-1' });
      expect(p.parseCallback({ query: {}, body: {} })).toBeNull();
      expect(p.parseCallback({ query: {}, body: { token: 'x'.repeat(513) } })).toBeNull();
    }
  });
});

describe('odeme - apartman bazinda saglayici secimi (P2, uctan uca)', () => {
  const SECRET2 = 'sandbox-secret-p2';
  function world() {
    const server = fakeIyzicoServer(SECRET2);
    const client = createIyzicoClient({ baseUrl: 'https://sandbox-api.iyzipay.com', credentials: async () => ({ apiKey: 'k', secretKey: SECRET2 }), fetch: server.fetchFn });
    const iyzico = createIyzicoProvider({ client, sandbox: true, now: () => new Date('2026-11-06T10:00:00Z') });
    const w = setup({ extraProviders: [iyzico], defaultProvider: 'fake' });
    return { w, server, admin: w.token('ops-1', 'platform_admin', '') };
  }
  const settingsPath = `/api/admin/payments/apartments/${APT}/settings`;

  it('tercih degisir: yeni niyet yeni saglayicida, devam eden niyet kendi saglayicisinda tamamlanir', async () => {
    const { w, server, admin } = world();
    expect((await w.call('GET', settingsPath, admin)).body).toMatchObject({
      paymentProvider: null,
      defaultProvider: 'fake',
      effectiveProvider: 'fake',
      source: 'default',
      version: 0,
      available: [{ name: 'fake' }, { name: 'iyzico' }],
    });

    // A: ortam varsayilaniyla (sahte saglayici) baslatildi, henuz odenmedi.
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const intentA = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body.intentId as string;
    expect(w.intentOf(intentA)).toMatchObject({ provider: 'fake', checkout: { kind: 'redirect' } });

    // Platform: apartman iyzico'ya alinir ve iyzico'da alt uye isyeri acilir (provider verilmeden: cozumlenen).
    const put = await w.call('PUT', settingsPath, admin, { paymentProvider: 'iyzico', expectedVersion: 0 });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ paymentProvider: 'iyzico', effectiveProvider: 'iyzico', source: 'apartment', version: 1, updatedBy: 'ops-1' });
    expect((await w.call('PUT', settingsPath, admin, { paymentProvider: 'iyzico', expectedVersion: 0 })).status).toBe(409);
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ audit: 'PAYMENT_SETTINGS_UPDATED', from: null, to: 'iyzico' }) }));
    // iyzico hesabi yokken online odeme kapali (sahte saglayicinin varsayilan hesabina dusulmez).
    expect((await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'))).body.onlinePaymentEnabled).toBe(false);
    const onboard = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, {
      email: 'yonetim@lale.test',
      gsmNumber: '0532 123 45 67',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR33 0006 1005 1978 6457 8413 26',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
    });
    expect(onboard.body).toMatchObject({ provider: 'iyzico', subMerchantKey: `smk-${APT}` });
    expect((await w.call('GET', `/api/admin/payments/apartments/${APT}/account?provider=fake`, admin)).status).toBe(404);
    expect((await w.call('GET', `/api/admin/payments/apartments/${APT}/account?provider=paytr`, admin)).status).toBe(400);

    // B: yeni niyet iyzico'da.
    await w.charge('u2', 'owner', TL(500), '2026-11-10', 'c2', '2026-11-01');
    const b = await w.call('POST', '/api/portal/payments', w.token('owner-2'), { idempotencyKey: 'k-2', mode: 'total' });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ paymentPageUrl: 'https://sandbox-cpp.iyzipay.com?token=iyz-tok-1', checkoutKind: 'redirect' });
    expect(w.intentOf(b.body.intentId).provider).toBe('iyzico');

    // A kendi saglayicisinda (sahte) tamamlanir; onayi da sahte saglayiciya gider.
    await w.payThroughProvider(intentA);
    expect(w.intentOf(intentA)).toMatchObject({ status: 'SUCCEEDED', provider: 'fake', settlement: { status: 'approved' } });
    expect(w.fake.approvals.size).toBe(1);
    expect(server.approvals).toHaveLength(0);

    // B'nin token'i sahte saglayicinin callback'ine gelirse sonuclandirilmaz.
    server.sessions.get('iyz-tok-1')!.paid = true;
    const wrong = await w.app.request(`/api/payments/fake/callback?ref=${encodeURIComponent(`${APT}:${b.body.intentId}`)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=iyz-tok-1',
    });
    expect(wrong.status).toBe(303);
    expect(w.intentOf(b.body.intentId).status).toBe('PENDING');
    // Sahte saglayicinin webhook'u yok; bilinmeyen saglayici 404.
    expect((await w.app.request('/api/payments/fake/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
    expect((await w.app.request('/api/payments/paytr/webhook', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status).toBe(404);

    // iyzico callback'i (form token) -> iyzico sorgusu -> defter + iyzico kalem onayi.
    const cb = await w.app.request(`/api/payments/iyzico/callback?ref=${encodeURIComponent(`${APT}:${b.body.intentId}`)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'token=iyz-tok-1',
    });
    expect(cb.status).toBe(303);
    expect(w.intentOf(b.body.intentId)).toMatchObject({ status: 'SUCCEEDED', settlement: { status: 'approved' } });
    expect(server.approvals).toEqual([expect.objectContaining({ paymentTransactionId: 'ptx-iyz-tok-1-1' })]);

    // Mutabakat her niyeti kendi saglayicisiyla isler (iki saglayici da acik).
    w.clock.now = new Date('2026-11-06T11:00:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals.checked).toBe(0);

    // Yonetici ozeti ve platform listesi etkin saglayiciyi gosterir.
    expect((await w.call('GET', '/api/finance/online-payments/account', w.token('mgr-1', 'apartment_manager'))).body).toMatchObject({ provider: 'iyzico', status: 'active' });
    const list = (await w.call('GET', '/api/admin/payments/apartments', admin)).body;
    expect(list).toMatchObject({ provider: 'fake', providers: [{ name: 'fake' }, { name: 'iyzico' }] });
    expect(list.items[0]).toMatchObject({ paymentProvider: 'iyzico', effectiveProvider: 'iyzico', account: { provider: 'iyzico' } });

    // null: ortam varsayilanina donus.
    const reset = await w.call('PUT', settingsPath, admin, { paymentProvider: null, expectedVersion: 1 });
    expect(reset.body).toMatchObject({ paymentProvider: null, effectiveProvider: 'fake', source: 'default', version: 2 });
  });

  it('dogrulama: yalnizca bu ortamda acik saglayici; expectedVersion zorunlu; yalnizca platform_admin', async () => {
    const { w, admin } = world();
    expect((await w.call('PUT', settingsPath, admin, { paymentProvider: 'paytr', expectedVersion: 0 })).status).toBe(400);
    expect((await w.call('PUT', settingsPath, admin, { paymentProvider: 'iyzico' })).status).toBe(400);
    expect((await w.call('PUT', settingsPath, admin, { expectedVersion: 0 })).status).toBe(400);
    expect((await w.call('PUT', `/api/admin/payments/apartments/apt-yok/settings`, admin, { paymentProvider: null, expectedVersion: 0 })).status).toBe(404);
    expect((await w.call('PUT', settingsPath, w.token('mgr-1', 'apartment_manager'), { paymentProvider: null, expectedVersion: 0 })).status).toBe(403);
  });

  it('tercih edilen saglayici bu ortamda kapaliysa apartman icin online odeme kapali', async () => {
    const { w, admin } = world();
    await w.payRepo.repo.putSettings({ ...paymentKeys.settings(APT), entityType: 'PAYMENT_SETTINGS', apartmentId: APT, paymentProvider: 'paytr', ...audit });
    await w.charge('u1', 'occupant', TL(100), '2026-11-10', 'c1', '2026-11-01');
    expect((await w.call('GET', '/api/portal/payments/quote', w.token('tenant-1'))).body.onlinePaymentEnabled).toBe(false);
    const res = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(res.body.error).toBe('payments_disabled');
    expect(w.logs).toContainEqual(expect.objectContaining({ level: 'warn', fields: expect.objectContaining({ paymentProvider: 'paytr' }) }));
    expect((await w.call('GET', settingsPath, admin)).body).toMatchObject({ paymentProvider: 'paytr', effectiveProvider: null, source: 'apartment' });
    expect((await w.call('GET', `/api/admin/payments/apartments/${APT}/account`, admin)).body.error).toBe('payments_disabled');
    expect((await w.call('GET', '/api/admin/payments/apartments', admin)).body.items[0]).toMatchObject({ effectiveProvider: null, account: null });
  });
});

// ---------------------------------------------------------------------------
// Online Odeme v2 · P3: PayTR iFrame (sahte PayTR HTTP sunucusu)
// ---------------------------------------------------------------------------

const PAYTR = { merchantId: '100001', merchantKey: 'KEY123', merchantSalt: 'SALT456' };

function fakePaytrServer() {
  const tokens: Record<string, string>[] = [];
  const refunds: Record<string, string>[] = [];
  // P4: platform transferi, geri donen aktarimlar, yeniden gonderim.
  const transfers: Record<string, string>[] = [];
  const resends: Record<string, string>[] = [];
  const returned: Record<string, string>[] = [];
  const failNext: { transfer?: Record<string, unknown>; resend?: Record<string, unknown> } = {};
  const paid = new Map<string, { amount: string; fee?: string }>();
  const bad: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')));
    const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
    const expectToken = (hashStr: string) => {
      if (form.paytr_token !== paytrToken(PAYTR, hashStr)) bad.push(path);
    };
    if (form.merchant_key || form.merchant_salt) bad.push(`${path}:secret-sent`);
    if (path === '/odeme/api/get-token') {
      expectToken(form.merchant_id! + form.user_ip + form.merchant_oid + form.email + form.payment_amount + form.user_basket + form.no_installment + form.max_installment + form.currency + form.test_mode);
      tokens.push(form);
      return json({ status: 'success', token: `ptk-${tokens.length}` });
    }
    if (path === '/odeme/durum-sorgu') {
      expectToken(form.merchant_id! + form.merchant_oid);
      const p = paid.get(form.merchant_oid!);
      if (!p) return json({ status: 'error', err_no: '004', err_msg: 'merchant_oid ile basarili odeme bulunamadi' });
      const returns = refunds.filter((r) => r.merchant_oid === form.merchant_oid).map((r) => ({ return_amount: r.return_amount }));
      return json({ status: 'success', payment_amount: p.amount, payment_total: p.amount, payment_date: '2026-11-06 13:05:00', currency: 'TL', kesinti_tutari: p.fee ?? '0', returns });
    }
    if (path === '/odeme/platform/transfer') {
      expectToken(form.merchant_id! + form.merchant_oid + form.trans_id + form.submerchant_amount + form.total_amount + form.transfer_name + form.transfer_iban);
      if (failNext.transfer) {
        const e = failNext.transfer;
        failNext.transfer = undefined;
        return json(e);
      }
      transfers.push(form);
      return json({ status: 'success', merchant_amount: '0', submerchant_amount: form.submerchant_amount, trans_id: form.trans_id, reference: `REF${transfers.length}` });
    }
    if (path === '/odeme/geri-donen-transfer') {
      expectToken(form.merchant_id! + form.start_date + form.end_date);
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(form.start_date ?? '')) bad.push('returned:date');
      return json(returned.length ? { status: 'success', data: returned } : { status: 'failed' });
    }
    if (path === '/odeme/hesaptan-gonder') {
      expectToken(form.merchant_id! + form.trans_id);
      if (failNext.resend) {
        const e = failNext.resend;
        failNext.resend = undefined;
        return json(e);
      }
      resends.push(form);
      return json({ status: 'success', trans_id: form.trans_id });
    }
    if (path === '/odeme/iade') {
      expectToken(form.merchant_id! + form.merchant_oid + form.return_amount);
      refunds.push(form);
      return json({ status: 'success', is_test: 1, merchant_oid: form.merchant_oid, return_amount: form.return_amount, reference_no: form.reference_no });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, tokens, refunds, paid, bad, transfers, resends, returned, failNext };
}

describe('odeme - PayTR iFrame ile uctan uca (P3, sahte HTTP)', () => {
  async function world() {
    const server = fakePaytrServer();
    const paytr = createPaytrProvider({ client: createPaytrClient({ credentials: async () => PAYTR, fetch: server.fetchFn }), testMode: true });
    const w = setup({ extraProviders: [paytr], defaultProvider: 'paytr' });
    const admin = w.token('ops-1', 'platform_admin', '');
    const onboard = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, {
      email: 'yonetim@lale.test',
      gsmNumber: '0532 123 45 67',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR33 0006 1005 1978 6457 8413 26',
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
      platformFeeBasisPoints: 0,
    });
    expect(onboard.body).toMatchObject({ provider: 'paytr', subMerchantKey: 'paytr-apt1', status: 'active' });
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const created = await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' });
    expect(created.status).toBe(201);
    const intentId = created.body.intentId as string;
    return { w, server, admin, created, intentId, oid: paytrMerchantOid(intentId) };
  }

  const notify = (w: ReturnType<typeof setup>, fields: Record<string, string>, hash?: string) =>
    w.app.request('/api/payments/paytr/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        ...fields,
        hash: hash ?? notificationHash(PAYTR, { merchantOid: fields.merchant_oid!, status: fields.status!, totalAmount: fields.total_amount! }),
      }).toString(),
    });

  it('token (iFrame) -> donus -> imzali bildirim (OK) -> durum sorgusu -> defter; transfer P4e kadar bekler', async () => {
    const { w, server, created, intentId, oid } = await world();
    expect(created.body).toMatchObject({ checkoutKind: 'iframe', paymentPageUrl: 'https://www.paytr.com/odeme/guvenli/ptk-1', amount: TL(1000) });
    // Alfanumerik (gercekte 14 hane zaman + 32 hex = 46 karakter; testte kisa kimlik).
    expect(oid).toBe(intentId.replace(/-/g, ''));
    const t = server.tokens[0]!;
    expect(t).toMatchObject({
      merchant_id: '100001',
      user_ip: '203.0.113.7',
      merchant_oid: oid,
      email: 'ayse@example.com',
      payment_amount: '100000',
      no_installment: '1',
      max_installment: '0',
      currency: 'TL',
      test_mode: '1',
      timeout_limit: '30',
      user_name: 'Ayşe Nur Yılmaz',
      user_phone: '+905350000000',
      merchant_ok_url: `https://api.test/api/payments/paytr/callback?ref=${encodeURIComponent(`${APT}:${intentId}`)}&result=ok`,
      merchant_fail_url: `https://api.test/api/payments/paytr/callback?ref=${encodeURIComponent(`${APT}:${intentId}`)}&result=fail`,
    });
    expect(JSON.parse(Buffer.from(t.user_basket!, 'base64').toString('utf8'))).toEqual([['Aidat ödemesi · Daire U1 · Sakin', '1000.00', 1]]);
    expect(server.bad).toEqual([]);
    // Esleme kaydi niyetle ayni atomik yazimda.
    expect(w.fin.docs.get(`PAYREF#paytr#${oid}|PAYREF`)).toMatchObject({ apartmentId: APT, intentId, provider: 'paytr' });
    expect(w.intentOf(intentId)).toMatchObject({ provider: 'paytr', providerReference: oid, checkout: { kind: 'iframe', token: 'ptk-1' } });

    // Tarayici donusu (GET, bildirimden once): sonuc henuz yok; web sonuc sayfasina tasinir.
    const back = await w.app.request(`/api/payments/paytr/callback?ref=${encodeURIComponent(`${APT}:${intentId}`)}&result=ok`);
    expect(back.status).toBe(303);
    expect(back.headers.get('location')).toBe(`https://web.test/app/odeme/sonuc?intent=${intentId}&result=ok`);
    expect(w.intentOf(intentId).status).toBe('PENDING');

    // Gecersiz imza: 401, islem yok.
    server.paid.set(oid, { amount: '1000,00', fee: '26.50' });
    const forged = await notify(w, { merchant_oid: oid, status: 'success', total_amount: '100000' }, 'AAAA');
    expect(forged.status).toBe(401);
    expect(w.intentOf(intentId).status).toBe('PENDING');

    const ok = await notify(w, { merchant_oid: oid, status: 'success', total_amount: '100000', payment_type: 'card', currency: 'TL' });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('OK');
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(w.intentOf(intentId)).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: oid,
      paidAt: '2026-11-06',
      itemTransactions: [{ itemId: `${intentId}-occupant`, paymentTransactionId: `${oid}-occupant`, paidAmount: TL(1000) }],
      settlement: { status: 'pending', providerFee: 2_650, approvals: [{ status: 'pending', attempts: 0 }] },
    });
    expect([...w.fin.payments.values()][0]).toMatchObject({ provider: 'paytr', providerPaymentId: oid });
    expect(w.fin.balanceOf('recv-u1-occupant')).toBe(0);

    // Tekrar gelen bildirim (PayTR OK alamazsa dakikada bir dener): yine OK, cift yazim yok.
    const again = await notify(w, { merchant_oid: oid, status: 'success', total_amount: '100000' });
    expect(await again.text()).toBe('OK');
    expect(w.fin.batches).toHaveLength(1);

    // P4 kancasi: Platform Transfer henuz yok -> kalem bekler, deneme harcanmaz, alarm yok.
    w.clock.now = new Date('2026-11-06T11:00:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals).toEqual({ checked: 1, approved: 0, pending: 1, failed: 0 });
    expect(w.intentOf(intentId).settlement?.approvals[0]).toMatchObject({ status: 'pending', attempts: 0 });
    expect(w.logs.some((l) => l.fields?.alert === 'PAYMENT_APPROVAL_FAILED')).toBe(false);
  });

  it('basarisiz bildirim: niyet hemen dusmez, sure dolunca FAILED; gec basari NEEDS_REVIEW -> iade', async () => {
    const { w, server, intentId, oid } = await world();
    const failed = await notify(w, { merchant_oid: oid, status: 'failed', total_amount: '100000', failed_reason_code: '2', failed_reason_msg: 'Kart limiti yetersiz' });
    expect(await failed.text()).toBe('OK');
    expect(w.intentOf(intentId)).toMatchObject({ status: 'PENDING', providerNotice: { status: 'failure', code: '2', message: 'Kart limiti yetersiz' } });
    expect((await w.call('GET', `/api/portal/payments/${intentId}`, w.token('tenant-1'))).body).toMatchObject({
      status: 'PENDING',
      failureMessage: 'Ödeme tamamlanamadı: Kart limiti yetersiz',
    });

    // Sayfa suresi (30 dk) dolmadan mutabakat sonuclandirmaz; dolunca bildirimin koduyla FAILED.
    w.clock.now = new Date('2026-11-06T10:31:00.000Z');
    expect((await w.payments.reconcile(APT)).checked).toBe(1);
    expect(w.intentOf(intentId).status).toBe('FAILED');
    expect(w.intentOf(intentId).failure).toMatchObject({ code: 'provider_2', message: 'Kart limiti yetersiz' });

    // Gec gelen basari (para tahsil edilmis): defter yazilmaz, inceleme + alarm.
    server.paid.set(oid, { amount: '1000.00' });
    expect(await (await notify(w, { merchant_oid: oid, status: 'success', total_amount: '100000' })).text()).toBe('OK');
    expect(w.intentOf(intentId)).toMatchObject({ status: 'NEEDS_REVIEW', providerPaymentId: oid });
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ alert: 'PAYMENT_NEEDS_REVIEW', intentId }) }));
    expect(w.fin.batches).toHaveLength(0);

    // Platform tam iade: PayTR siparis bazli `/odeme/iade`.
    const r = await w.call('POST', `/api/admin/payments/apartments/${APT}/intents/${intentId}/resolve`, w.token('ops-1', 'platform_admin', ''), {
      action: 'refund',
      note: 'Gec gelen basari, tam iade',
      expectedVersion: w.intentOf(intentId).version,
    });
    expect(r.status).toBe(200);
    expect(r.body.intent).toMatchObject({ status: 'REFUNDED', refundedAmount: TL(1000) });
    expect(server.refunds).toEqual([
      expect.objectContaining({ merchant_id: '100001', merchant_oid: oid, return_amount: '1000.00', reference_no: `refund${intentId.replace(/-/g, '')}1` }),
    ]);
    expect(server.bad).toEqual([]);
    const provider = w.payments.providers.get('paytr')!;
    expect(await provider.refundedAmounts({ providerPaymentId: oid, conversationId: `${APT}:${intentId}`, items: [{ paymentTransactionId: `${oid}-occupant`, amount: toKurus(TL(1000)) }] })).toEqual(
      new Map([[`${oid}-occupant`, TL(1000)]]),
    );
  });

  it('bilinmeyen siparis gecerli imzayla OK; imzasiz/eksik govde 401; baska saglayicinin niyeti etkilenmez', async () => {
    const { w } = await world();
    expect(await (await notify(w, { merchant_oid: 'YOK123', status: 'success', total_amount: '100' })).text()).toBe('OK');
    expect((await w.app.request('/api/payments/paytr/webhook', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=1' })).status).toBe(401);
    // Sahte saglayicinin niyetine ait bir oid PayTR esleme kaydinda yoktur.
    expect(w.fin.docs.has('PAYREF#fake#x|PAYREF')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Online Odeme v2 · P4: PayTR Platform Transfer, KMS ile sifreli alici, geri donen aktarimlar
// ---------------------------------------------------------------------------

const IBAN1 = 'TR330006100519786457841326';
const IBAN2 = 'TR320010009999901234567890';

describe('odeme - PayTR Platform Transfer ve geri donen aktarimlar (P4)', () => {
  async function world(opts: { payoutMode?: 'send' | 'defer'; delayHours?: number } = {}) {
    const server = fakePaytrServer();
    const paytr = createPaytrProvider({
      client: createPaytrClient({ credentials: async () => PAYTR, fetch: server.fetchFn }),
      testMode: true,
      ...(opts.delayHours !== undefined ? { transferDelayHours: opts.delayHours } : {}),
    });
    const w = setup({ extraProviders: [paytr], defaultProvider: 'paytr', payoutMode: opts.payoutMode ?? 'send' });
    const admin = w.token('ops-1', 'platform_admin', '');
    const onboard = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, {
      email: 'yonetim@lale.test',
      gsmNumber: '0532 123 45 67',
      address: 'Lale Sk. 1, Kadıköy',
      iban: 'TR33 0006 1005 1978 6457 8413 26',
      accountHolderName: 'Lale Apartmanı  Yönetimi',
      taxOffice: 'Kadıköy',
      taxNumber: '1234567890',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
      platformFeeBasisPoints: 75,
    });
    expect(onboard.status).toBe(201);
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    const intentId = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body.intentId as string;
    const oid = paytrMerchantOid(intentId);
    server.paid.set(oid, { amount: '1000.00' });
    const ok = await w.app.request('/api/payments/paytr/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ merchant_oid: oid, status: 'success', total_amount: '100000', hash: notificationHash(PAYTR, { merchantOid: oid, status: 'success', totalAmount: '100000' }) }).toString(),
    });
    expect(await ok.text()).toBe('OK');
    expect(w.intentOf(intentId).status).toBe('SUCCEEDED');
    return { w, server, admin, intentId, oid, transferId: `${oid}O`, onboard };
  }

  const transferHook = (w: ReturnType<typeof setup>, fields: Record<string, string>) =>
    w.app.request('/api/payments/paytr/transfer-webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    });

  it('alici KMS kasasinda: kayitta yalnizca sifreli metin, yanitta/logda yalnizca maskeli IBAN', async () => {
    const { w, onboard } = await world();
    expect(onboard.body).toMatchObject({ provider: 'paytr', payeeOnFile: true, ibanMasked: 'TR** **** **** **** **** **13 26' });
    expect(JSON.stringify(onboard.body)).not.toMatch(/payeeCiphertext|TR330006/);
    const acc = w.fin.docs.get(`APT#${APT}|PAYACCT#paytr`) as unknown as PaymentAccount;
    expect(acc.payeeCiphertext).toMatch(/^local:/);
    // Sifreleme baglami apartmana bagli: baska apartman adina cozulemez.
    expect(await w.vault!.open({ apartmentId: APT, provider: 'paytr' }, acc.payeeCiphertext!)).toEqual({ iban: IBAN1, name: 'Lale Apartmanı Yönetimi' });
    await expect(w.vault!.open({ apartmentId: OTHER_APT, provider: 'paytr' }, acc.payeeCiphertext!)).rejects.toMatchObject({ code: 'payee_corrupt' });
    const everything = JSON.stringify([...w.fin.docs.values()]) + JSON.stringify(w.logs);
    expect(everything).not.toContain(IBAN1);

    // Guncelleme: IBAN ve ad birlikte; gecersiz IBAN (mod-97) reddedilir.
    const path = `/api/admin/payments/apartments/${APT}/account`;
    const admin = w.token('ops-1', 'platform_admin', '');
    expect((await w.call('PATCH', path, admin, { iban: 'TR320010009999901234567891', accountHolderName: 'X Y' })).body).toMatchObject({ error: 'validation_error', field: 'iban' });
    expect((await w.call('PATCH', path, admin, { iban: IBAN2 })).body).toMatchObject({ error: 'validation_error', field: 'accountHolderName' });
    const upd = await w.call('PATCH', path, admin, { iban: IBAN2, accountHolderName: 'Lale Site Yönetimi' });
    expect(upd.body).toMatchObject({ ibanMasked: 'TR** **** **** **** **** **78 90', payeeOnFile: true });
    expect(JSON.stringify([...w.fin.docs.values()]) + JSON.stringify(w.logs)).not.toContain(IBAN2);
  });

  it('kasa yoksa PayTR hesabi acilmaz (alicisiz transfer yapilamaz)', async () => {
    const server = fakePaytrServer();
    const paytr = createPaytrProvider({ client: createPaytrClient({ credentials: async () => PAYTR, fetch: server.fetchFn }), testMode: true });
    const w = setup({ extraProviders: [paytr], defaultProvider: 'paytr', vault: false });
    const res = await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, w.token('ops-1', 'platform_admin', ''), {
      email: 'y@l.test',
      gsmNumber: '05321234567',
      address: 'Lale Sk. 1',
      iban: IBAN1,
      taxOffice: 'Kadıköy',
      legalCompanyTitle: 'Lale Yönetimi',
    });
    expect(res).toMatchObject({ status: 502, body: { error: 'payee_vault_unavailable' } });
    expect(w.fin.docs.has(`APT#${APT}|PAYACCT#paytr`)).toBe(false);
  });

  it('bekleme suresi -> worker talimati gonderir -> sonuc bildirimi SETTLED; API (defer) gondermez', async () => {
    const { w, server, intentId, oid, transferId } = await world();
    const a0 = w.intentOf(intentId).settlement!.approvals[0]!;
    // 10:00Z + 24 saat (ertesi gun kuralindan sonra).
    expect(a0).toMatchObject({ status: 'pending', releaseAfter: '2026-11-07T10:00:00.000Z' });
    const v = w.intentOf(intentId).version;

    // Sure dolmadan: talimat yok, kayit degismez (surum ayni).
    w.clock.now = new Date('2026-11-07T09:00:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals).toMatchObject({ checked: 1, pending: 1 });
    expect(server.transfers).toHaveLength(0);
    expect(w.intentOf(intentId).version).toBe(v);

    w.clock.now = new Date('2026-11-07T10:05:00.000Z');
    expect((await w.payments.reconcile(APT)).approvals).toMatchObject({ approved: 1 });
    expect(server.transfers).toEqual([
      {
        merchant_id: '100001',
        merchant_oid: oid,
        trans_id: transferId,
        submerchant_amount: String(TL(1000) - 750),
        total_amount: String(TL(1000)),
        transfer_name: 'Lale Apartmanı Yönetimi',
        transfer_iban: IBAN1,
        paytr_token: expect.any(String),
      },
    ]);
    expect(server.bad).toEqual([]);
    expect(w.intentOf(intentId).settlement).toMatchObject({ status: 'approved', approvals: [{ status: 'approved', transferId, providerReference: 'REF1' }] });
    const payout = await w.payRepo.repo.getPayout(APT, transferId);
    expect(payout).toMatchObject({ status: 'SENT', amount: TL(1000) - 750, grossAmount: TL(1000), ibanMasked: 'TR** **** **** **** **** **13 26', ibanLast4: '1326', providerReference: 'REF1' });
    expect(w.fin.docs.get(`PAYOUTREF#paytr#${transferId}|PAYOUTREF`)).toMatchObject({ apartmentId: APT, transferId });
    expect(JSON.stringify([...w.fin.docs.values()])).not.toContain(IBAN1);

    // Transfer sonuc bildirimi: imza ters bolu cizgisiz `trans_ids` + salt uzerinden.
    const raw = JSON.stringify([transferId]).replace(/"/g, '\\"');
    const good = { trans_ids: raw, hash: paytrHash(PAYTR.merchantKey, JSON.stringify([transferId]) + PAYTR.merchantSalt) };
    expect((await transferHook(w, { ...good, hash: 'AAAA' })).status).toBe(401);
    const res = await transferHook(w, good);
    expect(await res.text()).toBe('OK');
    expect(await w.payRepo.repo.getPayout(APT, transferId)).toMatchObject({ status: 'SETTLED', settledAt: '2026-11-07T10:05:00.000Z' });
    expect(await (await transferHook(w, good)).text()).toBe('OK'); // tekrar: degismez

    // API servisi (defer) vadesi gelmis olsa da gondermez.
    const api = await world({ payoutMode: 'defer' });
    api.w.clock.now = new Date('2026-11-08T10:00:00.000Z');
    await api.w.payments.reconcile(APT);
    expect(api.server.transfers).toHaveLength(0);
  });

  it('ayni gun kurali: bekleme 0 saat olsa da talimat en erken ertesi gun (Istanbul)', async () => {
    const { w, intentId } = await world({ delayHours: 0 });
    expect(w.intentOf(intentId).settlement!.approvals[0]!.releaseAfter).toBe('2026-11-06T21:00:00.000Z');
    expect(payoutReleaseAfter(new Date('2026-11-06T20:59:00.000Z'), 0)).toBe('2026-11-06T21:00:00.000Z');
    expect(payoutReleaseAfter(new Date('2026-11-06T21:30:00.000Z'), 0)).toBe('2026-11-07T21:00:00.000Z');
    expect(payoutReleaseAfter(new Date('2026-11-06T10:00:00.000Z'), 48)).toBe('2026-11-08T10:00:00.000Z');
  });

  it('red: talimat basarisiz -> alarm; platform elle one ceker ve yeniden gonderir', async () => {
    const { w, server, admin, intentId } = await world();
    w.clock.now = new Date('2026-11-07T10:05:00.000Z');
    server.failNext.transfer = { status: 'error', err_no: '010', err_msg: 'Toplam transfer tutari kalan tutari asamaz' };
    await w.payments.reconcile(APT);
    expect(w.intentOf(intentId).settlement).toMatchObject({ status: 'failed', approvals: [{ status: 'failed', error: { code: 'paytr_010' } }] });
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ alert: 'PAYMENT_APPROVAL_FAILED', intentId }) }));

    const path = `/api/admin/payments/apartments/${APT}/intents/${intentId}/release`;
    expect((await w.call('POST', path, admin, { note: 'kisa', expectedVersion: w.intentOf(intentId).version })).status).toBe(400);
    expect((await w.call('POST', path, admin, { note: 'Tutar duzeltildi, tekrar gonder', expectedVersion: 1 })).status).toBe(409);
    const rel = await w.call('POST', path, admin, { note: 'Tutar duzeltildi, tekrar gonder', expectedVersion: w.intentOf(intentId).version });
    expect(rel.status).toBe(200);
    expect(rel.body.settlement).toMatchObject({ status: 'pending', approvals: [{ status: 'pending', attempts: 0, releaseAfter: '2026-11-07T10:05:00.000Z' }] });
    await w.payments.reconcile(APT);
    expect(server.transfers).toHaveLength(1);
    expect(w.intentOf(intentId).settlement?.status).toBe('approved');
    // Gonderilecek kalem kalmadi.
    expect((await w.call('POST', path, admin, { note: 'Tekrar gonderim denemesi', expectedVersion: w.intentOf(intentId).version })).body.error).toBe('action_not_allowed');
  });

  it('geri donen aktarim: gunluk tarama esler (kritik alarm), platform duzeltilmis IBAN ile yeniden gonderir', async () => {
    const { w, server, admin, transferId } = await world();
    w.clock.now = new Date('2026-11-07T10:05:00.000Z');
    await w.payments.reconcile(APT);
    w.clock.now = new Date('2026-11-09T09:00:00.000Z');
    server.returned.push(
      {
        ref_no: '1000001',
        transfer_iban: IBAN1,
        transfer_name: 'Lale Apartmanı Yönetimi',
        transfer_amount: '992.50',
        transfer_currency: 'TL',
        transfer_date: '2026-11-07 13:05:00',
        date_detected: '2026-11-08 11:00:00',
        date_reimbursed: '2026-11-08 15:00:00',
      },
      { ref_no: '1000002', transfer_iban: 'TR000000000000000000009999', transfer_name: 'Baska', transfer_amount: '5.00', transfer_currency: 'TL', transfer_date: '2026-11-07 13:05:00' },
    );
    expect(await w.payouts.detectReturned()).toEqual({ checked: 2, returned: 1, alreadyKnown: 0, unmatched: 1 });
    expect(await w.payRepo.repo.getPayout(APT, transferId)).toMatchObject({ status: 'RETURNED', returned: { refNo: '1000001', amount: 99_250, returnedOn: '2026-11-08 15:00:00' } });
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ alert: 'PAYOUT_RETURNED', severity: 'critical', transferId }) }));
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ alert: 'PAYOUT_RETURN_UNMATCHED', refNo: '1000002' }) }));
    expect(await w.payouts.detectReturned()).toMatchObject({ returned: 0, alreadyKnown: 1 });
    expect(server.bad).toEqual([]);

    // Platform listesi (varsayilan: ilgilenilmesi gerekenler).
    const list = await w.call('GET', '/api/admin/payments/payouts', admin);
    expect(list.body.items).toEqual([expect.objectContaining({ transferId, status: 'RETURNED', apartmentName: 'Lale Apartmani', ibanMasked: 'TR** **** **** **** **** **13 26' })]);
    expect((await w.call('GET', '/api/admin/payments/payouts?status=bogus', admin)).status).toBe(400);
    expect((await w.call('GET', '/api/admin/payments/payouts', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);

    // Duzeltilmis IBAN ile yeniden gonderim: hesap da guncellenir; gonderim worker'da.
    const path = `/api/admin/payments/apartments/${APT}/payouts/${transferId}/resend`;
    const v = (await w.payRepo.repo.getPayout(APT, transferId))!.version;
    expect((await w.call('POST', path, admin, { note: 'IBAN duzeltildi', expectedVersion: v, iban: 'TR320010009999901234567891', accountHolderName: 'X Y' })).body.field).toBe('iban');
    const req = await w.call('POST', path, admin, { note: 'IBAN duzeltildi', expectedVersion: v, iban: IBAN2, accountHolderName: 'Lale Site Yönetimi' });
    expect(req.status).toBe(200);
    expect(req.body).toMatchObject({ status: 'RESEND_PENDING', resendCount: 1, resend: { resendId: `${transferId}R1`, ibanMasked: 'TR** **** **** **** **** **78 90', attempts: 0 } });
    expect(JSON.stringify(req.body)).not.toMatch(/payeeCiphertext/);
    expect((w.fin.docs.get(`APT#${APT}|PAYACCT#paytr`) as unknown as PaymentAccount).ibanMasked).toBe('TR** **** **** **** **** **78 90');
    expect((await w.call('POST', path, admin, { note: 'IBAN duzeltildi', expectedVersion: req.body.version })).body.error).toBe('action_not_allowed');

    expect(await w.payouts.processResends()).toMatchObject({ checked: 1, sent: 1 });
    expect(server.resends).toEqual([
      {
        merchant_id: '100001',
        trans_id: `${transferId}R1`,
        trans_info: JSON.stringify([{ amount: '99250', receiver: 'Lale Site Yönetimi', iban: IBAN2 }]),
        paytr_token: expect.any(String),
      },
    ]);
    expect(server.bad).toEqual([]);
    expect(await w.payRepo.repo.getPayout(APT, transferId)).toMatchObject({ status: 'RESEND_SENT' });

    // Sonuc bildirimi (mode=cashout): basarili -> RESENT.
    const resendId = `${transferId}R1`;
    const hook = (result: string) => ({
      mode: 'cashout',
      merchant_id: '100001',
      trans_id: resendId,
      processed_result: JSON.stringify([{ amount: 992.5, receiver: 'Lale Site Yönetimi', iban: IBAN2, result }]),
      success_total: '1',
      failed_total: '0',
      hash: paytrHash(PAYTR.merchantKey, `100001${resendId}${PAYTR.merchantSalt}`),
    });
    expect((await transferHook(w, { ...hook('success'), merchant_id: '999' })).status).toBe(401);
    expect(await (await transferHook(w, hook('success'))).text()).toBe('OK');
    expect(await w.payRepo.repo.getPayout(APT, transferId)).toMatchObject({ status: 'RESENT', resend: { completedAt: '2026-11-09T09:00:00.000Z' } });
    expect(JSON.stringify([...w.fin.docs.values()]) + JSON.stringify(w.logs)).not.toMatch(new RegExp(`${IBAN1}|${IBAN2}`));
  });

  it('yeniden gonderim reddi -> RESEND_FAILED + alarm; tekrar istenebilir (kayitli alici ile)', async () => {
    const { w, server, admin, transferId } = await world();
    w.clock.now = new Date('2026-11-07T10:05:00.000Z');
    await w.payments.reconcile(APT);
    server.returned.push({ ref_no: '77', transfer_iban: IBAN1, transfer_amount: '992,50', transfer_date: '2026-11-07 13:05:00' });
    await w.payouts.detectReturned();
    const path = `/api/admin/payments/apartments/${APT}/payouts/${transferId}/resend`;
    let v = (await w.payRepo.repo.getPayout(APT, transferId))!.version;
    expect((await w.call('POST', path, admin, { note: 'Ayni IBANa tekrar', expectedVersion: v })).body.status).toBe('RESEND_PENDING');
    server.failNext.resend = { status: 'error', err_no: '011', err_msg: 'Yetersiz bakiye' };
    expect(await w.payouts.processResends()).toMatchObject({ failed: 1 });
    expect(await w.payRepo.repo.getPayout(APT, transferId)).toMatchObject({ status: 'RESEND_FAILED', resend: { error: { code: 'paytr_011' } } });
    expect(w.logs).toContainEqual(expect.objectContaining({ fields: expect.objectContaining({ alert: 'PAYOUT_FAILED', transferId }) }));
    v = (await w.payRepo.repo.getPayout(APT, transferId))!.version;
    const again = await w.call('POST', path, admin, { note: 'Bakiye yuklendi', expectedVersion: v });
    expect(again.body).toMatchObject({ status: 'RESEND_PENDING', resend: { resendId: `${transferId}R2` } });
    await w.payouts.processResends();
    expect(server.resends.map((r) => r.trans_id)).toEqual([`${transferId}R2`]);
  });
});

describe('platform komisyon faturasi (P4)', () => {
  async function paidWorld() {
    const w = setup();
    const admin = w.token('ops-1', 'platform_admin', '');
    await w.call('POST', `/api/admin/payments/apartments/${APT}/account`, admin, {
      email: 'yonetim@lale.test',
      gsmNumber: '0532 123 45 67',
      address: 'Lale Sk. 1, Kadıköy',
      iban: IBAN1,
      taxOffice: 'Kadıköy',
      taxNumber: '1234567890',
      legalCompanyTitle: 'Lale Apartmanı Yönetimi',
    });
    await w.charge('u1', 'occupant', TL(1000), '2026-11-10', 'c1', '2026-11-01');
    await w.charge('u2', 'owner', TL(333), '2026-11-10', 'c2', '2026-11-01');
    const a = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-1', mode: 'total' })).body.intentId as string;
    await w.payThroughProvider(a);
    w.clock.now = new Date('2026-11-06T10:05:00.000Z');
    const b = (await w.call('POST', '/api/portal/payments', w.token('owner-2'), { idempotencyKey: 'k-2', mode: 'total' })).body.intentId as string;
    await w.payThroughProvider(b);
    w.clock.now = new Date('2026-11-06T10:10:00.000Z');
    await w.charge('u1', 'occupant', TL(50), '2026-11-20', 'c3', '2026-11-06');
    const c = (await w.call('POST', '/api/portal/payments', w.token('tenant-1'), { idempotencyKey: 'k-3', mode: 'total' })).body.intentId as string;
    await w.payThroughProvider(c, 'failure');
    return { w, admin, a, b, c };
  }

  it('aylik taslak: yalnizca deftere yazilmis odemelerin platform payi, %20 KDV haric; idempotent', async () => {
    const { w, admin, a, b } = await paidWorld();
    w.clock.now = new Date('2026-12-01T01:10:00.000Z');
    const d = await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/draft`, admin, { period: '2026-11' });
    expect(d.body).toEqual({ period: '2026-11', mode: 'monthly', created: 1, updated: 0, unchanged: 0, locked: 0, intents: 2 });
    const inv = (await w.call('GET', `/api/admin/payments/apartments/${APT}/invoices`, admin)).body.items[0];
    // 1000 TL x %0,75 = 7,50 TL; 333 TL x %0,75 = 2,4975 -> 2,49 (asagi); net 9,99 TL, KDV 1,998 -> 2,00 (yarim yukari).
    expect(inv).toMatchObject({
      invoiceId: 'M-2026-11',
      status: 'DRAFT',
      recipient: { title: 'Lale Apartmanı Yönetimi', taxNumber: '1234567890', taxOffice: 'Kadıköy' },
      netAmount: 999,
      vatRateBasisPoints: 2000,
      vatMode: 'exclusive',
      vatAmount: 200,
      totalAmount: 1_199,
      reconciliation: { intentCount: 2, platformFeeTotal: 999 },
      invoiceProvider: 'manual',
      version: 1,
    });
    expect(inv.lines.map((l: { intentId: string }) => l.intentId).sort()).toEqual([a, b].sort());
    expect(inv.PK).toBeUndefined();
    expect((await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/draft`, admin, { period: '2026-11' })).body).toMatchObject({ unchanged: 1 });
    expect((await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/draft`, admin, { period: '2026-13' })).status).toBe(400);
    expect((await w.call('POST', '/api/admin/payments/apartments/yok/invoices/draft', admin, { period: '2026-11' })).status).toBe(404);

    // Kesim: manual saglayicida fatura numarasi zorunlu; kesilen taslak yeniden uretilmez/iptal edilmez.
    const base = `/api/admin/payments/apartments/${APT}/invoices/M-2026-11`;
    expect((await w.call('POST', `${base}/issue`, admin, { expectedVersion: 1 })).body.field).toBe('invoiceNumber');
    expect((await w.call('POST', `${base}/issue`, admin, { expectedVersion: 9, invoiceNumber: 'ABC2026000000001' })).status).toBe(409);
    const issued = await w.call('POST', `${base}/issue`, admin, { expectedVersion: 1, invoiceNumber: 'ABC2026000000001' });
    expect(issued.body).toMatchObject({ status: 'ISSUED', invoiceNumber: 'ABC2026000000001', issuedBy: 'ops-1', version: 2 });
    expect((await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/draft`, admin, { period: '2026-11' })).body).toMatchObject({ locked: 1 });
    expect((await w.call('POST', `${base}/cancel`, admin, { expectedVersion: 2, reason: 'Hatali taslak' })).body.error).toBe('action_not_allowed');

    const all = await w.call('GET', '/api/admin/payments/invoices?period=2026-11', admin);
    expect(all.body).toMatchObject({ period: '2026-11', totals: { net: 999, vat: 200, total: 1_199 }, items: [{ invoiceId: 'M-2026-11', apartmentName: 'Lale Apartmani' }] });
    expect((await w.call('GET', '/api/admin/payments/invoices?period=2026-11', w.token('mgr-1', 'apartment_manager'))).status).toBe(403);
  });

  it('muhatap (VKN) yoksa NEEDS_RECIPIENT; muhatap girilince taslak yenilenir; odeme bazli model ve KDV dahil', async () => {
    const { w, admin } = await paidWorld();
    const acct = `/api/admin/payments/apartments/${APT}/account`;
    expect((await w.call('PATCH', acct, admin, { invoiceRecipient: { title: 'X', taxNumber: '1', taxOffice: 'Y' } })).status).toBe(400);
    await w.call('PATCH', acct, admin, { invoiceRecipient: null });
    await w.invoices.draftPeriod(APT, '2026-11');
    expect(await w.payRepo.repo.getInvoice(APT, 'M-2026-11')).toMatchObject({ status: 'NEEDS_RECIPIENT', version: 1 });
    expect((await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/M-2026-11/issue`, admin, { expectedVersion: 1, invoiceNumber: 'ABC1' })).body.error).toBe('action_not_allowed');
    await w.call('PATCH', acct, admin, { invoiceRecipient: { title: 'Lale Yönetimi', taxNumber: '1234567890', taxOffice: 'Kadıköy' } });
    expect(await w.invoices.draftPeriod(APT, '2026-11')).toMatchObject({ updated: 1 });
    expect(await w.payRepo.repo.getInvoice(APT, 'M-2026-11')).toMatchObject({ status: 'DRAFT', version: 2, recipient: { taxNumber: '1234567890' } });
    expect((await w.call('POST', `/api/admin/payments/apartments/${APT}/invoices/M-2026-11/cancel`, admin, { expectedVersion: 2, reason: 'Elle kesilecek' })).body.status).toBe('CANCELLED');

    const perPayment = createInvoiceService({
      repository: w.payRepo.repo,
      settings: { mode: 'per_payment', vatRateBasisPoints: 2000, vatMode: 'inclusive' },
      core: { getSite: async () => undefined, listSiteIds: async () => [] },
      now: () => w.clock.now,
    });
    expect(await perPayment.draftPeriod(APT, '2026-11')).toMatchObject({ created: 2 });
    const items = (await w.payRepo.repo.listInvoices(APT)).filter((i) => i.mode === 'per_payment');
    // KDV dahil: 7,50 TL -> net round(750 / 1,2) = 625 kurus, KDV 125.
    expect(items.find((i) => i.totalAmount === 750)).toMatchObject({ netAmount: 625, vatAmount: 125, vatMode: 'inclusive' });
    expect(await perPayment.draftPeriod(APT, '2026-10')).toMatchObject({ intents: 0, created: 0 });
  });
});
