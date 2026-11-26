import { CheckCircle2, CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { Alert, Button } from '@/components/ui';
import { useBulkJob, useRetryBulkJob } from '@/hooks/useBulkJob';
import { type BulkJob, isTerminalJob, progressText } from '@/lib/api/bulkJobs';
import { errorMessage } from '@/lib/api/errors';
import { formatTRY } from '@/lib/money';

/**
 * Arka plan toplu isinin canli ilerlemesi: "İşleniyor: 420 / 1.250 bölüm (%34)", bitince ozet,
 * hatali bolumler ve (yetkiliyse) "Tekrar dene". Pencere kapatilsa bile is sunucuda devam eder.
 */
export function BulkJobProgress({
  job: initial,
  onSettled,
  canRetry = true,
}: {
  job: BulkJob;
  onSettled?: (job: BulkJob) => void;
  canRetry?: boolean;
}) {
  const query = useBulkJob(initial.jobId, { initial, ...(onSettled ? { onSettled } : {}) });
  const retry = useRetryBulkJob();
  const job = query.data ?? initial;
  const done = isTerminalJob(job);
  const percent = job.status === 'completed' ? 100 : job.percent;

  return (
    <div className="flex flex-col gap-3" data-testid="bulk-job-progress">
      <div className="flex items-center gap-2 text-small font-medium" aria-live="polite">
        {!done && <LoaderCircle className="size-4 animate-spin text-accent" aria-hidden="true" />}
        {job.status === 'completed' && <CheckCircle2 className="size-4 text-success" aria-hidden="true" />}
        {(job.status === 'failed' || job.status === 'completed_with_errors') && <CircleAlert className="size-4 text-danger" aria-hidden="true" />}
        <span>{done ? doneTitle(job) : progressText(job)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Toplu işlem ilerlemesi"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-2 w-full overflow-hidden rounded-full bg-surface-muted"
      >
        <div
          className={`h-full rounded-full transition-[width] duration-500 ${job.status === 'failed' ? 'bg-danger' : job.status === 'completed_with_errors' ? 'bg-warning' : 'bg-accent'}`}
          style={{ width: `${percent}%` }}
        />
      </div>

      {!done && <p className="text-xs text-muted">Bu pencereyi kapatabilirsiniz; işlem sunucuda devam eder ve tekrar açtığınızda kaldığı yerden görünür.</p>}

      {done && <ResultSummary job={job} />}

      {job.failures.length > 0 && (
        <div className="flex flex-col gap-1 rounded-md border border-danger/20 bg-danger/5 p-3 text-xs">
          <span className="font-medium text-danger">Yazılamayan bölümler ({job.failed})</span>
          <ul className="max-h-40 overflow-y-auto">
            {job.failures.map((f) => (
              <li key={f.unitId}>
                <span className="font-medium">{f.unitNumber ?? f.unitId}</span>: {f.message}
              </li>
            ))}
          </ul>
          {job.failed > job.failures.length && <span className="text-muted">… ve {job.failed - job.failures.length} bölüm daha</span>}
        </div>
      )}

      {job.status === 'failed' && job.error && <Alert tone="danger">{job.error.message}</Alert>}
      {query.isError && !done && <p className="text-xs text-muted">Durum alınamadı ({errorMessage(query.error)}); yeniden deneniyor…</p>}
      {retry.isError && <Alert tone="danger">{errorMessage(retry.error)}</Alert>}

      {canRetry && (job.status === 'failed' || job.status === 'completed_with_errors') && (
        <Button variant="secondary" size="sm" className="self-start" loading={retry.isPending} onClick={() => retry.mutate(job.jobId)}>
          <RotateCcw className="size-4" aria-hidden="true" />
          Tekrar dene
        </Button>
      )}
    </div>
  );
}

function doneTitle(job: BulkJob): string {
  if (job.status === 'failed') return 'İşlem tamamlanamadı';
  if (job.status === 'completed_with_errors') return `İşlem bitti: ${job.succeeded.toLocaleString('tr-TR')} bölüm yazıldı, ${job.failed.toLocaleString('tr-TR')} bölüm yazılamadı`;
  return 'İşlem tamamlandı';
}

function ResultSummary({ job }: { job: BulkJob }) {
  const r = job.result;
  if (!r || job.status === 'failed') return null;
  if (job.kind === 'dues_bulk') {
    return (
      <div className="flex flex-col gap-1 text-small text-muted">
        <p>
          {(r.count ?? 0).toLocaleString('tr-TR')} daireye toplam {formatTRY(r.distributedAmount ?? 0)} borç yazıldı.
        </p>
        {!!r.exemptCount && <p>{r.exemptCount} daire muaf tutuldu.</p>}
        {!!r.vacantCount && <p>{r.vacantCount} boş daire için borç kat malikine yazıldı.</p>}
        {r.replayed && <p>Bu tahakkuk daha önce yapılmıştı; tekrar yazılmadı.</p>}
      </div>
    );
  }
  if (job.kind === 'meter_reversal') {
    return (
      <p className="text-small text-muted">
        {(r.reversed ?? 0).toLocaleString('tr-TR')} ters kayıt işlendi{r.replayed ? ' (dönem daha önce geri alınmıştı)' : ''}.
      </p>
    );
  }
  return (
    <p className="text-small text-muted">
      {(r.posted ?? 0).toLocaleString('tr-TR')} bölüme tahakkuk yazıldı{r.replayed ? ' (dönem daha önce onaylanmıştı)' : ''}.
    </p>
  );
}
