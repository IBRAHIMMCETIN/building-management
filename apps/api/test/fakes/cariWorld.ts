/**
 * Cari devri testleri icin ortak dunya: sahte defter (uyelikler ve kapama kayitlari belge
 * deposunda, atomik yazimla ayni yer), finans + kapama + portal servisleri, HTTP uygulamasi.
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
import type { PortalRepository } from '../../src/modules/portal/repository.js';
import { type PortalServiceDeps, createPortalService } from '../../src/modules/portal/service.js';
import type { UnitMembership } from '../../src/modules/portal/types.js';
import { createFakeFinanceRepo } from './financeRepo.js';

export const APT = 'apt-1';
export const TL = (n: number) => toKurus(Math.round(n * 100));
export const RATE = 500;
export const MAIN = 'recv-u1-occupant';
export const OWNER = 'recv-u1-owner';
export const manager: AuthClaims = { userId: 'mgr-1', role: 'apartment_manager', apartmentId: APT };
export const observer: AuthClaims = { userId: 'obs-1', role: 'observer', apartmentId: APT };
export const resident: AuthClaims = { userId: 'tenant-a', role: 'resident', apartmentId: APT };

export function unit(id: string): Unit {
  const ts = '2026-01-01T00:00:00.000Z';
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId: 'b1',
    number: '5',
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    createdAt: ts,
    createdBy: 'seed',
    updatedAt: ts,
    updatedBy: 'seed',
    version: 1,
  };
}

/** vacancyRule: finans servisine uyelikler verilir (bos daire kurali acik). */
export function cariWorld(start = '2026-09-01', opts: { vacancyRule?: boolean } = {}) {
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
  // Uyelikler ve kapama kayitlari sahte defterin belge deposunda (atomik yazimla ayni yer).
  const docsOf = <T>(type: string) => [...fake.docs.values()].filter((d) => d.entityType === type) as unknown as T[];
  const memberships: Pick<MembershipRepository, 'list'> = {
    list: async (apt, f = {}) => docsOf<UnitMembership>('UNIT_MEMBERSHIP').filter((m) => m.apartmentId === apt && (!f.unitId || m.unitId === f.unitId)),
  };
  const finance = createFinanceService({
    repository: fake.repo,
    core,
    now: () => now,
    newId,
    ...(opts.vacancyRule ? { memberships } : {}),
  });
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
  });
  const app = createApp({
    version: 'test',
    financeService: finance,
    closureService: closures,
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
  const member = (userId: string, over: Partial<UnitMembership>) => {
    const ts = '2026-01-01T00:00:00.000Z';
    const m: UnitMembership = {
      ...membershipKeys.membership(APT, userId, over.unitId ?? 'u1'),
      entityType: 'UNIT_MEMBERSHIP',
      userId,
      apartmentId: APT,
      unitId: 'u1',
      relation: 'tenant',
      residesInUnit: true,
      status: 'active',
      startDate: '2026-01-01',
      createdAt: ts,
      createdBy: 'seed',
      updatedAt: ts,
      updatedBy: 'seed',
      version: 1,
      ...over,
    };
    fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Record<string, unknown> & { PK: string; SK: string; version: number });
    return m;
  };
  const memberOf = (userId: string) => fake.docs.get(`APT#${APT}|MEMBER#${userId}#u1`) as unknown as UnitMembership;
  const ctx = { apartmentId: APT, userId: 'mgr-1' };
  const charge = (key: string, amount: number, date: string, dueDate: string, party: 'occupant' | 'owner' = 'occupant') =>
    finance.chargeUnit(ctx, { idempotencyKey: key, unitId: 'u1', liableParty: party, amount: TL(amount), date, dueDate, description: `Aidat ${date.slice(0, 7)}` });
  const pay = (key: string, amount: number, paidAt: string, party: 'occupant' | 'owner' = 'occupant') =>
    finance.recordPayment(ctx, { idempotencyKey: key, unitId: 'u1', liableParty: party, amount: TL(amount), method: 'cash', paidAt });
  const txs = async () => (await fake.repo.listTransactions(APT)).items;
  const acc = (id: string) => fake.repo.getAccount(APT, id);
  const setNow = (d: string) => {
    now = new Date(`${d}T09:00:00.000Z`);
  };
  const addUnit = (id: string, number: string) => units.push({ ...unit(id), number });
  return { fake, finance, closures, portal, call, member, memberOf, charge, pay, txs, acc, setNow, ctx, addUnit };
}

