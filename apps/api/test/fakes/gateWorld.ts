import { createApp } from '../../src/app.js';
import type { AuthClaims } from '../../src/auth/claims.js';
import type { ApartmentRole } from '../../src/modules/apartment-roles/types.js';
import type { Block, Unit } from '../../src/modules/core/types.js';
import { type GateContext, createGateService } from '../../src/modules/gate/service.js';
import type { UnitMembership } from '../../src/modules/portal/types.js';
import type { Person } from '../../src/modules/residents/repository.js';
import { createFakeGateRepo } from './gateRepo.js';

export const APT = 'apt-1';
export const APT2 = 'apt-2';
/** 27.11.2026 12:00 Istanbul. */
export const T0 = '2026-11-27T09:00:00.000Z';
export const DAY = '2026-11-27';

const unit = (apt: string, id: string, blockId: string, number: string) => ({ unitId: id, apartmentId: apt, blockId, status: 'active', number }) as unknown as Unit;
const member = (apt: string, userId: string, unitId: string, relation: 'owner' | 'tenant', residesInUnit = true) =>
  ({ userId, unitId, apartmentId: apt, relation, residesInUnit, status: 'active', startDate: '2026-01-01' }) as unknown as UnitMembership;
const role = (apt: string, userId: string, r: string, displayName: string) => ({ userId, apartmentId: apt, role: r, status: 'active', startDate: '2026-01-01', displayName }) as unknown as ApartmentRole;

export const ctxs = {
  mgr: { apartmentId: APT, userId: 'mgr', role: 'apartment_manager' },
  firm: { apartmentId: APT, userId: 'firm', role: 'management_company' },
  guard: { apartmentId: APT, userId: 'guard-1', role: 'security_guard' },
  guard2: { apartmentId: APT, userId: 'guard-2', role: 'security_guard' },
  staff: { apartmentId: APT, userId: 'staff-1', role: 'building_staff' },
  observer: { apartmentId: APT, userId: 'obs', role: 'observer' },
  /** u1 kiracisi (oturur). */
  tenant: { apartmentId: APT, userId: 'tenant-u1', role: 'resident' },
  /** u1 malik, dairede oturmuyor: ziyaretci kayitlarini gormez. */
  owner: { apartmentId: APT, userId: 'owner-u1', role: 'resident' },
  /** u2'de oturan malik. */
  other: { apartmentId: APT, userId: 'owner-u2', role: 'resident' },
  /** Baska apartmanin gorevlisi ve sakini. */
  guardApt2: { apartmentId: APT2, userId: 'guard-x', role: 'security_guard' },
  residentApt2: { apartmentId: APT2, userId: 'res-x', role: 'resident' },
} satisfies Record<string, GateContext>;

/** `codes`: sirayla donecek kisa kodlar (cakisma testi); bitince sayacli kod. */
export function gateWorld(opts: { codes?: string[] } = {}) {
  let now = new Date(T0);
  const fake = createFakeGateRepo();
  const units = [unit(APT, 'u1', 'b1', '5'), unit(APT, 'u2', 'b2', '12'), unit(APT, 'u3', 'b1', '7'), unit(APT2, 'x1', 'bx', '1')];
  const blocks = [
    { blockId: 'b1', apartmentId: APT, name: 'A Blok', status: 'active' },
    { blockId: 'b2', apartmentId: APT, name: 'B Blok', status: 'active' },
    { blockId: 'bx', apartmentId: APT2, name: 'Tek Blok', status: 'active' },
  ] as unknown as Block[];
  const memberships = [
    member(APT, 'tenant-u1', 'u1', 'tenant'),
    member(APT, 'owner-u1', 'u1', 'owner', false),
    member(APT, 'owner-u2', 'u2', 'owner'),
    member(APT2, 'res-x', 'x1', 'tenant'),
  ];
  const roles = [role(APT, 'guard-1', 'security_guard', 'Ali Güvenlik'), role(APT, 'mgr', 'apartment_manager', 'Ayşe Yönetici')];
  const people: Record<string, string> = { 'tenant-u1': 'Ayşe Kiracı', 'owner-u1': 'Mehmet Malik', 'owner-u2': 'Zeynep Malik' };
  let n = 0;
  let codes = 0;
  const service = createGateService({
    repo: fake.repo,
    core: {
      getUnit: async (apt, id) => units.find((u) => (u as unknown as { apartmentId: string }).apartmentId === apt && u.unitId === id),
      getBlock: async (apt, id) => blocks.find((b) => (b as unknown as { apartmentId: string }).apartmentId === apt && b.blockId === id),
      listUnits: async (apt) => units.filter((u) => (u as unknown as { apartmentId: string }).apartmentId === apt),
      listBlocks: async (apt) => blocks.filter((b) => (b as unknown as { apartmentId: string }).apartmentId === apt),
    },
    memberships: { listMemberships: async (apt, userId) => memberships.filter((m) => m.apartmentId === apt && m.userId === userId) },
    unitMembers: { list: async (apt, f = {}) => memberships.filter((m) => m.apartmentId === apt && (!f.unitId || m.unitId === f.unitId)) },
    people: { get: async (apt, userId) => (people[userId] ? ({ apartmentId: apt, userId, fullName: people[userId] } as unknown as Person) : undefined) },
    roles: { list: async (apt) => roles.filter((r) => r.apartmentId === apt) },
    now: () => now,
    newId: () => `${String(++n).padStart(8, '0')}abcdefgh`,
    newToken: () => `tok${String(++n).padStart(21, '0')}`,
    newCode: () => opts.codes?.shift() ?? `K7M2PQ${'23456789ABCDEFGH'[codes++ % 16]}X`,
  });
  const at = (iso: string) => {
    now = new Date(iso);
  };
  const app = createApp({
    version: 'test',
    gateService: service,
    authenticate: (c) => {
      const raw = c.req.header('x-test-claims');
      return raw ? (JSON.parse(raw) as AuthClaims) : null;
    },
  });
  const call = async (method: string, path: string, ctx: GateContext, body?: unknown) => {
    const res = await app.request(path, {
      method,
      headers: { 'x-test-claims': JSON.stringify({ userId: ctx.userId, role: ctx.role, apartmentId: ctx.apartmentId }), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };
  let k = 0;
  const key = () => `key-${++k}`;
  const pass = async (ctx: GateContext = ctxs.tenant, extra: Record<string, unknown> = {}) =>
    (await service.createPass(ctx, { idempotencyKey: key(), unitId: 'u1', guestName: 'Mehmet Misafir', validFrom: DAY, entryMode: 'single', ...extra })).pass;
  /** Tasinma: uyelik `endDate` ile biter (dun), durum pasif. */
  const moveOut = (userId: string, unitId: string, endDate: string) => {
    for (const m of memberships) if (m.userId === userId && m.unitId === unitId) Object.assign(m, { status: 'inactive', endDate });
  };
  /** Devir gunu: uyelik bugun bitiyor ama henuz kapanmadi (hala oturuyor). */
  const endsOn = (userId: string, unitId: string, endDate: string) => {
    for (const m of memberships) if (m.userId === userId && m.unitId === unitId) Object.assign(m, { endDate });
  };
  /** Yeni sakin (kiraci) `startDate`'ten itibaren; `createdAt`: uyelik kaydinin yazildigi an (devir gunu). */
  const moveIn = (userId: string, unitId: string, startDate: string, createdAt?: string) => {
    memberships.push({ ...member(APT, userId, unitId, 'tenant'), startDate, ...(createdAt ? { createdAt } : {}) } as UnitMembership);
  };
  return { fake, service, at, call, key, pass, moveOut, moveIn, endsOn };
}
