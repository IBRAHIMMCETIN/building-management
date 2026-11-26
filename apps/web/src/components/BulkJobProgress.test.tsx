// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BulkJob } from '@/lib/api/bulkJobs';
import { BulkJobProgress } from './BulkJobProgress';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/hooks/useBulkJob', () => ({
  useBulkJob: () => ({ data: undefined }),
  useRetryBulkJob: () => ({ isPending: false, isError: false, error: null, mutate: () => {} }),
}));

const job = (over: Partial<BulkJob>): BulkJob => ({
  jobId: 'j1',
  kind: 'meter_posting',
  status: 'completed',
  phase: 'finalize',
  total: 303,
  processed: 303,
  succeeded: 303,
  failed: 0,
  written: 303,
  percent: 100,
  failures: [],
  params: {},
  createdAt: '2026-11-26T07:00:00.000Z',
  updatedAt: '2026-11-26T07:05:00.000Z',
  ...over,
});

let root: ReturnType<typeof createRoot> | undefined;
afterEach(() => {
  act(() => root?.unmount());
  document.body.innerHTML = '';
});

function render(j: BulkJob): string {
  const el = document.createElement('div');
  document.body.appendChild(el);
  root = createRoot(el);
  act(() => root?.render(<BulkJobProgress job={j} />));
  return el.textContent ?? '';
}

describe('BulkJobProgress tamamlanma metni', () => {
  it('sayac geri alma: ters kayit sayisi (tahakkuk metni degil)', () => {
    const text = render(job({ kind: 'meter_reversal', result: { reversed: 303, written: 303, replayed: false } }));
    expect(text).toContain('303 ters kayıt işlendi.');
    expect(text).not.toContain('tahakkuk yazıldı');
  });

  it('sayac onayi: tahakkuk metni', () => {
    expect(render(job({ result: { posted: 303, written: 303, replayed: false } }))).toContain('303 bölüme tahakkuk yazıldı.');
  });

  it('daha once geri alinmis donem', () => {
    expect(render(job({ kind: 'meter_reversal', result: { reversed: 12, written: 0, replayed: true } }))).toContain('12 ters kayıt işlendi (dönem daha önce geri alınmıştı).');
  });
});
