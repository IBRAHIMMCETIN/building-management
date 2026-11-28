// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob } from '@/lib/api/bulkJobs';
import type { CalculateResult, MeterPeriod } from '@/lib/api/meters';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/api/client', () => ({ apiClient: {} }));

const PERIOD: MeterPeriod = {
  periodId: 'p1',
  name: 'Kasım 2026',
  templateId: 't1',
  template: { templateId: 't1', name: 'Merkezi ısıtma', category: 'heating', commonShareBps: 3000, commonKey: 'area', liableParty: 'occupant', legalProfile: 'central_heating' },
  meterKind: 'heat_allocator',
  startDate: '2026-11-01',
  endDate: '2026-11-30',
  dueDate: '2026-12-15',
  totalAmount: 100001,
  expenseIds: [],
  status: 'draft',
  version: 5,
};

const job = (over: Partial<BulkJob>): BulkJob => ({
  jobId: 'mc-p1-x',
  kind: 'meter_calculation',
  status: 'pending',
  total: 1250,
  processed: 0,
  succeeded: 0,
  failed: 0,
  written: 0,
  percent: 0,
  failures: [],
  params: {},
  createdAt: '2026-11-28T09:00:00.000Z',
  updatedAt: '2026-11-28T09:00:00.000Z',
  ...over,
});

const RESULT: CalculateResult = {
  ok: true,
  period: { ...PERIOD, status: 'calculated', version: 6 },
  calcHash: 'h1',
  description: 'Isınma — Kasım 2026',
  totals: { totalAmount: 100001, commonPool: 30000, consumptionPool: 70001, fallbackToCommon: false, totalConsumption: '1250', unitCount: 1250, chargeCount: 1250 },
  lines: [],
  warnings: [],
};

const calculate = vi.fn(async () => ({ mode: 'job' as const, created: true, job: job({}) }));
const loadResult = vi.fn(async () => RESULT);
/** BulkJobProgress yerine: `finish` cagrilinca is tamamlanmis gibi onSettled tetiklenir. */
let finish: (() => void) | undefined;

vi.mock('@/components/BulkJobProgress', () => ({
  BulkJobProgress: ({ job: j, onSettled }: { job: BulkJob; onSettled?: (j: BulkJob) => void }) => {
    finish = () => onSettled?.({ ...j, status: 'completed', percent: 100, result: { ok: true, unitCount: 1250, chargeCount: 1250 } });
    return <div data-testid="calc-progress">{`İş: ${j.kind}`}</div>;
  },
}));

vi.mock('@/hooks/useMeters', () => ({
  useMeterPermissions: () => ({ canManage: true, canRead: true, apartmentId: 'apt-1' }),
  useCalculatePeriod: () => ({ mutateAsync: calculate, isPending: false, isError: false, error: null }),
  useApprovePeriod: () => ({ mutateAsync: vi.fn(), reset: () => {}, isPending: false, isError: false, error: null }),
  usePeriodJob: () => useState<BulkJob | null>(null),
  useCalculationJob: () => useState<BulkJob | null>(null),
  useCalculationResult: () => ({ mutateAsync: loadResult, isPending: false, isError: false, error: null }),
  useRefreshAfterPosting: () => () => {},
}));

const { CalculationCard } = await import('./PeriodDetail');

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

describe('CalculationCard: buyuk donem onizlemesi arka plan isi', () => {
  it('202: ilerleme gosterilir; is bitince sonuc yuklenir ve cetvel gorunur', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    root = createRoot(el);
    act(() => root?.render(<CalculationCard period={PERIOD} unitLabel={(id) => id} />));
    const button = [...el.querySelectorAll('button')].find((b) => b.textContent?.includes('Hesapla')) as HTMLButtonElement;
    await act(async () => button.click());
    expect(calculate).toHaveBeenCalledWith('p1');
    expect(el.querySelector('[data-testid="calc-progress"]')?.textContent).toBe('İş: meter_calculation');
    expect(el.textContent).not.toContain('Toplam tüketim');

    await act(async () => finish?.());
    expect(loadResult).toHaveBeenCalledWith({ periodId: 'p1', jobId: 'mc-p1-x' });
    expect(el.querySelector('[data-testid="calc-progress"]')).toBeNull();
    expect(el.textContent).toContain('Toplam tüketim');
    expect(el.textContent).toContain('Onayla');
  });
});
