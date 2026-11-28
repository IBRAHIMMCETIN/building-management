import { type PortalPeriod, portalPeriodSchema } from '@bm/shared/api/meters';

/** Sakin tuketim donemi (API `GET /api/portal/meters/consumption` ogesi); sema ile dogrulanir. */
export const period = (over: Partial<PortalPeriod> = {}): PortalPeriod =>
  portalPeriodSchema.parse({
    periodId: 'mp-11',
    name: 'Kasım 2026',
    meterKind: 'heat_allocator',
    category: 'heating',
    startDate: '2026-11-01',
    endDate: '2026-11-30',
    dueDate: '2026-12-10',
    hasMeter: true,
    estimated: false,
    consumption: 120,
    consumptionText: '120.5',
    commonAmount: 30_000,
    consumptionAmount: 70_000,
    amount: 100_000,
    meters: [
      { meterId: 'm1', label: 'Salon', delta: '80.5' },
      { meterId: 'm2', label: 'Yatak odası', delta: '40' },
    ],
    buildingAverage: 100,
    blockAverage: 150,
    meteredUnits: 22,
    previous: { periodId: 'mp-10', consumption: 100, diff: 20, percent: 20 },
    ...over,
  });

export const history = (periods: PortalPeriod[], unitId = 'u-3') => ({ unitId, unitNumber: '3', periods });
