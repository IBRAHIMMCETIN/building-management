import { CircleAlert, CircleCheck, Clock, RefreshCw } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Skeleton, Textarea } from '@/components/ui';
import { useResolveReview, useReviewCheck } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { ReviewAction, ReviewIntent } from '@/lib/api/payments';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { REVIEW_ACTION_LABELS, intentStatusLabel, intentStatusTone } from '@/lib/payments/manager';
import { partyLabel } from '@/lib/payments/result';
import { NOTE_MAX, noteError, providerCheckLabel, refundProgress } from '@/lib/payments/review';

type Target = { apartmentId: string; intentId: string; apartmentName: string };

const ACTION_HELP: Record<ReviewAction, string> = {
  approve: 'Tahsilat ve makbuz deftere yazılır; sakinin borcu kapanır.',
  refund: 'Her sepet kalemi ödenen tutarın tamamıyla karta iade edilir; defterde hareket oluşmaz.',
  close: 'Kayıt başarısız olarak kapatılır; defter ve iade işlemi yapılmaz.',
};

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="text-right">{children}</dd>
    </>
  );
}

function IntentSummary({ intent, apartmentName }: { intent: ReviewIntent; apartmentName: string }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md bg-surface-muted p-3 text-small">
      <Row label="Apartman">{apartmentName}</Row>
      <Row label="Daire / sakin">
        {intent.unitId} · {intent.userId}
      </Row>
      <Row label="Niyet tutarı">
        <span className="font-semibold tabular-nums">{formatTRY(intent.amount)}</span>
      </Row>
      {intent.allocations.map((a) => (
        <Row key={a.liableParty} label={`${partyLabel(a.liableParty)} carisi`}>
          <span className="tabular-nums">{formatTRY(a.amount)}</span>
        </Row>
      ))}
      {intent.providerPaymentId && <Row label="iyzico ödeme no">{intent.providerPaymentId}</Row>}
      <Row label="Oluşturma">{formatDateTime(intent.createdAt)}</Row>
      {intent.review && (
        <>
          <dt className="text-muted">İnceleme nedeni</dt>
          <dd className="text-right text-warning">{intent.review.reason}</dd>
        </>
      )}
    </dl>
  );
}

function RefundItems({ intent }: { intent: ReviewIntent }) {
  if (!intent.refund) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small font-medium">İade kalemleri</p>
      <ul className="flex flex-col gap-1.5">
        {intent.refund.items.map((it) => (
          <li key={it.paymentTransactionId} className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-surface-muted px-3 py-2 text-small">
            <span className="tabular-nums">
              {it.paymentTransactionId} · {formatTRY(it.amount)}
            </span>
            <span className="flex items-center gap-2">
              {it.error && it.status !== 'succeeded' && <span className="text-muted">{it.error.message}</span>}
              <Badge tone={it.status === 'succeeded' ? 'success' : it.status === 'failed' ? 'danger' : 'warning'}>
                {it.status === 'succeeded' ? 'İade edildi' : it.status === 'failed' ? 'Reddedildi' : 'Sürüyor'}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Inceleme bekleyen odemeyi sonuclandirma. Acilista saglayicidan guncel sonuc sorgulanir; API
 * karari yine kendisi dogrular (ekrandaki kontrol eskimis olabilir, surum degismisse 409).
 */
export function ReviewDialog({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const check = useReviewCheck(target ? { apartmentId: target.apartmentId, intentId: target.intentId } : null);
  const resolve = useResolveReview();
  const [action, setAction] = useState<ReviewAction | null>(null);
  const [note, setNote] = useState('');
  const [noteErr, setNoteErr] = useState<string | undefined>();
  const [confirmRefund, setConfirmRefund] = useState(false);

  useEffect(() => {
    if (!target) return;
    setAction(null);
    setNote('');
    setNoteErr(undefined);
    setConfirmRefund(false);
    resolve.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [target?.intentId]);

  const data = check.data;
  const intent = resolve.data?.intent ?? data?.intent;
  const decided = resolve.isSuccess;
  const allowed = data?.actions.filter((a) => a.allowed) ?? [];
  const selected = data?.actions.find((a) => a.action === action);

  const submit = async () => {
    if (!target || !data || !action) return;
    const err = noteError(note);
    setNoteErr(err);
    if (err) return;
    if (action === 'refund' && !confirmRefund) {
      setConfirmRefund(true);
      return;
    }
    try {
      await resolve.mutateAsync({
        apartmentId: target.apartmentId,
        intentId: target.intentId,
        input: { action, note: note.trim(), expectedVersion: data.intent.version },
      });
    } catch (e) {
      if (e instanceof ApiError && e.field === 'note') setNoteErr(e.message);
      setConfirmRefund(false);
    }
  };

  const conflict = resolve.error instanceof ApiError && resolve.error.status === 409;
  const progress = intent ? refundProgress(intent.refund) : undefined;

  let body;
  if (check.isPending) {
    body = (
      <div role="status" aria-label="Sağlayıcı sorgulanıyor" className="flex flex-col gap-2">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-2/3" />
      </div>
    );
  } else if (check.isError) {
    body = (
      <div className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(check.error)}</Alert>
        <Button variant="secondary" onClick={() => void check.refetch()}>
          <RefreshCw className="size-4" aria-hidden="true" />
          Tekrar sorgula
        </Button>
      </div>
    );
  } else if (intent && target) {
    body = (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <Badge tone={intentStatusTone(intent.status)}>{intentStatusLabel(intent.status)}</Badge>
          {progress && (
            <span className="text-small text-muted">
              {formatTRY(progress.refunded)} / {formatTRY(progress.amount)} iade edildi
            </span>
          )}
        </div>
        <IntentSummary intent={intent} apartmentName={target.apartmentName} />

        {data?.check && !decided && (
          <div
            className={cn(
              'flex items-start gap-2 rounded-md px-3 py-2 text-small',
              data.check.status === 'success' ? 'bg-success/10 text-success' : data.check.status === 'failure' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning',
            )}
          >
            {data.check.status === 'success' ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : data.check.status === 'failure' ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            ) : (
              <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            )}
            <div>
              <p className="font-medium">{providerCheckLabel(data.check)}</p>
              <p>
                {data.check.paidAmount !== undefined && `Çekilen tutar ${formatTRY(data.check.paidAmount)}. `}
                {data.check.problems.length > 0 ? `Uyuşmazlık: ${data.check.problems.join('; ')}` : data.check.status === 'success' ? 'Niyetle birebir eşleşiyor.' : data.check.errorMessage ?? ''}
              </p>
              <p className="text-xs opacity-80">Sorgu: {formatDateTime(data.check.checkedAt)}</p>
            </div>
          </div>
        )}

        <RefundItems intent={intent} />

        {intent.resolution && (
          <p className="text-small text-muted">
            Karar: <strong className="text-text">{REVIEW_ACTION_LABELS[intent.resolution.action].done}</strong> · {intent.resolution.by} ·{' '}
            {formatDateTime(intent.resolution.at)} — “{intent.resolution.note}”
          </p>
        )}

        {decided ? (
          <Alert tone="success">
            {intent.status === 'REFUND_PENDING'
              ? 'İade kararı kaydedildi. Kalan kalemler arka planda tamamlanacak; reddedilen kalem varsa buradan yeniden deneyebilirsiniz.'
              : 'Karar kaydedildi.'}
          </Alert>
        ) : allowed.length === 0 ? (
          <Alert>
            {data?.actions.find((a) => a.reason)?.reason ?? 'Şu an yapılabilecek bir işlem yok.'} Gerekirse sağlayıcı panelinden kontrol edip
            daha sonra tekrar sorgulayın.
          </Alert>
        ) : (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-small font-medium">Karar</legend>
            {data!.actions.map((a) => (
              <label
                key={a.action}
                className={cn(
                  'flex items-start gap-3 rounded-md border border-border px-3 py-2.5',
                  a.allowed ? 'cursor-pointer hover:border-border-strong' : 'cursor-not-allowed opacity-60',
                  action === a.action && 'border-accent/40 bg-accent/5',
                )}
              >
                <input
                  type="radio"
                  name="review-action"
                  className="mt-1 size-4 accent-[var(--color-accent)]"
                  disabled={!a.allowed}
                  checked={action === a.action}
                  onChange={() => {
                    setAction(a.action);
                    setConfirmRefund(false);
                  }}
                />
                <span className="flex flex-col">
                  <span className="font-medium">
                    {intent.status === 'REFUND_PENDING' && a.action === 'refund' ? 'İadeyi yeniden dene' : REVIEW_ACTION_LABELS[a.action].label}
                  </span>
                  <span className="text-small text-muted">{a.allowed ? ACTION_HELP[a.action] : a.reason}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

        {!decided && allowed.length > 0 && (
          <FormField label="Gerekçe" error={noteErr} hint="Denetim kaydına yazılır; apartman yöneticisi de görür.">
            <Textarea
              rows={3}
              maxLength={NOTE_MAX}
              value={note}
              placeholder="Örn. iyzico panelinde tutar farkı doğrulandı, tam iade"
              onChange={(e) => {
                setNote(e.target.value);
                setNoteErr(undefined);
              }}
            />
          </FormField>
        )}

        {confirmRefund && selected?.action === 'refund' && (
          <Alert tone="danger">
            {formatTRY(intent.amount)} tutarındaki ödemenin tamamı karta iade edilecek. Bu işlem geri alınamaz. Onaylıyorsanız tekrar “İade et”e
            basın.
          </Alert>
        )}
        {resolve.isError && (
          <Alert tone="danger">
            {errorMessage(resolve.error)}
            {conflict && ' Güncel durum yeniden yüklendi.'}
          </Alert>
        )}
      </div>
    );
  }

  return (
    <Dialog open={target !== null} onClose={onClose} title="Ödemeyi sonuçlandır" className="max-w-2xl">
      <div className="flex flex-col gap-4">
        {body}
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={onClose}>
            {decided ? 'Kapat' : 'Vazgeç'}
          </Button>
          {!decided && allowed.length > 0 && (
            <Button
              variant={action === 'refund' ? 'danger' : 'primary'}
              disabled={!action}
              loading={resolve.isPending}
              onClick={() => void submit()}
            >
              {action === 'refund' ? (confirmRefund ? 'İade et' : 'İadeye devam') : action ? REVIEW_ACTION_LABELS[action].label : 'Bir karar seçin'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
