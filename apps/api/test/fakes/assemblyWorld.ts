/**
 * Genel kurul testleri icin bellek ici dunya: depo (toplanti, katilim, degismez karar ve cagri
 * kayitlari, outbox), oy listesi deposu, belge deposu, saat ve HTTP cagrisi. Depo DynamoDB'deki
 * kosullari taklit eder: surum kosullu toplanti yazimi, `attribute_not_exists` ekler, katilimda
 * toplantinin `planned` olmasi.
 */
import { createApp } from '../../src/app.js';
import { createMockAuthenticator, encodeMockToken } from '../../src/auth/authenticators.js';
import { DataAccessError } from '../../src/config/dynamodb.js';
import type { DomainEvent } from '../../src/events/publisher.js';
import { type AssemblyRepository, assertExtrasBelong } from '../../src/modules/assemblies/repository.js';
import { createAssemblyService } from '../../src/modules/assemblies/service.js';
import type { Assembly, AssemblyAttendance, AssemblyCall, AssemblyDecision } from '../../src/modules/assemblies/types.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import type { Block, LandShare, Unit } from '../../src/modules/core/types.js';
import { createMemoryDocumentStore } from '../../src/modules/documents/store.js';
import { createMemoryRollStore } from '../../src/modules/polls/rollSnapshot.js';
import type { UnitMembership } from '../../src/modules/portal/types.js';
import type { Person } from '../../src/modules/residents/repository.js';

export const APT = 'apt-1';
export const T0 = '2026-11-27T09:00:00.000Z';
/** Toplanti (15.12.2026 19:00 Istanbul) basladiktan sonra. */
export const DURING = '2026-12-15T16:30:00.000Z';
const seed = { createdAt: T0, createdBy: 'seed', updatedAt: T0, updatedBy: 'seed', version: 1 };

export const unit = (id: string, number: string, landShare?: LandShare, blockId = 'b1'): Unit => ({
  PK: `APT#${APT}`,
  SK: `UNIT#${id}`,
  entityType: 'UNIT',
  status: 'active',
  ...seed,
  unitId: id,
  siteId: APT,
  blockId,
  number,
  type: 'flat',
  grossAreaTenthsM2: 1000,
  ...(landShare ? { landShare } : {}),
  exemptions: [],
});

export const owner = (userId: string, unitId: string, extra: Partial<UnitMembership> = {}): UnitMembership => ({
  PK: `APT#${APT}`,
  SK: `MEMBER#${userId}#${unitId}`,
  entityType: 'UNIT_MEMBERSHIP',
  ...seed,
  userId,
  apartmentId: APT,
  unitId,
  relation: 'owner',
  residesInUnit: true,
  status: 'active',
  startDate: '2026-01-01',
  ...extra,
});

/** u1-u3 %10'ar, u4 %70 arsa payi: sayica cogunluk ile arsa payi cogunlugu ayrisir. */
export const ls = (n: number): LandShare => ({ numerator: n, denominator: 1000 });
export const defaultUnits = () => [unit('u1', '1', ls(100)), unit('u2', '2', ls(100)), unit('u3', '3', ls(100)), unit('u4', '4', ls(700), 'b2')];
export const defaultMembers = () => [
  owner('own-1', 'u1'),
  owner('own-2a', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
  owner('own-2b', 'u2', { ownershipShare: { numerator: 1, denominator: 2 } }),
  owner('own-3', 'u3'),
  owner('own-4', 'u4'),
];

export function setup(opts: { store?: boolean; units?: Unit[]; members?: UnitMembership[]; now?: string } = {}) {
  let now = new Date(opts.now ?? DURING);
  const clock = { set: (iso: string) => void (now = new Date(iso)) };
  const docs = new Map<string, Assembly>();
  const atts = new Map<string, AssemblyAttendance>();
  const extra = new Map<string, AssemblyDecision | AssemblyCall>();
  const outbox: DomainEvent[] = [];
  const audits: AuditDraft[] = [];
  const rolls = createMemoryRollStore();
  const clone = <T>(x: T): T => structuredClone(x);
  const repo: AssemblyRepository = {
    get: async (apt, id) => clone(docs.get(`${apt}|${id}`)),
    list: async (apt) => [...docs.values()].filter((a) => a.apartmentId === apt).map(clone),
    create: async (a, audit) => {
      docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a));
      audits.push(clone(audit));
    },
    update: async (a, expected, audit, extras = {}) => {
      assertExtrasBelong(a, extras);
      if (docs.get(`${a.apartmentId}|${a.assemblyId}`)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      const news = [extras.decision, extras.call].filter((x): x is AssemblyDecision | AssemblyCall => Boolean(x));
      if (news.some((x) => extra.has(`${x.PK}|${x.SK}`))) throw new DataAccessError('conflict', 'kayit var');
      if (extras.outbox?.some((e) => outbox.some((o) => o.eventId === e.eventId))) throw new DataAccessError('conflict', 'olay var');
      if (extras.roll?.length) rolls.put(extras.roll);
      for (const x of news) extra.set(`${x.PK}|${x.SK}`, clone(x));
      outbox.push(...(extras.outbox ?? []).map(clone));
      docs.set(`${a.apartmentId}|${a.assemblyId}`, clone(a));
      if (audit) audits.push(clone(audit));
    },
    listAttendance: async (apt, id) => [...atts.values()].filter((x) => x.apartmentId === apt && x.assemblyId === id).map(clone),
    getAttendance: async (apt, id, unitId) => clone(atts.get(`${apt}|${id}|${unitId}`)),
    putAttendance: async (att, expected, audit) => {
      if (docs.get(`${att.apartmentId}|${att.assemblyId}`)?.status !== 'planned') throw new DataAccessError('conflict', 'iptal');
      const k = `${att.apartmentId}|${att.assemblyId}|${att.unitId}`;
      if (expected === 0 ? atts.has(k) : atts.get(k)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      atts.set(k, clone(att));
      audits.push(clone(audit));
    },
    listDecisions: async (apt, id) =>
      [...extra.values()].filter((x): x is AssemblyDecision => x.entityType === 'ASSEMBLY_DECISION' && x.apartmentId === apt && (!id || x.assemblyId === id)).map(clone),
    getCall: async (apt, id, seq) => clone([...extra.values()].find((x): x is AssemblyCall => x.entityType === 'ASSEMBLY_CALL' && x.apartmentId === apt && x.assemblyId === id && x.seq === seq)),
  };
  const units = opts.units ?? defaultUnits();
  const members = opts.members ?? defaultMembers();
  const people = [...new Set([...members.map((m) => m.userId), 'prx-1', 'prx-2'])].map((userId) => ({ apartmentId: APT, userId, fullName: `Kişi ${userId}` }) as Person);
  const blocks = [
    { blockId: 'b1', name: 'A Blok', siteId: APT },
    { blockId: 'b2', name: 'B Blok', siteId: APT },
  ] as Block[];
  const { store } = createMemoryDocumentStore();
  let n = 0;
  const service = createAssemblyService({
    repository: repo,
    core: { listUnits: async () => units, listBlocks: async () => blocks, getSite: async () => ({ name: 'Lale Apartmanı' }) as never },
    ownership: { listHeads: async () => [], listRecords: async () => [] },
    memberships: { list: async (apt) => members.filter((m) => m.apartmentId === apt) },
    people: { list: async () => people },
    rolls,
    store: opts.store === false ? undefined : store,
    now: () => now,
    newId: () => `asm${++n}`,
  });
  const app = createApp({ version: 'test', authenticate: createMockAuthenticator(), assemblyService: service });
  const token = (sub: string, role: string, apartmentId = APT) => `Bearer ${encodeMockToken({ sub, role, ...(apartmentId ? { apartmentId } : {}) })}`;
  const manager = token('mgr-1', 'apartment_manager');
  const request = async (base: string, method: string, path: string, body?: unknown, auth = manager) => {
    const res = await app.request(`${base}${path}`, {
      method,
      headers: { authorization: auth, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const call = (method: string, path: string, body?: unknown, auth = manager) => request('/api/assemblies', method, path, body, auth);
  const portal = (path: string, auth: string) => request('/api/portal/assemblies', 'GET', path, undefined, auth);
  const attend = (unitId: string, mode: string, extraBody: Record<string, unknown> = {}, id = 'asm1') => call('PUT', `/${id}/attendance/${unitId}`, { mode, ...extraBody });
  const version = (id = 'asm1') => docs.get(`${APT}|${id}`)!.version;
  return { call, portal, token, attend, audits, store, docs, units, members, version, clock, rolls, outbox, extra, repo, service };
}

export const meeting = {
  kind: 'ordinary',
  scheduledAt: '2026-12-15T19:00:00+03:00',
  location: 'Site toplantı salonu',
  agenda: ['Yönetim kurulu seçimi', { title: 'İşletme projesi', description: '2027 bütçesi' }],
};
