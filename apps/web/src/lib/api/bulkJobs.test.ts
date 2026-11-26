import { describe, expect, it, vi } from 'vitest';
vi.mock('./client', () => ({ apiClient: {} }));
import { bulkJobSchema, isTerminalJob, jobAcceptedSchema, progressText } from './bulkJobs';

const base = {
  jobId: 'dues-k1',
  kind: 'dues_bulk' as const,
  status: 'running' as const,
  total: 1250,
  processed: 420,
  succeeded: 420,
  failed: 0,
  written: 420,
  percent: 33,
  failures: [],
  params: {},
  createdAt: '2026-11-26T07:00:00.000Z',
  updatedAt: '2026-11-26T07:00:10.000Z',
};

describe('toplu is ilerlemesi', () => {
  it('bolum sayaci Turkce bicimde', () => {
    expect(progressText(base)).toBe('İşleniyor: 420 / 1.250 bölüm (%33)');
    expect(progressText({ ...base, status: 'pending' })).toContain('Sıraya alındı');
    expect(progressText({ ...base, kind: 'meter_posting', phase: 'prepare' })).toContain('yeniden hesaplanıyor');
  });

  it('bitis durumlari ve 202 govdesi', () => {
    expect(isTerminalJob({ status: 'completed_with_errors' })).toBe(true);
    expect(isTerminalJob({ status: 'running' })).toBe(false);
    expect(isTerminalJob(undefined)).toBe(false);
    const accepted = jobAcceptedSchema.parse({ mode: 'job', created: true, job: { ...base, extra: 'gizli alanlar atilir' } });
    expect(accepted.job).toMatchObject({ jobId: 'dues-k1', processed: 420 });
    expect(bulkJobSchema.parse({ ...base, written: undefined }).written).toBe(0);
  });
});
