import { PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../src/auth/authenticators.js';
import type { Role } from '../src/auth/claims.js';
import {
  type DomainEvent,
  EventPublishError,
  type EventPublisher,
  buildEvent,
  createEventBridgePublisher,
  createEventPublisherFromEnv,
  createInMemoryEventPublisher,
  createSnsEventPublisher,
  publishSafely,
} from '../src/events/publisher.js';
import type { CoreRepository } from '../src/modules/core/repository.js';
import { type Block, type Site, type Unit, toKurus } from '../src/modules/core/types.js';
import {
  type FinanceRepository,
  LedgerConflictError,
  toLedgerEntries,
} from '../src/modules/finance/repository.js';
import { createFinanceService } from '../src/modules/finance/service.js';
import type {
  Account,
  IdempotencyRecord,
  LedgerEntry,
  Payment,
  Transaction,
} from '../src/modules/finance/types.js';
import type { PortalRepository } from '../src/modules/portal/repository.js';
import { allocateOpenDues, createPortalService } from '../src/modules/portal/service.js';
import type { Announcement, UnitMembership } from '../src/modules/portal/types.js';

// ---------------------------------------------------------------------------
// Bellek ici dunya: finans defteri + portal okuma modeli ayni veriyi paylasir
// ---------------------------------------------------------------------------

const NOW = new Date('2026-11-06T10:00:00.000Z'); // Istanbul: 2026-11-06
const APT = 'apt-1';
const OTHER_APT = 'apt-2';
const ts = NOW.toISOString();
const audit = { createdAt: ts, createdBy: 'seed', updatedAt: ts, updatedBy: 'seed', version: 1 };

function unit(id: string, apt = APT, blockId = 'b1'): Unit {
  return {
    PK: `APT#${apt}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    status: 'active',
    ...audit,
    unitId: id,
    siteId: apt,
    blockId,
    number: id.toUpperCase(),
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
  };
}

function member(
  userId: string,
  unitId: string,
  relation: UnitMembership['relation'],
  over: Partial<UnitMembership> = {},
): UnitMembership {
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

function createWorld() {
  const units: Unit[] = [unit('u1'), unit('u2'), unit('u3', APT, 'b2'), unit('x1', OTHER_APT)];
  const blocks: Block[] = [
    { PK: `APT#${APT}`, SK: 'BLOCK#b1', entityType: 'BLOCK', status: 'active', ...audit, blockId: 'b1', siteId: APT, name: 'A Blok' },
  ];
  const sites: Site[] = [
    {
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
    },
  ];
  const memberships: UnitMembership[] = [
    member('tenant-1', 'u1', 'tenant'),
    member('owner-1', 'u1', 'owner', { residesInUnit: false }),
    member('owner-2', 'u2', 'owner', { residesInUnit: true }),
    member('multi', 'u2', 'owner'),
    member('multi', 'u3', 'owner'),
    member('foreign', 'x1', 'tenant', { apartmentId: OTHER_APT }),
  ];
  const announcements: Announcement[] = [];

  const k = (apt: string, id: string) => `${apt}|${id}`;
  const accounts = new Map<string, Account>();
  const transactions = new Map<string, Transaction>();
  const payments = new Map<string, Payment>();
  const idem = new Map<string, IdempotencyRecord>();
  const counters = new Map<string, number>();
  const entries: LedgerEntry[] = [];
  /** Transactional outbox: defter yazimiyla ayni atomik islemde saklanan olaylar. */
  const outbox: DomainEvent[] = [];
  let failNextPost: Error | undefined;

  const financeRepo: FinanceRepository = {
    listTransactions: async (apt) => ({ items: [...transactions.values()].filter((t) => t.siteId === apt) }),
    getAccount: async (apt, id) => accounts.get(k(apt, id)),
    listAccounts: async (apt) => [...accounts.values()].filter((a) => a.siteId === apt),
    createAccount: async (a) => void accounts.set(k(a.siteId, a.accountId), a),
    updateAccount: async (a) => void accounts.set(k(a.siteId, a.accountId), a),
    ensureAccounts: async (list) => {
      for (const a of list) if (!accounts.has(k(a.siteId, a.accountId))) accounts.set(k(a.siteId, a.accountId), a);
    },
    getTransaction: async (apt, id) => transactions.get(k(apt, id)),
    getPayment: async (apt, id) => payments.get(k(apt, id)),
    getExpense: async () => undefined,
    getIdempotency: async (apt, id) => idem.get(k(apt, id)),
    getCounter: async (apt, name) => counters.get(k(apt, name)) ?? 0,
    postTransaction: async (input) => {
      if (failNextPost) {
        const e = failNextPost;
        failNextPost = undefined;
        throw e;
      }
      const tx = input.transaction;
      const apt = tx.siteId;
      if (idem.has(k(apt, input.idempotency.id))) throw new LedgerConflictError('duplicate');
      for (const e of input.outbox ?? []) if (outbox.some((o) => o.eventId === e.eventId)) throw new LedgerConflictError('duplicate');
      for (const l of tx.lines) if (!accounts.has(k(apt, l.accountId))) throw new LedgerConflictError('account_missing');
      idem.set(k(apt, input.idempotency.id), {
        transactionId: tx.transactionId,
        recordId: input.idempotency.recordId,
        fingerprint: input.idempotency.fingerprint,
      });
      transactions.set(k(apt, tx.transactionId), tx);
      entries.push(...toLedgerEntries(tx));
      for (const l of tx.lines) {
        const acc = accounts.get(k(apt, l.accountId)) as Account;
        accounts.set(k(apt, l.accountId), {
          ...acc,
          balance: toKurus(acc.balance + (l.side === 'debit' ? l.amount : -l.amount)),
        });
      }
      if (input.counter) counters.set(k(apt, input.counter.name), input.counter.expected + 1);
      if (input.record?.entityType === 'PAYMENT') payments.set(k(apt, input.record.paymentId), input.record);
      outbox.push(...structuredClone(input.outbox ?? []));
    },
    postBatch: async () => {
      throw new Error('portal testlerinde kullanilmaz');
    },
    recordEvents: async (_apt, list) => {
      const fresh = list.filter((e) => !outbox.some((o) => o.eventId === e.eventId));
      outbox.push(...structuredClone(fresh));
      return fresh.length;
    },
  };

  const portalRepo: PortalRepository = {
    listMemberships: async (apt, userId) => memberships.filter((m) => m.apartmentId === apt && m.userId === userId),
    listLedgerEntries: async (apt, accountId) => entries.filter((e) => e.siteId === apt && e.accountId === accountId),
    getTransactions: async (apt, ids) => ids.map((id) => transactions.get(k(apt, id))).filter((t): t is Transaction => !!t),
    listUnitPayments: async (apt, unitId) => [...payments.values()].filter((p) => p.siteId === apt && p.unitId === unitId),
    listPublishedAnnouncements: async (apt) =>
      announcements.filter((a) => a.apartmentId === apt && a.status === 'published'),
  };

  const core: Pick<CoreRepository, 'getUnit' | 'listUnits' | 'getBlock' | 'getSite'> = {
    getUnit: async (apt, id) => units.find((u) => u.siteId === apt && u.unitId === id),
    listUnits: async (apt) => units.filter((u) => u.siteId === apt),
    getBlock: async (apt, id) => blocks.find((b) => b.siteId === apt && b.blockId === id),
    getSite: async (apt) => sites.find((s) => s.siteId === apt),
  };

  return {
    memberships, announcements, entries, accounts, payments, financeRepo, portalRepo, core, outbox,
    failNext: (e: Error) => void (failNextPost = e),
  };
}

function setup() {
  const world = createWorld();
  let n = 0;
  const financeService = createFinanceService({
    repository: world.financeRepo,
    core: world.core,
    now: () => NOW,
    newId: () => `id${String(++n).padStart(4, '0')}`,
  });
  const portalService = createPortalService({ repository: world.portalRepo, core: world.core, now: () => NOW });
  const app = createApp({
    version: 'test',
    authenticate: createMockAuthenticator(),
    financeService,
    portalService,
  });

  const token = (sub: string, role: Role | string, apartmentId: string | undefined = APT) =>
    `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;

  const get = (path: string, auth?: string) =>
    app.request(path, { headers: auth ? { authorization: auth } : {} });

  const manager = token('mgr-1', 'apartment_manager');
  const post = async (path: string, body: unknown) => {
    const res = await app.request(`/api/finance${path}`, {
      method: 'POST',
      headers: { authorization: manager, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };

  const charge = (unitId: string, liableParty: 'owner' | 'occupant', amount: number, key: string, over: object = {}) =>
    post('/dues', { idempotencyKey: key, unitId, liableParty, amount, date: '2026-11-01', dueDate: '2026-11-15', description: 'Kasim aidati', ...over });
  const pay = (unitId: string, liableParty: 'owner' | 'occupant', amount: number, key: string, over: object = {}) =>
    post('/payments', { idempotencyKey: key, unitId, liableParty, amount, method: 'cash', paidAt: '2026-11-05', payerName: 'Ayse Yilmaz', note: 'ic not', ...over });

  return { app, world, events: world.outbox, token, get, post, charge, pay };
}

// ---------------------------------------------------------------------------
// Rota korumalari ve tenant/daire izolasyonu
// ---------------------------------------------------------------------------

describe('portal - erisim kontrolu', () => {
  it('token yoksa 401', async () => {
    const { get } = setup();
    expect((await get('/api/portal/my-unit')).status).toBe(401);
  });

  it.each(['apartment_manager', 'observer', 'building_staff', 'management_company', 'platform_admin'] as const)(
    '%s rolu portala erisemez (403)',
    async (role) => {
      const { get, token } = setup();
      const res = await get('/api/portal/my-dues', token('tenant-1', role));
      expect(res.status).toBe(403);
    },
  );

  it('sistemde olmayan rol (unit_owner) kimlik dogrulamasindan gecemez (401)', async () => {
    const { get, token } = setup();
    expect((await get('/api/portal/my-dues', token('owner-1', 'unit_owner'))).status).toBe(401);
  });

  it('apartmentId claim yoksa 403', async () => {
    const { get, token } = setup();
    expect((await get('/api/portal/my-unit', token('tenant-1', 'resident', ''))).status).toBe(403);
  });

  it('sakin baska bir dairenin verisini isteyemez (403)', async () => {
    const { get, token, charge } = setup();
    await charge('u2', 'occupant', 150050, 'k-u2');
    for (const path of ['my-unit', 'my-dues', 'my-statement', 'my-receipts']) {
      const res = await get(`/api/portal/${path}?unitId=u2`, token('tenant-1', 'resident'));
      expect(res.status, path).toBe(403);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.error).toBe('forbidden');
      expect(JSON.stringify(body)).not.toContain('150050');
    }
  });

  it('var olmayan daire de ayni 403 yanitini alir (varlik sizdirilmaz)', async () => {
    const { get, token } = setup();
    const res = await get('/api/portal/my-dues?unitId=yok', token('tenant-1', 'resident'));
    expect(res.status).toBe(403);
  });

  it('gecersiz unitId bicimi 400', async () => {
    const { get, token } = setup();
    expect((await get('/api/portal/my-dues?unitId=a%23b', token('tenant-1', 'resident'))).status).toBe(400);
  });

  it('baska apartmanin claim i ile uyeligi olmayan kullanici 403 alir', async () => {
    const { get, token } = setup();
    // tenant-1 apt-2 baglaminda token alsa bile orada uyeligi yok.
    expect((await get('/api/portal/my-unit', token('tenant-1', 'resident', OTHER_APT))).status).toBe(403);
    // foreign kullanicisi apt-1 claim'i ile apt-1 dairelerine erisemez.
    expect((await get('/api/portal/my-unit?unitId=u1', token('foreign', 'resident', APT))).status).toBe(403);
  });

  it('uyeligi sona ermis (tasinmis) kiraci erisemez', async () => {
    const { get, token, world } = setup();
    world.memberships.push(member('old-tenant', 'u1', 'tenant', { startDate: '2025-01-01', endDate: '2026-06-30' }));
    expect((await get('/api/portal/my-unit', token('old-tenant', 'resident'))).status).toBe(403);
  });

  it('pasif uyelik erisim vermez', async () => {
    const { get, token, world } = setup();
    world.memberships.push(member('passive', 'u1', 'tenant', { status: 'inactive' }));
    expect((await get('/api/portal/my-unit', token('passive', 'resident'))).status).toBe(403);
  });

  it('birden fazla dairesi olan sakin unitId secmeden 400 alir, secince kendi dairesini gorur', async () => {
    const { get, token } = setup();
    const res = await get('/api/portal/my-unit', token('multi', 'resident'));
    expect(res.status).toBe(400);
    const sel = (await res.json()) as any;
    expect(sel).toMatchObject({ error: 'unit_selection_required', unitIds: ['u2', 'u3'] });
    // Secici etiketleri yalnizca kullanicinin kendi daireleri
    expect(sel.units.map((u: any) => u.unitId).sort()).toEqual(['u2', 'u3']);
    expect(sel.units[0].label).toMatch(/· U[23]$/);

    const ok = await get('/api/portal/my-unit?unitId=u3', token('multi', 'resident'));
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).unit.unitId).toBe('u3');
  });

  it('yanitlar onbelleklenmez', async () => {
    const { get, token } = setup();
    const res = await get('/api/portal/my-unit', token('tenant-1', 'resident'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

// ---------------------------------------------------------------------------
// Ekstre, acik aidatlar, makbuzlar
// ---------------------------------------------------------------------------

describe('portal - hesap ekstresi', () => {
  it('kiraci yalnizca kendi (occupant) carisini gorur; malik carisi, diger daireler ve kasa gorunmez', async () => {
    const { get, token, charge, pay } = setup();
    await charge('u1', 'occupant', 150050, 'k1');
    await charge('u1', 'owner', 500000, 'k2', { description: 'Mantolama' });
    await charge('u2', 'occupant', 150050, 'k3');
    await pay('u1', 'occupant', 100000, 'p1');

    const res = await get('/api/portal/my-statement', token('tenant-1', 'resident'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.accounts).toHaveLength(1);
    const acc = body.accounts[0];
    expect(acc.liableParty).toBe('occupant');
    expect(acc.entries.map((e: any) => [e.kind, e.debit, e.credit, e.balance])).toEqual([
      ['dues_charge', 150050, 0, 150050],
      ['payment', 0, 100000, 50050],
    ]);
    expect(acc).toMatchObject({ openingBalance: 0, totalDebit: 150050, totalCredit: 100000, closingBalance: 50050 });
    expect(body.closingBalance).toBe(50050);

    const text = JSON.stringify(body);
    for (const leaked of ['Mantolama', '500000', 'recv-u1-owner', 'recv-u2', 'income-dues', '"cash"', 'PK', 'ic not']) {
      expect(text, leaked).not.toContain(leaked);
    }
  });

  it('dairede oturmayan malik yalnizca owner carisini gorur', async () => {
    const { get, token, charge } = setup();
    await charge('u1', 'occupant', 150050, 'k1');
    await charge('u1', 'owner', 500000, 'k2', { description: 'Mantolama' });

    const body = (await (await get('/api/portal/my-statement', token('owner-1', 'resident'))).json()) as any;
    expect(body.accounts.map((a: any) => a.liableParty)).toEqual(['owner']);
    expect(body.closingBalance).toBe(500000);
  });

  it('dairede oturan malik hem owner hem occupant carisini gorur', async () => {
    const { get, token, charge } = setup();
    await charge('u2', 'occupant', 150050, 'k1');
    await charge('u2', 'owner', 200000, 'k2');

    const body = (await (await get('/api/portal/my-statement', token('owner-2', 'resident'))).json()) as any;
    expect(body.accounts.map((a: any) => a.liableParty)).toEqual(['owner', 'occupant']);
    expect(body.closingBalance).toBe(350050);
  });

  it('from/to filtresi acilis bakiyesini dogru tasir', async () => {
    const { get, token, charge, pay } = setup();
    await charge('u1', 'occupant', 100000, 'k-oct', { date: '2026-10-01', dueDate: '2026-10-15' });
    await charge('u1', 'occupant', 100000, 'k-nov', { date: '2026-11-01' });
    await pay('u1', 'occupant', 30000, 'p1', { paidAt: '2026-11-03' });

    const body = (await (
      await get('/api/portal/my-statement?from=2026-11-01&to=2026-11-30', token('tenant-1', 'resident'))
    ).json()) as any;
    const acc = body.accounts[0];
    expect(acc.openingBalance).toBe(100000);
    expect(acc.entries.map((e: any) => e.balance)).toEqual([200000, 170000]);
    expect(acc.closingBalance).toBe(170000);
  });

  it('gecersiz tarih araligi 400', async () => {
    const { get, token } = setup();
    const res = await get('/api/portal/my-statement?from=2026-12-01&to=2026-11-01', token('tenant-1', 'resident'));
    expect(res.status).toBe(400);
  });

  it('yeni kiraci, uyelik baslangicindan onceki (eski kiraciya ait) hareketleri goremez', async () => {
    const { get, token, charge, world } = setup();
    await charge('u3', 'occupant', 90000, 'eski', { date: '2026-09-01', dueDate: '2026-09-15' });
    await charge('u3', 'occupant', 120000, 'yeni', { date: '2026-11-01' });
    world.memberships.push(member('new-tenant', 'u3', 'tenant', { startDate: '2026-10-01' }));

    const body = (await (await get('/api/portal/my-statement', token('new-tenant', 'resident'))).json()) as any;
    expect(body.accounts[0].entries).toHaveLength(1);
    expect(body.closingBalance).toBe(120000);
    expect(JSON.stringify(body)).not.toContain('90000');
  });
});

describe('portal - acik aidatlar (my-dues)', () => {
  it('kismi odeme vade sirasina gore (FIFO) mahsup edilir; gecikme isaretlenir', async () => {
    const { get, token, charge, pay } = setup();
    await charge('u1', 'occupant', 100000, 'k-oct', { date: '2026-10-01', dueDate: '2026-10-15', description: 'Ekim aidati' });
    await charge('u1', 'occupant', 100000, 'k-nov', { description: 'Kasim aidati' });
    await pay('u1', 'occupant', 50000, 'p1');

    const body = (await (await get('/api/portal/my-dues', token('tenant-1', 'resident'))).json()) as any;
    expect(body.items.map((i: any) => [i.description, i.paid, i.remaining, i.overdue, i.daysOverdue])).toEqual([
      ['Ekim aidati', 50000, 50000, true, 22],
      ['Kasim aidati', 0, 100000, false, 0],
    ]);
    expect(body.summary).toEqual({ totalOpen: 150000, overdueAmount: 50000, advance: 0, openCount: 2 });
  });

  it('fazla odeme avans olarak gorunur, odenmis kalem listelenmez', async () => {
    const { get, token, charge, pay } = setup();
    await charge('u1', 'occupant', 100000, 'k1');
    await pay('u1', 'occupant', 120000, 'p1');

    const body = (await (await get('/api/portal/my-dues', token('tenant-1', 'resident'))).json()) as any;
    expect(body.items).toEqual([]);
    expect(body.summary.advance).toBe(20000);
  });

  it('ters kayitla iptal edilen tahakkuk acik borc olarak gorunmez', async () => {
    const { get, token, charge, post } = setup();
    const c1 = await charge('u1', 'occupant', 100000, 'k1');
    await charge('u1', 'occupant', 70000, 'k2', { description: 'Su' });
    const rev = await post(`/transactions/${c1.body.transaction.transactionId}/reversal`, { reason: 'Hatali tahakkuk' });
    expect(rev.status).toBe(201);

    const body = (await (await get('/api/portal/my-dues', token('tenant-1', 'resident'))).json()) as any;
    expect(body.items.map((i: any) => i.description)).toEqual(['Su']);
    expect(body.summary.totalOpen).toBe(70000);
  });

  it('allocateOpenDues: kalan borc toplami - avans = cari bakiye', () => {
    const tx = (id: string, kind: Transaction['kind'], dueDate?: string, reversalOf?: string) =>
      ({ transactionId: id, kind, date: '2026-10-01', dueDate, description: id, reversalOf }) as Transaction;
    const e = (id: string, side: 'debit' | 'credit', amount: number) =>
      ({ transactionId: id, side, amount, date: '2026-10-01' }) as LedgerEntry;
    const txs = new Map([
      ['a', tx('a', 'dues_charge', '2026-10-10')],
      ['b', tx('b', 'dues_charge', '2026-11-10')],
      ['p', tx('p', 'payment')],
    ]);
    const entries = [e('a', 'debit', 300), e('b', 'debit', 200), e('p', 'credit', 350)];
    const { open, advance } = allocateOpenDues('occupant', entries, txs, '2026-11-06');
    const balance = entries.reduce((s, x) => s + (x.side === 'debit' ? x.amount : -x.amount), 0);
    expect(open.reduce((s, o) => s + o.remaining, 0) - advance).toBe(balance);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ transactionId: 'b', paid: 50, remaining: 150 });
  });
});

describe('portal - makbuzlar ve daire ozeti', () => {
  it('yalnizca kendi dairesi + carisinin makbuzlari doner; ic alanlar gizlenir; ters kayitli makbuz isaretlenir', async () => {
    const { get, token, charge, pay, post } = setup();
    await charge('u1', 'occupant', 300000, 'k1');
    const p1 = await pay('u1', 'occupant', 100000, 'p1', { paidAt: '2026-11-02' });
    await pay('u1', 'occupant', 50000, 'p2', { paidAt: '2026-11-04' });
    await pay('u1', 'owner', 70000, 'p3');
    await pay('u2', 'occupant', 80000, 'p4');
    await post(`/transactions/${p1.body.transaction.transactionId}/reversal`, { reason: 'Karsiliksiz' });

    const body = (await (await get('/api/portal/my-receipts', token('tenant-1', 'resident'))).json()) as any;
    expect(body.items.map((r: any) => [r.receiptNumber, r.amount, r.status])).toEqual([
      ['MKB-000002', 50000, 'valid'],
      ['MKB-000001', 100000, 'reversed'],
    ]);
    for (const r of body.items) {
      expect(r).not.toHaveProperty('depositAccountId');
      expect(r).not.toHaveProperty('note');
      expect(r).not.toHaveProperty('transactionId');
    }
  });

  it('my-unit daire, blok, site ve bakiye ozetini dondurur', async () => {
    const { get, token, charge, pay } = setup();
    await charge('u1', 'occupant', 150050, 'k1');
    await pay('u1', 'occupant', 50, 'p1');

    const body = (await (await get('/api/portal/my-unit', token('tenant-1', 'resident'))).json()) as any;
    expect(body).toMatchObject({
      unit: { unitId: 'u1', number: 'U1', grossAreaM2: 100, block: { blockId: 'b1', name: 'A Blok' } },
      site: { siteId: APT, name: 'Lale Apartmani' },
      membership: { relation: 'tenant', visibleParties: ['occupant'] },
      balance: 150000,
      debt: 150000,
      advance: 0,
      myUnitIds: ['u1'],
    });
  });
});

describe('portal - duyurular', () => {
  const ann = (id: string, over: Partial<Announcement> = {}): Announcement => ({
    PK: `APT#${APT}`,
    SK: `ANN#${id}`,
    entityType: 'ANNOUNCEMENT',
    announcementId: id,
    apartmentId: APT,
    title: id,
    body: 'metin',
    status: 'published',
    publishAt: '2026-11-01T00:00:00.000Z',
    approvedBy: 'mgr-1',
    approvedAt: '2026-11-01T00:00:00.000Z',
    ...audit,
    ...over,
  });

  it('yalnizca onayli, yayinda, suresi dolmamis ve sakinin blogunu kapsayan duyurular gorunur', async () => {
    const { get, token, world } = setup();
    world.announcements.push(
      ann('genel'),
      ann('a-blok', { blockIds: ['b1'], publishAt: '2026-11-02T00:00:00.000Z' }),
      ann('b-blok', { blockIds: ['b2'] }),
      ann('taslak', { status: 'draft' }),
      ann('onaysiz', { approvedAt: undefined }),
      ann('ileri-tarihli', { publishAt: '2026-12-01T00:00:00.000Z' }),
      ann('suresi-dolmus', { expiresAt: '2026-11-05T00:00:00.000Z' }),
      ann('baska-apt', { apartmentId: OTHER_APT }),
    );

    const body = (await (await get('/api/portal/announcements', token('tenant-1', 'resident'))).json()) as any;
    expect(body.items.map((a: any) => a.announcementId)).toEqual(['a-blok', 'genel']);
  });
});

// ---------------------------------------------------------------------------
// Olay yayini (finans -> publisher)
// ---------------------------------------------------------------------------

describe('olaylar - finans islemlerinde outbox', () => {
  it('odeme alindiginda PAYMENT_RECEIVED tahsilatla ayni atomik yazimda outbox\'a girer', async () => {
    const { pay, charge, events } = setup();
    await charge('u1', 'occupant', 150050, 'k1');

    const res = await pay('u1', 'occupant', 100000, 'p1');
    expect(res.status).toBe(201);

    const paymentEvents = events.filter((e) => e.type === 'PAYMENT_RECEIVED');
    expect(paymentEvents).toHaveLength(1);
    expect(paymentEvents[0]).toMatchObject({
      eventId: `PAYMENT_RECEIVED:${res.body.payment.paymentId}`,
      type: 'PAYMENT_RECEIVED',
      version: 1,
      apartmentId: APT,
      actorId: 'mgr-1',
      groupKey: 'u1',
      occurredAt: NOW.toISOString(),
      payload: {
        paymentId: res.body.payment.paymentId,
        transactionId: res.body.transaction.transactionId,
        receiptNumber: 'MKB-000001',
        unitId: 'u1',
        liableParty: 'occupant',
        amount: 100000,
        method: 'cash',
        paidAt: '2026-11-05',
      },
    });
    // Kisisel veri tasinmaz.
    expect(JSON.stringify(paymentEvents[0])).not.toContain('Ayse');
  });

  it('ayni idempotencyKey ile tekrar gelen odeme yeni olay uretmez', async () => {
    const { pay, events } = setup();
    expect((await pay('u1', 'occupant', 1000, 'p1')).status).toBe(201);
    expect((await pay('u1', 'occupant', 1000, 'p1')).status).toBe(200);
    expect(events.filter((e) => e.type === 'PAYMENT_RECEIVED')).toHaveLength(1);
  });

  it('tekil aidat tahakkukunda DUE_GENERATED outbox\'a yazilir', async () => {
    const { charge, events } = setup();
    const res = await charge('u1', 'occupant', 150050, 'k1');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'DUE_GENERATED',
      eventId: `DUE_GENERATED:${res.body.transaction.transactionId}`,
      groupKey: 'u1',
      payload: { mode: 'single', totalAmount: 150050, items: [{ unitId: 'u1', amount: 150050 }] },
    });
  });

  it('toplu tahakkukta kalem basina DUE_GENERATED (ayni batchId); tekrar isteginde yeni olay yok', async () => {
    const { post, events } = setup();
    const body = {
      idempotencyKey: 'bulk-nov',
      liableParty: 'occupant',
      totalAmount: 300001,
      distributionKey: 'equal',
      date: '2026-11-01',
      dueDate: '2026-11-15',
      description: 'Kasim aidati',
    };
    const first = await post('/dues', body);
    expect(first.status).toBe(201);
    const due = events.filter((e): e is DomainEvent<'DUE_GENERATED'> => e.type === 'DUE_GENERATED');
    expect(due).toHaveLength(3);
    for (const [i, e] of due.entries()) {
      const item = first.body.items[i];
      expect(e).toMatchObject({
        eventId: `DUE_GENERATED:${item.transactionId}`,
        groupKey: item.unitId,
        payload: {
          mode: 'bulk',
          batchId: first.body.batchId,
          totalAmount: item.amount,
          items: [{ unitId: item.unitId, amount: item.amount, transactionId: item.transactionId }],
        },
      });
    }
    expect(due.reduce((sum, e) => sum + e.payload.totalAmount, 0)).toBe(300001);

    // Bildirim icin TEK ozet olay: tum kalemler, ayni batchId.
    const summary = events.filter((e): e is DomainEvent<'DUES_BATCH_SUMMARY'> => e.type === 'DUES_BATCH_SUMMARY');
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({
      eventId: `DUES_BATCH_SUMMARY:${first.body.batchId}`,
      payload: { batchId: first.body.batchId, part: 1, parts: 1, totalAmount: 300001, dueDate: '2026-11-15', description: 'Kasim aidati' },
    });
    expect(summary[0]!.payload.items.map((i) => i.transactionId)).toEqual(first.body.items.map((i: { transactionId: string }) => i.transactionId));

    // Tekrar istegi: yeni kalem olayi da, ikinci ozet de yok.
    expect((await post('/dues', body)).status).toBe(200);
    expect(events).toHaveLength(4);
  });

  it('toplu tahakkuk yarida kesilirse yazilan kalemlerin olayi kaybolmaz; tamamlama yalnizca kalanlari ekler', async () => {
    const { post, events, world } = setup();
    const body = {
      idempotencyKey: 'bulk-cut',
      liableParty: 'occupant',
      totalAmount: 300000,
      distributionKey: 'equal',
      date: '2026-11-01',
      dueDate: '2026-11-15',
      description: 'Kasim aidati',
    };
    // Ilk kalem yazildiktan sonra ikinci kalemde altyapi hatasi (Lambda/istek kesintisi benzeri).
    const real = world.financeRepo.postTransaction;
    let calls = 0;
    world.financeRepo.postTransaction = async (input) => {
      if (++calls === 2) throw new Error('baglanti koptu');
      return real(input);
    };
    expect((await post('/dues', body)).status).toBe(500);
    expect(events.filter((e) => e.type === 'DUE_GENERATED')).toHaveLength(1);
    // Yarim kalan toplu islemin ozeti yok (sakine eksik ozet gitmez).
    expect(events.filter((e) => e.type === 'DUES_BATCH_SUMMARY')).toHaveLength(0);

    world.financeRepo.postTransaction = real;
    const done = await post('/dues', body);
    expect(done.status).toBe(201);
    const due = events.filter((e): e is DomainEvent<'DUE_GENERATED'> => e.type === 'DUE_GENERATED');
    // Her kalem icin TAM BIR olay: kesintiden once yazilan da dahil, tekrar yok.
    expect(due).toHaveLength(3);
    expect(new Set(due.map((e) => e.payload.items[0]!.transactionId))).toEqual(
      new Set(done.body.items.map((i: { transactionId: string }) => i.transactionId)),
    );
    // Tamamlamada ozet, kesintiden once yazilan kalem dahil TUM kalemleri tasir.
    const [summary] = events.filter((e): e is DomainEvent<'DUES_BATCH_SUMMARY'> => e.type === 'DUES_BATCH_SUMMARY');
    expect(summary!.payload.items).toHaveLength(3);
    expect(summary!.payload.totalAmount).toBe(300000);
  });

  it('defter yazimi basarisizsa ne odeme ne olay vardir (atomik)', async () => {
    const { pay, world, events } = setup();
    world.failNext(new Error('TransactWriteItems iptal'));
    const res = await pay('u1', 'occupant', 1000, 'p1');
    expect(res.status).toBe(500);
    expect(world.payments.size).toBe(0);
    expect(events).toHaveLength(0);
  });

  it('abone hatasi yayinciya sizmaz', async () => {
    const onHandlerError = vi.fn();
    const events = createInMemoryEventPublisher({ onHandlerError });
    events.subscribe('*', () => {
      throw new Error('tuketici coktu');
    });
    const event = buildEvent(
      { eventId: 'e1', type: 'PAYMENT_RECEIVED', apartmentId: APT, actorId: 'u', payload: {} as never },
      () => NOW,
    );
    await expect(events.publish(event)).resolves.toBeUndefined();
    expect(onHandlerError).toHaveBeenCalledOnce();
    expect(await publishSafely(events, event)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AWS yayincilari ve ortam secimi
// ---------------------------------------------------------------------------

const sampleEvent = () =>
  buildEvent(
    {
      eventId: 'PAYMENT_RECEIVED:p1',
      type: 'PAYMENT_RECEIVED',
      apartmentId: APT,
      actorId: 'mgr-1',
      groupKey: 'u1',
      payload: {
        paymentId: 'p1',
        transactionId: 't1',
        receiptNumber: 'MKB-000001',
        unitId: 'u1',
        liableParty: 'occupant',
        amount: toKurus(1000),
        method: 'cash',
        paidAt: '2026-11-05',
      },
    },
    () => NOW,
  );

describe('olaylar - SNS yayincisi', () => {
  const sns = mockClient(SNSClient);
  beforeEach(() => sns.reset());

  it('standart topic: mesaj + filtre oznitelikleri', async () => {
    sns.on(PublishCommand).resolves({ MessageId: 'm1' });
    const pub = createSnsEventPublisher({ topicArn: 'arn:aws:sns:eu-central-1:1:bm-events' }, new SNSClient({ region: 'eu-central-1' }));
    await pub.publish(sampleEvent());

    const input = sns.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.TopicArn).toBe('arn:aws:sns:eu-central-1:1:bm-events');
    expect(JSON.parse(input.Message!)).toMatchObject({ type: 'PAYMENT_RECEIVED', eventId: 'PAYMENT_RECEIVED:p1' });
    expect(input.MessageAttributes).toEqual({
      eventType: { DataType: 'String', StringValue: 'PAYMENT_RECEIVED' },
      apartmentId: { DataType: 'String', StringValue: APT },
    });
    expect(input.MessageGroupId).toBeUndefined();
  });

  it('FIFO topic: MessageGroupId ve MessageDeduplicationId', async () => {
    sns.on(PublishCommand).resolves({});
    const pub = createSnsEventPublisher({ topicArn: 'arn:aws:sns:eu-central-1:1:bm-events.fifo' }, new SNSClient({ region: 'eu-central-1' }));
    await pub.publish(sampleEvent());
    const input = sns.commandCalls(PublishCommand)[0]!.args[0].input;
    expect(input.MessageGroupId).toBe('u1');
    expect(input.MessageDeduplicationId).toBe('PAYMENT_RECEIVED:p1');
  });

  it('SDK hatasi EventPublishError olarak sarmalanir', async () => {
    sns.on(PublishCommand).rejects(new Error('network'));
    const pub = createSnsEventPublisher({ topicArn: 'arn:x' }, new SNSClient({ region: 'eu-central-1' }));
    await expect(pub.publish(sampleEvent())).rejects.toBeInstanceOf(EventPublishError);
  });
});

describe('olaylar - EventBridge yayincisi', () => {
  const eb = mockClient(EventBridgeClient);
  beforeEach(() => eb.reset());

  it('detail-type = olay turu, detail = olay', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0, Entries: [{ EventId: 'x' }] });
    const pub = createEventBridgePublisher({ eventBusName: 'bm-bus' }, new EventBridgeClient({ region: 'eu-central-1' }));
    await pub.publish(sampleEvent());
    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry).toMatchObject({ EventBusName: 'bm-bus', Source: 'building-management.api', DetailType: 'PAYMENT_RECEIVED' });
    expect(JSON.parse(entry.Detail!).payload.amount).toBe(1000);
  });

  it('kismi basarisizlik (FailedEntryCount) hata olarak firlatilir', async () => {
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'InternalFailure' }] });
    const pub = createEventBridgePublisher({ eventBusName: 'bm-bus' }, new EventBridgeClient({ region: 'eu-central-1' }));
    await expect(pub.publish(sampleEvent())).rejects.toThrow(/InternalFailure/);
  });
});

describe('olaylar - createEventPublisherFromEnv', () => {
  const quiet = { warn: () => {}, info: () => {} };

  it('gelistirmede varsayilan bellek ici yayinci', () => {
    const pub = createEventPublisherFromEnv({ NODE_ENV: 'development' }, quiet);
    expect(pub).toHaveProperty('published');
  });

  it('production ortaminda EVENTS_MODE zorunlu; local yasak', () => {
    expect(() => createEventPublisherFromEnv({ NODE_ENV: 'production' }, quiet)).toThrow(/zorunlu/);
    expect(() => createEventPublisherFromEnv({ AWS_LAMBDA_FUNCTION_NAME: 'api', EVENTS_MODE: 'local' }, quiet)).toThrow();
  });

  it('eksik yapilandirma baslangicta hata verir', () => {
    expect(() => createEventPublisherFromEnv({ EVENTS_MODE: 'sns' }, quiet)).toThrow(/EVENTS_SNS_TOPIC_ARN/);
    expect(() => createEventPublisherFromEnv({ EVENTS_MODE: 'eventbridge' }, quiet)).toThrow(/EVENTS_BUS_NAME/);
    expect(() => createEventPublisherFromEnv({ EVENTS_MODE: 'kafka' }, quiet)).toThrow(/Gecersiz/);
  });

  it('sns / eventbridge / none secilebilir', () => {
    expect(createEventPublisherFromEnv({ EVENTS_MODE: 'sns', EVENTS_SNS_TOPIC_ARN: 'arn:x', AWS_REGION: 'eu-central-1' }, quiet)).toBeDefined();
    expect(createEventPublisherFromEnv({ EVENTS_MODE: 'eventbridge', EVENTS_BUS_NAME: 'b', AWS_REGION: 'eu-central-1' }, quiet)).toBeDefined();
    expect(createEventPublisherFromEnv({ EVENTS_MODE: 'none', NODE_ENV: 'production' }, quiet)).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Sakin ozeti (my-summary) ve ekstre zenginlestirme
// ---------------------------------------------------------------------------

describe('portal - sakin ozeti (my-summary)', () => {
  const summary = async (t: ReturnType<typeof setup>) =>
    (await (await t.get('/api/portal/my-summary', t.token('tenant-1', 'resident'))).json()) as any;

  it('hic tahakkuk yoksa "no_debt"', async () => {
    const t = setup();
    expect(await summary(t)).toMatchObject({ status: 'no_debt', debt: 0, totalCharged: 0, totalPaid: 0, unitLabel: 'A Blok · U1', relationLabel: 'Kiracı' });
  });

  it('vadesi gecmemis borc "pending"; siradaki vade ve tutar doner', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1');
    await t.pay('u1', 'occupant', 30000, 'p1');
    expect(await summary(t)).toMatchObject({
      status: 'pending',
      debt: 70000,
      totalCharged: 100000,
      totalPaid: 30000,
      overdueAmount: 0,
      nextDue: { dueDate: '2026-11-15', amount: 70000 },
      lastPayment: { paidAt: '2026-11-05', amount: 30000, receiptNumber: 'MKB-000001' },
    });
  });

  it('vadesi gecmis borc "overdue" ve gun sayisi', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1', { date: '2026-10-01', dueDate: '2026-10-15' });
    expect(await summary(t)).toMatchObject({ status: 'overdue', overdueAmount: 100000, daysOverdue: 22, oldestOverdueDueDate: '2026-10-15' });
  });

  it('islemis kistelyevm gecikme tazminati (aylik %5, gunluk) ozet icinde doner', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1', { date: '2026-10-01', dueDate: '2026-10-15' });
    // 1.000 TL x 22 gun x %5/30 = 36,666.. TL -> 3667 kurus
    expect(await summary(t)).toMatchObject({ accruedLateFee: 3667, lateFeeMonthlyBasisPoints: 500 });
    // 1 Kasim'da 600 TL odeme: 400 TL anapara 6 Kasim'a kadar acik kalir.
    await t.pay('u1', 'occupant', 60000, 'p1', { paidAt: '2026-11-01' });
    // 600 TL x 17 gun + 400 TL x 22 gun -> 1.900.000 kurus-gun x 500 / 300.000 = 3166,67
    expect(await summary(t)).toMatchObject({ accruedLateFee: 3167 });
  });

  it('tamami odenmis "paid"; fazla odeme avans', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1');
    await t.pay('u1', 'occupant', 120000, 'p1');
    expect(await summary(t)).toMatchObject({ status: 'paid', debt: 0, advance: 20000, totalPaid: 120000 });
  });

  it('iptal edilen odeme toplam odenene ve son odemeye katilmaz', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1');
    const p = await t.pay('u1', 'occupant', 100000, 'p1');
    await t.post(`/transactions/${p.body.transaction.transactionId}/reversal`, { reason: 'Karsiliksiz cek' });
    const body = await summary(t);
    expect(body).toMatchObject({ status: 'pending', debt: 100000, totalPaid: 0 });
    expect(body.lastPayment).toBeUndefined();
  });

  it('sakin rolu disinda erisilemez; baska dairenin ozeti istenemez', async () => {
    const t = setup();
    expect((await t.get('/api/portal/my-summary', t.token('mgr-1', 'apartment_manager'))).status).toBe(403);
    expect((await t.get('/api/portal/my-summary?unitId=u2', t.token('tenant-1', 'resident'))).status).toBe(403);
  });
});

describe('portal - ekstre: hareket turu ve makbuz no', () => {
  it('tahakkuk ACCRUAL, tahsilat COLLECTION + makbuz no, ters kayit REVERSAL ve iptal isareti', async () => {
    const t = setup();
    await t.charge('u1', 'occupant', 100000, 'k1');
    const p = await t.pay('u1', 'occupant', 40000, 'p1');
    await t.pay('u1', 'occupant', 10000, 'p2', { method: 'bank_transfer' });
    await t.post(`/transactions/${p.body.transaction.transactionId}/reversal`, { reason: 'Hatali' });

    const body = (await (await t.get('/api/portal/my-statement', t.token('tenant-1', 'resident'))).json()) as any;
    const rows = body.accounts[0].entries;
    expect(rows.map((r: any) => [r.entryType, r.receiptNumber ?? null, r.debit, r.credit, r.reversed ?? false])).toEqual([
      ['ACCRUAL', null, 100000, 0, false],
      ['COLLECTION', 'MKB-000001', 0, 40000, true],
      ['COLLECTION', 'MKB-000002', 0, 10000, false],
      ['REVERSAL', null, 40000, 0, false],
    ]);
    expect(body.closingBalance).toBe(90000);
  });
});

describe('portal - mock kimlik cozumlemesi', () => {
  it('mock token (sub = mock-<eposta>) davetle olusan uyelik uzerinden daireyi cozer', async () => {
    const t = setup();
    // Mock davet dizini bu kimligi uretir: mockUserId('ayse@site.com') === 'mock-ayse'
    t.world.memberships.push({ ...t.world.memberships[0], userId: 'mock-ayse', unitId: 'u2' } as any);
    await t.charge('u2', 'occupant', 50000, 'k-u2');
    const res = await t.get('/api/portal/my-summary', t.token('mock-ayse', 'resident'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ unitId: 'u2', debt: 50000 });
    // Uyeligi olmayan mock kullanici (ornek: resident@dev.local) acik bir 403 alir
    const none = await t.get('/api/portal/my-summary', t.token('mock-resident', 'resident'));
    expect(none.status).toBe(403);
  });
});
