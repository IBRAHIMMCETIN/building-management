import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { type BulkJob, bulkJobsApi, isTerminalJob } from '@/lib/api/bulkJobs';
import { useAuth } from './useAuth';

export const bulkJobKeys = {
  one: (apartmentId: string, jobId: string) => ['bulk-job', apartmentId, jobId] as const,
};

/** Calisan iste 1,5 sn'de bir hafif sorgu; is bitince sorgu durur ve `onSettled` bir kez cagrilir. */
export const JOB_POLL_MS = 1500;

export function useBulkJob(jobId: string | null | undefined, opts: { initial?: BulkJob; onSettled?: (job: BulkJob) => void } = {}) {
  const { user } = useAuth();
  const apt = user?.apartmentId ?? '';
  const query = useQuery({
    queryKey: bulkJobKeys.one(apt, jobId ?? ''),
    queryFn: ({ signal }) => bulkJobsApi.get(jobId as string, signal),
    enabled: !!jobId && !!apt,
    ...(opts.initial && opts.initial.jobId === jobId ? { initialData: opts.initial, initialDataUpdatedAt: 0 } : {}),
    refetchInterval: (q) => (isTerminalJob(q.state.data) ? false : JOB_POLL_MS),
    refetchIntervalInBackground: true,
    retry: 3,
  });

  // Bitis bildirimi tek sefer (ayni is icin tekrar render'da yeniden cagrilmaz).
  const notified = useRef<string | null>(null);
  const onSettled = opts.onSettled;
  const data = query.data;
  useEffect(() => {
    if (!data || !isTerminalJob(data)) return;
    const key = `${data.jobId}:${data.finishedAt ?? data.updatedAt}`;
    if (notified.current === key) return;
    notified.current = key;
    onSettled?.(data);
  }, [data, onSettled]);

  return query;
}

export function useRetryBulkJob() {
  const qc = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: (jobId: string) => bulkJobsApi.retry(jobId),
    onSuccess: (job) => qc.setQueryData(bulkJobKeys.one(user?.apartmentId ?? '', job.jobId), job),
  });
}
