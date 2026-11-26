import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Skeleton, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useReversePeriod, useReversePreview } from '@/hooks/useMeters';
import type { BulkJob } from '@/lib/api/bulkJobs';
import { type MeterPeriod, blockersOf } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { formatTRY } from '@/lib/money';
import { type ReverseForm, reverseSchema } from './schemas';

type Props = {
  period: MeterPeriod | null;
  unitLabel: (unitId: string, fallback?: string) => string;
  onClose: () => void;
  /** P1-b: buyuk donem (202) arka plan isine alindi; ilerleme donem kartinda izlenir. */
  onJob?: (job: BulkJob) => void;
};

/**
 * Onayli donemin toplu geri alinmasi (ters kayit). Varsayilan SESSIZ: sakinlere bildirim gitmez;
 * "Sakinleri bilgilendir" yalnizca acikca isaretlenirse. Gecikme tazminati otomatik geri alinmaz (uyari).
 */
export function ReverseDialog({ period, unitLabel, onClose, onJob }: Props) {
  const preview = useReversePreview(period?.periodId ?? null, !!period);
  const reverse = useReversePeriod();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const form = useForm<ReverseForm>({ resolver: zodResolver(reverseSchema), defaultValues: { reason: '', notify: false } });
  const { errors } = form.formState;

  useEffect(() => {
    if (!period) return;
    reverse.reset();
    renewKey();
    form.reset({ reason: '', notify: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [period?.periodId]);

  if (!period) return null;
  const p = preview.data;
  const serverBlockers = blockersOf(reverse.error);
  const blockers = serverBlockers.length ? serverBlockers : (p?.blockers ?? []);

  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await reverse.mutateAsync({ periodId: period.periodId, idempotencyKey, reason: v.reason, notify: v.notify });
      if ('mode' in r && r.mode === 'job') onJob?.(r.job);
    } catch {
      /* asagida gosterilir; ag hatasinda ayni anahtarla tekrar denenir (devam) */
    }
  });

  const result = reverse.data;
  const done = result && !('mode' in result) ? result : undefined;

  return (
    <Dialog open={!!period} onClose={() => !reverse.isPending && onClose()} title={`Dönemi geri al — ${period.name}`} className="max-w-xl">
      {done ? (
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">{done.reversed ?? 0} tahakkuk ters kayıtla geri alındı</p>
          <p className="text-small text-muted">
            {done.notified ? 'Sakinlere bildirim gönderildi.' : 'Sakinlere bildirim gönderilmedi (sessiz).'} Düzeltilmiş dönemi dönem ekranından açabilirsiniz.
          </p>
          <Button onClick={onClose}>Kapat</Button>
        </div>
      ) : (
        <form noValidate onSubmit={submit} className="flex flex-col gap-4">
          {preview.isPending && <Skeleton className="h-24" />}
          {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
          {p && (
            <>
              <p className="text-small">
                {p.items.length} dairenin toplam <strong className="tabular-nums">{formatTRY(p.total)}</strong> tahakkuku ters kayıtla kapatılır. Defterden
                silme yapılmaz; tahsilatlar avansa döner.
              </p>
              <div className="max-h-48 overflow-y-auto rounded-md border border-border">
                <table className="w-full text-small" aria-label="Geri alınacak tahakkuklar">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="px-2 py-1">Daire</th>
                      <th className="px-2 text-right">Tutar</th>
                      <th className="px-2">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.items.map((i) => (
                      <tr key={`${i.unitId}-${i.liability?.kind ?? ''}`} className="border-t border-border">
                        <td className="px-2 py-1">
                          {unitLabel(i.unitId, i.unitNumber)}
                          {i.liability?.kind === 'former' && <span className="text-muted"> · ayrılan cari</span>}
                        </td>
                        <td className="px-2 text-right tabular-nums">{formatTRY(i.amount)}</td>
                        <td className="px-2">
                          {i.state === 'reversed' ? 'Geri alındı' : i.state === 'reversible' ? 'Geri alınabilir' : i.state === 'blocked' ? 'Engelli' : 'Bulunamadı'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {blockers.length > 0 && (
            <Alert tone="danger">
              <p className="font-medium">Geri alma engellendi:</p>
              <ul className="list-disc pl-4">
                {blockers.map((b) => (
                  <li key={`${b.code}-${b.unitId ?? ''}-${b.meterId ?? ''}`}>
                    {b.unitId ? `${unitLabel(b.unitId)}: ` : ''}
                    {b.message}
                  </li>
                ))}
              </ul>
            </Alert>
          )}
          {!!p?.lateFeeWarnings.length && (
            <div role="alert" className="flex gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-small text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {p.lateFeeWarnings.map((w) => unitLabel(w.unitId)).join(', ')} için bu tahakkuktan sonra gecikme tazminatı işlenmiş. Tazminat otomatik geri
                alınmaz; gerekirse Finans ekranından ayrıca düzeltin.
              </span>
            </div>
          )}

          <FormField label="Gerekçe" error={errors.reason?.message}>
            <Textarea rows={2} placeholder="Hatalı sayaç okuması, düzeltilmiş dönem açılacak…" {...form.register('reason')} />
          </FormField>
          <label className="flex items-start gap-2 text-small">
            <input type="checkbox" className="mt-1" {...form.register('notify')} />
            <span>
              Sakinleri bilgilendir
              <span className="block text-muted">İşaretlenmezse geri alma sessiz yapılır (varsayılan).</span>
            </span>
          </label>

          {reverse.isError && serverBlockers.length === 0 && <Alert tone="danger">{errorMessage(reverse.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={reverse.isPending}>
              Vazgeç
            </Button>
            <Button type="submit" variant="danger" loading={reverse.isPending} disabled={!p || !p.canReverse}>
              Toplu geri al
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
