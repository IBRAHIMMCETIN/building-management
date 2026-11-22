/**
 * Finans 2.1 testleri icin ortak dunya: sahte defter (uyelikler, sicil, devir ve kapama kayitlari
 * belge deposunda, atomik yazimla ayni yer), finans + kapama + mulkiyet + portal + uyelik
 * servisleri ve HTTP uygulamasi.
 */
import { createApp } from '../../src/app.js';
import type { AuthClaims } from '../../src/auth/claims.js';
import type { CoreRepository } from '../../src/modules/core/repository.js';
import { type Unit, toKurus } from '../../src/modules/core/types.js';
import { type CariClosure, type ClosureRepository, createClosureService } from '../../src/modules/finance/closures.js';
import { toLedgerEntries } from '../../src/modules/finance/repository.js';
import { createFinanceService } from '../../src/modules/finance/service.js';
import type { Transaction } from '../../src/modules/finance/types.js';
import { type MembershipRepository, membershipKeys } from '../../src/modules/memberships/repository.js';
import { createMembershipService } from '../../src/modules/memberships/service.js';
import { createOwnershipReader } from '../../src/modules/ownership/reader.js';
import type { OwnershipRepository } from '../../src/modules/ownership/repository.js';
import { createOwnershipService } from '../../src/modules/ownership/service.js';
import type { OwnershipHead, OwnershipRecord, OwnershipTransfer } from '../../src/modules/ownership/types.js';
import type { PortalRepository } from '../../src/modules/portal/repository.js';
import { type PortalServiceDeps, createPortalService } from '../../src/modules/portal/service.js';
import type { UnitMembership } from '../../src/modules/portal/types.js';
import { createFakeFinanceRepo } from './financeRepo.js';

export const APT = 'apt-1';
export const TL = (n: number) => toKurus(Math.round(n * 100));
export const RATE = 500;
export const manager: AuthClaims = { userId: 'mgr-1', role: 'apartment_manager', apartmentId: APT };
export const observer: AuthClaims = { userId: 'obs-1', role: 'observer', apartmentId: APT };

type Doc = Record<string, unknown> & { PK: string; SK: string; version: number };

export function unit(id: string, number = '5'): Unit {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number,
    type: 'flat',
    grossAreaTenthsM2: 1000,
    landShare: { numerator: 1, denominator: 10 },
    exemptions: [],
    status: 'active',
    createdAt: ts,
    createdBy: 'seed',
    updatedAt: ts,
    updatedBy: 'seed',
    version: 1,
  };
}

export function ownershipWorld(start = '2026-09-01') {
  const fake = createFakeFinanceRepo();
  let n = 0;
  let now = new Date(`${start}T09:00:00.000Z`);
  const units = [unit('u1')];
  const core = {
    getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id),
    listUnits: async () => units,
    getSite: async () => ({ settings: { lateFeeMonthlyBasisPoints: RATE } }),
  } as unknown as Pick<CoreRepository, 'getUnit' | 'listUnits'>;
  const newId = () => `id${String(++n).padStart(4, '0')}`;
  const docsOf = <T>(type: string) => [...fake.docs.values()].filter((d) => d.entityType === type) as unknown as T[];

  const memberships: Pick<MembershipRepository, 'list'> = {
    list: async (apt, f = {}) => docsOf<UnitMembership>('UNIT_MEMBERSHIP').filter((m) => m.apartmentId === apt && (!f.unitId || m.unitId === f.unitId)),
  };
  const ownershipRepo: OwnershipRepository = {
    getHead: async (apt, unitId) => docsOf<OwnershipHead>('OWNERSHIP_HEAD').find((h) => h.apartmentId === apt && h.unitId === unitId),
    listHeads: async (apt) => docsOf<OwnershipHead>('OWNERSHIP_HEAD').filter((h) => h.apartmentId === apt),
    listRecords: async (apt, unitId) =>
      docsOf<OwnershipRecord>('OWNERSHIP_RECORD').filter((r) => r.apartmentId === apt && (!unitId || r.unitId === unitId)),
    getTransfer: async (apt, id) => docsOf<OwnershipTransfer>('OWNERSHIP_TRANSFER').find((t) => t.apartmentId === apt && t.transferId === id),
    listTransfers: async (apt) => docsOf<OwnershipTransfer>('OWNERSHIP_TRANSFER').filter((t) => t.apartmentId === apt),
  };
  const reader = createOwnershipReader(ownershipRepo);

  const finance = createFinanceService({ repository: fake.repo, core, now: () => now, newId, memberships, ownership: reader });
  const closuresRepo: ClosureRepository = {
    get: async (apt, id) => docsOf<CariClosure>('CARI_CLOSURE').find((c) => c.apartmentId === apt && c.closureId === id),
    list: async (apt) => docsOf<CariClosure>('CARI_CLOSURE').filter((c) => c.apartmentId === apt),
  };
  const closures = createClosureService({
    finance,
    financeRepo: fake.repo,
    closures: closuresRepo,
    memberships,
    core: core as Pick<CoreRepository, 'getUnit'>,
    now: () => now,
    newId,
  });
  const ownership = createOwnershipService({
    finance,
    financeRepo: fake.repo,
    repository: ownershipRepo,
    memberships,
    closures: closuresRepo,
    core,
    now: () => now,
    newId,
  });
  const portalRepo: PortalRepository = {
    listMemberships: async (apt, userId) => docsOf<UnitMembership>('UNIT_MEMBERSHIP').filter((m) => m.apartmentId === apt && m.userId === userId),
    listLedgerEntries: async (apt, accountId) =>
      [...fake.transactions.values()].filter((t) => t.siteId === apt).flatMap((t) => toLedgerEntries(t)).filter((e) => e.accountId === accountId),
    getTransactions: async (apt, ids) => ids.map((id) => fake.transactions.get(`${apt}|${id}`)).filter((t): t is Transaction => !!t),
    listUnitPayments: async (apt, unitId) => [...fake.payments.values()].filter((p) => p.siteId === apt && p.unitId === unitId),
    listPublishedAnnouncements: async () => [],
  };
  const portal = createPortalService({
    repository: portalRepo,
    core: { ...core, getBlock: async () => undefined } as unknown as PortalServiceDeps['core'],
    now: () => now,
    ownership: reader,
  });
  const membershipRepo: MembershipRepository = {
    get: async (apt, userId, unitId) => fake.docs.get(`APT#${apt}|MEMBER#${userId}#${unitId}`) as unknown as UnitMembership | undefined,
    list: async (apt, f) => memberships.list(apt, f),
    create: async (m) => {
      fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Doc);
    },
    update: async (m) => {
      fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Doc);
    },
  };
  const membershipService = createMembershipService({
    repository: membershipRepo,
    core: core as Pick<CoreRepository, 'getUnit'>,
    now: () => now,
    ownership: reader,
  });
  const app = createApp({
    version: 'test',
    financeService: finance,
    closureService: closures,
    ownershipService: ownership,
    membershipService,
    portalService: portal,
    authenticate: (c) => {
      const raw = c.req.header('x-test-claims');
      return raw ? (JSON.parse(raw) as AuthClaims) : null;
    },
  });
  const call = async (method: string, path: string, who: AuthClaims | null = manager, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { ...(who ? { 'x-test-claims': JSON.stringify(who) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  const member = (userId: string, over: Partial<UnitMembership> = {}) => {
    const ts = '2026-01-01T00:00:00.000Z';
    const m: UnitMembership = {
      ...membershipKeys.membership(APT, userId, over.unitId ?? 'u1'),
      entityType: 'UNIT_MEMBERSHIP',
      userId,
      apartmentId: APT,
      unitId: 'u1',
      relation: 'owner',
      residesInUnit: false,
      status: 'active',
      startDate: '2026-01-01',
      createdAt: ts,
      createdBy: 'seed',
      updatedAt: ts,
      updatedBy: 'seed',
      version: 1,
      ...over,
    };
    fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Doc);
    return m;
  };
  const memberOf = (userId: string, unitId = 'u1') => fake.docs.get(`APT#${APT}|MEMBER#${userId}#${unitId}`) as unknown as UnitMembership;
  const ctx = { apartmentId: APT, userId: 'mgr-1' };
  const charge = (key: string, amount: number, date: string, dueDate: string, party: 'occupant' | 'owner' = 'owner') =>
    finance.chargeUnit(ctx, { idempotencyKey: key, unitId: 'u1', liableParty: party, amount: TL(amount), date, dueDate, description: `Gider ${date.slice(0, 7)}` });
  const acc = (id: string) => fake.repo.getAccount(APT, id);
  const setNow = (d: string) => {
    now = new Date(`${d}T09:00:00.000Z`);
  };
  const head = (unitId = 'u1') => docsOf<OwnershipHead>('OWNERSHIP_HEAD').find((h) => h.unitId === unitId);
  const records = (unitId = 'u1') => docsOf<OwnershipRecord>('OWNERSHIP_RECORD').filter((r) => r.unitId === unitId).sort((a, b) => a.seq - b.seq);
  const closureDocs = () => docsOf<CariClosure>('CARI_CLOSURE');
  const addUnit = (id: string, number: string) => units.push(unit(id, number));
  return {
    fake,
    finance,
    closures,
    ownership,
    portal,
    membershipService,
    ownershipRepo,
    reader,
    portalRepo,
    memberships,
    units,
    now: () => now,
    call,
    member,
    memberOf,
    charge,
    acc,
    setNow,
    ctx,
    head,
    records,
    closureDocs,
    addUnit,
  };
}
