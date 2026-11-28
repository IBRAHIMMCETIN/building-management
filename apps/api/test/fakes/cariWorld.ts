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
import { type AccountOffset, type OffsetRepository, type OffsetRequest, createOffsetService } from '../../src/modules/finance/offsets.js';
import { type InstallmentPlan, type PlanRepository, createPlanService } from '../../src/modules/finance/plans.js';
import {
  type PlanRequest,
  type PlanRequestHead,
  type PlanRequestKey,
  type PlanRequestRepository,
  type PlanRequestSettingsDoc,
  createPlanRequestService,
} from '../../src/modules/finance/planRequests.js';
import {
  type SupplierAdvance,
  type SupplierAdvanceOffset,
  type SupplierAdvanceRepository,
  createSupplierAdvanceService,
} from '../../src/modules/finance/supplierAdvances.js';
import { createFinanceService } from '../../src/modules/finance/service.js';
import type { Transaction } from '../../src/modules/finance/types.js';
import { type MembershipRepository, membershipKeys } from '../../src/modules/memberships/repository.js';
import { createMembershipService } from '../../src/modules/memberships/service.js';
import type { PortalRepository } from '../../src/modules/portal/repository.js';
import { type PortalServiceDeps, createPortalService } from '../../src/modules/portal/service.js';
import type { UnitMembership } from '../../src/modules/portal/types.js';
import { createFakeFinanceRepo } from './financeRepo.js';
import type { SiteFeatureReader } from '../../src/modules/features/guard.js';

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
export function cariWorld(start = '2026-09-01', opts: { vacancyRule?: boolean; features?: SiteFeatureReader } = {}) {
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
    // Tedarikci ozeti (GET /payables) icin hesap satirlari sahte defterden.
    ledger: {
      listLedgerEntries: async (apt, accountId) =>
        [...fake.transactions.values()].filter((t) => t.siteId === apt).flatMap((t) => toLedgerEntries(t)).filter((e) => e.accountId === accountId),
      getTransactions: async (apt, ids) => ids.map((id) => fake.transactions.get(`${apt}|${id}`)).filter((t): t is Transaction => !!t),
    },
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
  // Finans 2.2: mahsup ve yapilandirma kayitlari da ayni belge deposunda (atomik yazim).
  const offsetsRepo: OffsetRepository = {
    get: async (apt, id) => docsOf<AccountOffset>('ACCOUNT_OFFSET').find((o) => o.apartmentId === apt && o.offsetId === id),
    list: async (apt) => docsOf<AccountOffset>('ACCOUNT_OFFSET').filter((o) => o.apartmentId === apt),
    getRequest: async (apt, id) => docsOf<OffsetRequest>('OFFSET_REQUEST').find((o) => o.apartmentId === apt && o.requestId === id),
    listRequests: async (apt) => docsOf<OffsetRequest>('OFFSET_REQUEST').filter((o) => o.apartmentId === apt),
  };
  const plansRepo: PlanRepository = {
    get: async (apt, id) => docsOf<InstallmentPlan>('INSTALLMENT_PLAN').find((p) => p.apartmentId === apt && p.planId === id),
    list: async (apt) => docsOf<InstallmentPlan>('INSTALLMENT_PLAN').filter((p) => p.apartmentId === apt),
  };
  const offsets = createOffsetService({ financeRepo: fake.repo, offsets: offsetsRepo, memberships, portal, now: () => now, newId });
  const plans = createPlanService({
    finance,
    financeRepo: fake.repo,
    plans: plansRepo,
    core: core as unknown as Pick<CoreRepository, 'getSite'>,
    portal,
    now: () => now,
    newId,
  });
  // Finans 2.2 sonrasi: yapilandirma talepleri ve tedarikci avanslari da ayni belge deposunda.
  const planRequestsRepo: PlanRequestRepository = {
    get: async (apt, id) => docsOf<PlanRequest>('PLAN_REQUEST').find((r) => r.apartmentId === apt && r.requestId === id),
    list: async (apt) => docsOf<PlanRequest>('PLAN_REQUEST').filter((r) => r.apartmentId === apt),
    getHead: async (apt, accountId) => docsOf<PlanRequestHead>('PLAN_REQUEST_HEAD').find((h) => h.apartmentId === apt && h.accountId === accountId),
    listHeads: async (apt) => docsOf<PlanRequestHead>('PLAN_REQUEST_HEAD').filter((h) => h.apartmentId === apt),
    getKey: async (apt, tag) => fake.docs.get(`APT#${apt}|PLANREQKEY#${tag}`) as unknown as PlanRequestKey | undefined,
    getSettings: async (apt) => docsOf<PlanRequestSettingsDoc>('PLAN_REQUEST_SETTINGS').find((s) => s.apartmentId === apt),
  };
  const planRequests = createPlanRequestService({
    plans,
    financeRepo: fake.repo,
    requests: planRequestsRepo,
    portal,
    core: core as unknown as Pick<CoreRepository, 'getSite'>,
    now: () => now,
    newId,
  });
  const advancesRepo: SupplierAdvanceRepository = {
    get: async (apt, id) => docsOf<SupplierAdvance>('SUPPLIER_ADVANCE').find((a) => a.apartmentId === apt && a.advanceId === id),
    list: async (apt) => docsOf<SupplierAdvance>('SUPPLIER_ADVANCE').filter((a) => a.apartmentId === apt),
    getOffset: async (apt, id) => docsOf<SupplierAdvanceOffset>('SUPPLIER_ADVANCE_OFFSET').find((o) => o.apartmentId === apt && o.offsetId === id),
    listOffsets: async (apt) => docsOf<SupplierAdvanceOffset>('SUPPLIER_ADVANCE_OFFSET').filter((o) => o.apartmentId === apt),
  };
  const supplierAdvances = createSupplierAdvanceService({ finance, financeRepo: fake.repo, advances: advancesRepo, now: () => now, newId });
  // Daireler ekraninin kaynagi (GET /api/memberships?current=true) ayni belge deposundan okur.
  const membershipRepo: MembershipRepository = {
    get: async (apt, userId, unitId) => fake.docs.get(`APT#${apt}|MEMBER#${userId}#${unitId}`) as unknown as UnitMembership | undefined,
    list: async (apt, f) => memberships.list(apt, f),
    create: async (m) => {
      fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Record<string, unknown> & { PK: string; SK: string; version: number });
    },
    update: async (m) => {
      fake.docs.set(`${m.PK}|${m.SK}`, m as unknown as Record<string, unknown> & { PK: string; SK: string; version: number });
    },
  };
  const app = createApp({
    version: 'test',
    financeService: finance,
    closureService: closures,
    offsetService: offsets,
    planService: plans,
    planRequestService: planRequests,
    supplierAdvanceService: supplierAdvances,
    ...(opts.features ? { siteFeatures: opts.features } : {}),
    portalService: portal,
    membershipService: createMembershipService({ repository: membershipRepo, core: core as Pick<CoreRepository, 'getUnit'>, now: () => now }),
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
  return { fake, finance, closures, offsets, plans, planRequests, supplierAdvances, portal, call, member, memberOf, charge, pay, txs, acc, setNow, ctx, addUnit };
}

