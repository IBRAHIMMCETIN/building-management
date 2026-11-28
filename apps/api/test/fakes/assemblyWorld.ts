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
import { type AssemblyRepository, assertExtrasBelong, resolveCall } from '../../src/modules/assemblies/repository.js';
import { type AssemblyDocuments, createAssemblyService } from '../../src/modules/assemblies/service.js';
import type {
  Assembly,
  AssemblyAttendance,
  AssemblyCall,
  AssemblyCallRecipients,
  AssemblyDecision,
  AssemblyServiceRecord,
  ConsentEntry,
  ConsentRequest,
} from '../../src/modules/assemblies/types.js';
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
  const extra = new Map<string, AssemblyDecision | AssemblyCall | AssemblyCallRecipients>();
  const services = new Map<string, AssemblyServiceRecord>();
  const consents = new Map<string, ConsentRequest>();
  const consentEntries = new Map<string, ConsentEntry>();
  const outbox: DomainEvent[] = [];
  const audits: AuditDraft[] = [];
  const hooks: { afterListConsentEntries?: () => Promise<void> } = {};
  const rolls = createMemoryRollStore();
  const clone = <T>(x: T): T => structuredClone(x);
  const buckets = () => [...extra.values()].filter((x): x is AssemblyCallRecipients => x.entityType === 'ASSEMBLY_CALL_RECIPIENTS');
  const calls = (apt: string, id: string) =>
    [...extra.values()]
      .filter((x): x is AssemblyCall => x.entityType === 'ASSEMBLY_CALL' && x.apartmentId === apt && x.assemblyId === id)
      .sort((x, y) => x.seq - y.seq)
      .map((c) => resolveCall(clone(c), buckets()));
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
      const news = [extras.decision, extras.call, ...(extras.callRecipients ?? [])].filter((x): x is AssemblyDecision | AssemblyCall | AssemblyCallRecipients => Boolean(x));
      // DynamoDB ogesi 400 KB'yi asamaz (JSON boyutu yaklasik olcu).
      if (news.some((x) => JSON.stringify(x).length > 400_000)) throw new Error('Oge 400 KB sinirini asti');
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
      const host = docs.get(`${att.apartmentId}|${att.assemblyId}`);
      if (host?.status !== 'planned' || host.attendanceLockedAt) throw new DataAccessError('conflict', 'iptal veya karar sonrasi');
      const k = `${att.apartmentId}|${att.assemblyId}|${att.unitId}`;
      if (expected === 0 ? atts.has(k) : atts.get(k)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      atts.set(k, clone(att));
      audits.push(clone(audit));
    },
    listDecisions: async (apt, id) =>
      [...extra.values()].filter((x): x is AssemblyDecision => x.entityType === 'ASSEMBLY_DECISION' && x.apartmentId === apt && (!id || x.assemblyId === id)).map(clone),
    getCall: async (apt, id, seq) => calls(apt, id).find((c) => c.seq === seq),
    listCalls: async (apt, id) => calls(apt, id),
    listServiceRecords: async (apt, id) => [...services.values()].filter((x) => x.apartmentId === apt && x.assemblyId === id).map(clone),
    getServiceRecord: async (apt, id, ownerId) => clone(services.get(`${apt}|${id}|${ownerId}`)),
    putServiceRecord: async (rec, expected, audit) => {
      const host = docs.get(`${rec.apartmentId}|${rec.assemblyId}`);
      if (!host || host.status === 'cancelled') throw new DataAccessError('conflict', 'iptal');
      const k = `${rec.apartmentId}|${rec.assemblyId}|${rec.ownerId}`;
      if ((services.get(k)?.version ?? 0) !== expected) throw new DataAccessError('conflict', 'surum');
      services.set(k, clone(rec));
      audits.push(clone(audit));
    },
    getConsent: async (apt, cid) => clone(consents.get(`${apt}|${cid}`)),
    listConsents: async (apt) => [...consents.values()].filter((c) => c.apartmentId === apt).map(clone),
    createConsent: async (req, roll, audit) => {
      if (consents.has(`${req.apartmentId}|${req.consentId}`)) throw new DataAccessError('conflict', 'var');
      rolls.put(roll);
      consents.set(`${req.apartmentId}|${req.consentId}`, clone(req));
      audits.push(clone(audit));
    },
    updateConsent: async (req, expected, audit) => {
      if (consents.get(`${req.apartmentId}|${req.consentId}`)?.version !== expected) throw new DataAccessError('conflict', 'surum');
      consents.set(`${req.apartmentId}|${req.consentId}`, clone(req));
      audits.push(clone(audit));
    },
    listConsentEntries: async (apt, cid) => {
      const out = [...consentEntries.values()].filter((e) => e.apartmentId === apt && e.consentId === cid).map(clone);
      // Okumadan hemen sonra calisir (araya giren es zamanli kayit benzetimi).
      const hook = hooks.afterListConsentEntries;
      hooks.afterListConsentEntries = undefined;
      if (hook) await hook();
      return out;
    },
    putConsentEntry: async (entry, audit) => {
      const req = consents.get(`${entry.apartmentId}|${entry.consentId}`);
      if (req?.status !== 'open') throw new DataAccessError('conflict', 'kapali');
      const k = `${entry.PK}|${entry.SK}`;
      if (consentEntries.has(k)) throw new DataAccessError('conflict', 'var');
      consentEntries.set(k, clone(entry));
      // Gercek depo gibi: talebin surumu ve sayaci ayni islemde artar.
      consents.set(`${entry.apartmentId}|${entry.consentId}`, { ...req, version: req.version + 1, entryCount: (req.entryCount ?? 0) + 1, updatedAt: entry.recordedAt, updatedBy: entry.recordedBy });
      audits.push(clone(audit));
    },
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
  // Riza belgesi: gecici yukleme kimligi `up-*` ise kalici anahtara "tasinir"; imzali link anahtari doner.
  const committed: string[] = [];
  const documents: AssemblyDocuments = {
    prepare: async (apt, upload, target) => {
      if (!upload.uploadId.startsWith('up-')) throw new Error('yukleme yok');
      return { key: `apartments/${apt}/assemblies/consents/${target.consentId}/${target.unitId}/${upload.uploadId}.pdf`, fileName: upload.fileName, contentType: 'application/pdf', size: 1234, uploadId: upload.uploadId };
    },
    commit: async (_apt, doc) => void committed.push(doc.key),
    sign: async (_apt, doc) => ({ url: `https://signed.example/${doc.key}`, fileName: doc.fileName, contentType: doc.contentType, expiresAt: new Date(now.getTime() + 300_000).toISOString() }),
  };
  const service = createAssemblyService({
    repository: repo,
    core: { listUnits: async () => units, listBlocks: async () => blocks, getSite: async () => ({ name: 'Lale Apartmanı' }) as never },
    ownership: { listHeads: async () => [], listRecords: async () => [] },
    memberships: { list: async (apt) => members.filter((m) => m.apartmentId === apt) },
    people: { list: async () => people },
    rolls,
    store: opts.store === false ? undefined : store,
    documents,
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
  return { call, portal, token, attend, audits, store, docs, units, members, version, clock, rolls, outbox, extra, services, consents, consentEntries, committed, hooks, repo, service };
}

export const meeting = {
  kind: 'ordinary',
  scheduledAt: '2026-12-15T19:00:00+03:00',
  location: 'Site toplantı salonu',
  agenda: ['Yönetim kurulu seçimi', { title: 'İşletme projesi', description: '2027 bütçesi' }],
};
