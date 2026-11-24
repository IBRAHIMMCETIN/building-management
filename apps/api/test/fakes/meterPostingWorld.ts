/**
 * Finans 2.3-3 testleri: finans tarafi `ownershipWorld` (sahte defter, uyelikler, cari kapama,
 * hisseli mulkiyet okuyucusu) + bellek ici sayac deposu + sayac servisleri + HTTP uygulamasi.
 */
import { createApp } from '../../src/app.js';
import type { AuthClaims } from '../../src/auth/claims.js';
import type { Block, Site } from '../../src/modules/core/types.js';
import { createMemoryDocumentStore } from '../../src/modules/documents/store.js';
import type { CariClosure } from '../../src/modules/finance/closures.js';
import { createMeterPortalService } from '../../src/modules/meters/portalView.js';
import { createMeterPostingService } from '../../src/modules/meters/posting.js';
import { createMeterReadingService } from '../../src/modules/meters/readings.js';
import { createMeterReversalService } from '../../src/modules/meters/reversal.js';
import { createMeterService } from '../../src/modules/meters/service.js';
import type { Meter, MeterLine } from '../../src/modules/meters/types.js';
import { createFakeMeterRepo } from './meterWorld.js';
import { APT, manager, ownershipWorld } from './ownershipWorld.js';

export { APT, manager };
export const staff: AuthClaims = { userId: 'staff-1', role: 'building_staff', apartmentId: APT };

export function meterPostingWorld(start = '2026-12-05') {
  const ow = ownershipWorld(start);
  ow.addUnit('u2', '2');
  ow.addUnit('u3', '3');
  const meterRepo = createFakeMeterRepo();
  const blocks = [{ blockId: 'b1', name: 'A Blok' }] as Block[];
  const site = { name: 'Lale Apartmanı', settings: { landShareEnabled: true } } as Site;
  const core = {
    getUnit: async (_a: string, id: string) => ow.units.find((u) => u.unitId === id),
    listUnits: async () => ow.units,
    getSite: async () => site,
    listBlocks: async () => blocks,
  };
  const { store, objects } = createMemoryDocumentStore();
  let n = 0;
  const newId = () => `m${String(++n).padStart(4, '0')}`;
  const now = () => ow.now();

  const closuresRepo = {
    list: async (apt: string) => ow.closureDocs().filter((c: CariClosure) => c.apartmentId === apt),
  };
  const service = createMeterService({ repository: meterRepo.repository, core, store, expenses: ow.fake.repo, now, newId });
  const readings = createMeterReadingService({ repository: meterRepo.repository, core, store, now, newId });
  const posting = createMeterPostingService({
    repository: meterRepo.repository,
    core,
    memberships: ow.memberships,
    closures: closuresRepo,
    financeRepo: ow.fake.repo,
    ownership: ow.reader,
    finance: ow.finance,
    now,
  });
  const reversal = createMeterReversalService({
    repository: meterRepo.repository,
    finance: ow.finance,
    financeRepo: ow.fake.repo,
    now,
    newId,
  });
  const portal = createMeterPortalService({ repository: meterRepo.repository, memberships: ow.memberships, core, store, now });
  const app = createApp({
    version: 'test',
    financeService: ow.finance,
    meterService: service,
    meterReadingService: readings,
    meterPostingService: posting,
    meterReversalService: reversal,
    meterPortalService: portal,
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

  const meter = (meterId: string) => meterRepo.docs.get(`APT#${APT}|METER#${meterId}`) as unknown as Meter;
  const lines = (periodId: string) =>
    [...meterRepo.docs.values()].filter((d) => d.SK.startsWith(`MDLINE#${periodId}#`)) as unknown as MeterLine[];
  const meterCharges = (periodId: string) =>
    [...ow.fake.transactions.values()].filter((t) => t.kind === 'dues_charge' && t.reference === `METER_PERIOD:${periodId}`);

  const reversals = (periodId: string) => {
    const ids = new Set(meterCharges(periodId).map((t) => t.transactionId));
    return [...ow.fake.transactions.values()].filter((t) => t.kind === 'reversal' && !!t.reversalOf && ids.has(t.reversalOf));
  };

  /** Sahte gider (tedarikci faturasi) kaydi. */
  const addExpense = (expenseId: string, amount: number) => {
    ow.fake.expenses.set(`${APT}|${expenseId}`, {
      PK: `APT#${APT}`,
      SK: `EXP#${expenseId}`,
      entityType: 'EXPENSE',
      expenseId,
      siteId: APT,
      expenseAccountId: 'exp-heating',
      creditAccountId: 'payable',
      amount,
      date: '2026-11-30',
      description: `Doğalgaz faturası ${expenseId}`,
      transactionId: `tx-${expenseId}`,
      createdAt: '2026-11-30T09:00:00.000Z',
      createdBy: 'mgr-1',
    } as never);
  };

  return { ow, meterRepo, service, readings, posting, reversal, portal, objects, call, meter, lines, meterCharges, reversals, addExpense };
}
