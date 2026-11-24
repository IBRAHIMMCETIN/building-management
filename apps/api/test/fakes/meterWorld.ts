/**
 * Finans 2.3-2 testleri icin ortak dunya: bellek ici sayac deposu (kosullu yazim + hep-ya-hic,
 * DynamoDB `TransactWriteItems` davranisi), sahte cekirdek (daire/blok/site), bellek ici belge
 * deposu ve HTTP uygulamasi.
 */
import { createApp } from '../../src/app.js';
import type { AuthClaims } from '../../src/auth/claims.js';
import type { AuditDraft } from '../../src/modules/audit/log.js';
import type { Block, Site, Unit } from '../../src/modules/core/types.js';
import { createMemoryDocumentStore } from '../../src/modules/documents/store.js';
import { MeterError } from '../../src/modules/meters/errors.js';
import { createMeterReadingService } from '../../src/modules/meters/readings.js';
import { CONFLICT_MESSAGE, type MeterDoc, type MeterRepository } from '../../src/modules/meters/repository.js';
import { createMeterService } from '../../src/modules/meters/service.js';
import type { Meter } from '../../src/modules/meters/types.js';

export const APT = 'apt-1';
export const manager: AuthClaims = { userId: 'mgr-1', role: 'apartment_manager', apartmentId: APT };
export const staff: AuthClaims = { userId: 'staff-1', role: 'building_staff', apartmentId: APT };
export const observer: AuthClaims = { userId: 'obs-1', role: 'observer', apartmentId: APT };
export const resident: AuthClaims = { userId: 'res-1', role: 'resident', apartmentId: APT };

const TS = '2026-01-01T00:00:00.000Z';
const audit = { createdAt: TS, createdBy: 'seed', updatedAt: TS, updatedBy: 'seed', version: 1 };

export function unit(id: string, number: string, blockId = 'b1', over: Partial<Unit> = {}): Unit {
  return {
    PK: `APT#${APT}`,
    SK: `UNIT#${id}`,
    entityType: 'UNIT',
    unitId: id,
    siteId: APT,
    blockId,
    number,
    type: 'flat',
    grossAreaTenthsM2: 1000,
    exemptions: [],
    status: 'active',
    ...audit,
    ...over,
  } as Unit;
}

/** Bellek ici sayac deposu: kosullu yazim + hep-ya-hic (DynamoDB TransactWriteItems davranisi). */
export function createFakeMeterRepo() {
  const docs = new Map<string, MeterDoc>();
  const audits: AuditDraft[] = [];
  const keyOf = (d: { PK: string; SK: string }) => `${d.PK}|${d.SK}`;
  const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v));

  const repository: MeterRepository = {
    get: async <T>(key: { PK: string; SK: string }) => clone(docs.get(keyOf(key))) as T | undefined,
    list: async <T>(apartmentId: string, prefix: string) =>
      [...docs.values()]
        .filter((d) => d.PK === `APT#${apartmentId}` && d.SK.startsWith(prefix))
        .sort((a, b) => a.SK.localeCompare(b.SK))
        .map((d) => clone(d)) as T[],
    async write(writes, drafts) {
      const seen = new Set<string>();
      for (const w of writes) {
        const k = keyOf(w.item);
        if (seen.has(k)) throw new Error(`Ayni islemde ayni kayit iki kez: ${k}`);
        seen.add(k);
        const cur = docs.get(k);
        if (w.op === 'create' && cur) throw new MeterError('conflict', CONFLICT_MESSAGE);
        if (w.op === 'replace' && (!cur || cur.version !== w.expectedVersion)) throw new MeterError('conflict', CONFLICT_MESSAGE);
        if (writes.length > 95) throw new Error('Atomik yazim siniri asildi');
      }
      for (const w of writes) docs.set(keyOf(w.item), clone(w.item));
      audits.push(...drafts);
    },
  };

  return { docs, audits, repository };
}

export function meterWorld(opts: { now?: string; landShareEnabled?: boolean; meterSplit?: Site['settings']['meterSplit'] } = {}) {
  const { docs, audits, repository } = createFakeMeterRepo();

  const units: Unit[] = [
    unit('u1', '1'),
    unit('u2', '2'),
    unit('u3', 'D1', 'b2', { type: 'shop', exemptions: [{ expenseCategory: 'heating', reason: 'Isıtma yok' }] }),
  ];
  const blocks = [
    { blockId: 'b1', name: 'A Blok' },
    { blockId: 'b2', name: 'Çarşı' },
  ] as Block[];
  const site = { settings: { landShareEnabled: opts.landShareEnabled ?? false, ...(opts.meterSplit ? { meterSplit: opts.meterSplit } : {}) } } as Site;
  const core = {
    getUnit: async (_a: string, id: string) => units.find((u) => u.unitId === id),
    listUnits: async () => units,
    getSite: async () => site,
    listBlocks: async () => blocks,
  };
  const { store, objects } = createMemoryDocumentStore();

  let n = 0;
  const newId = () => `id${String(++n).padStart(4, '0')}`;
  let now = new Date(opts.now ?? '2026-12-05T09:00:00.000Z');
  const clock = () => now;

  const service = createMeterService({ repository, core, store, now: clock, newId });
  const readings = createMeterReadingService({ repository, core, store, now: clock, newId });
  const app = createApp({
    version: 'test',
    meterService: service,
    meterReadingService: readings,
    authenticate: (c) => {
      const raw = c.req.header('x-test-claims');
      return raw ? (JSON.parse(raw) as AuthClaims) : null;
    },
  });

  // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
  const call = async (method: string, path: string, who: AuthClaims | null = manager, body?: unknown): Promise<{ status: number; json: Record<string, any> }> => {
    const res = await app.request(path, {
      method,
      headers: { ...(who ? { 'x-test-claims': JSON.stringify(who) } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    // biome-ignore lint/suspicious/noExplicitAny: test yanitlari serbest JSON
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  };

  const meterDoc = (meterId: string) => docs.get(`APT#${APT}|METER#${meterId}`) as unknown as Meter;
  /** Testte sayac kaydini dogrudan degistirir (2.3-3'te donem onayinin yazacagi alanlar icin). */
  const patchMeter = (meterId: string, patch: Partial<Meter>) => {
    const m = meterDoc(meterId);
    docs.set(`APT#${APT}|METER#${meterId}`, { ...m, ...patch } as unknown as MeterDoc);
  };

  const createMeter = async (body: Record<string, unknown>) => {
    const r = await call('POST', '/api/metering/meters', manager, { kind: 'heat_allocator', label: 'Salon', openingIndex: 100, installedAt: '2026-01-01', ...body });
    if (r.status !== 201) throw new Error(`Sayac olusturulamadi: ${JSON.stringify(r.json)}`);
    return r.json as Meter;
  };

  return {
    docs,
    audits,
    units,
    store,
    objects,
    call,
    meterDoc,
    patchMeter,
    createMeter,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}
