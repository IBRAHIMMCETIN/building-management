import { CircleAlert, CircleCheck, Clock, Info, LoaderCircle, ReceiptText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { Alert, Button, Card, Skeleton } from '@/components/ui';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { usePaymentIntent } from '@/hooks/usePayments';
import { documentsApi } from '@/lib/api/documents';
import type { PaymentIntent } from '@/lib/api/payments';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { escapeFrame, returnResult } from '@/lib/payments/checkout';
import { type ResultTone, type ResultView, callbackErrorView, intentResultView, partyLabel } from '@/lib/payments/result';

const toneStyles: Record<ResultTone, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: 'bg-success/10 text-success' },
  danger: { icon: CircleAlert, className: 'bg-danger/10 text-danger' },
  warning: { icon: Clock, className: 'bg-warning/10 text-warning' },
  info: { icon: Info, className: 'bg-surface-muted text-text-secondary' },
};

function ResultHeader({ view, pending }: { view: ResultView; pending?: boolean }) {
  const { icon: Icon, className } = toneStyles[view.tone];
  return (
    <div className={cn('flex items-start gap-3 rounded-lg px-4 py-4', className)} role={view.tone === 'danger' ? 'alert' : 'status'}>
      {pending ? <LoaderCircle className="mt-0.5 size-6 shrink-0 animate-spin" aria-hidden="true" /> : <Icon className="mt-0.5 size-6 shrink-0" aria-hidden="true" />}
      <div className="flex flex-col gap-1">
        <p className="font-semibold">{view.title}</p>
        <p className="text-small">{view.body}</p>
      </div>
    </div>
  );
}

function Receipts({ intent }: { intent: PaymentIntent }) {
  const docs = useOpenDocument();
  const ids = intent.paymentIds ?? [];
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-small font-medium">Makbuz{ids.length > 1 ? 'lar' : ''}</p>
      <ul className="flex flex-col gap-2">
        {ids.map((paymentId, i) => (
          <li key={paymentId} className="flex items-center justify-between gap-3 rounded-md bg-surface-muted px-3 py-2">
            <span className="text-small tabular-nums">{intent.receiptNumbers?.[i] ?? `Makbuz ${i + 1}`}</span>
            <Button
              variant="secondary"
              size="sm"
              loading={docs.pendingId === paymentId}
              onClick={() => void docs.open(paymentId, () => documentsApi.myReceipt(paymentId, intent.unitId))}
            >
              <ReceiptText className="size-4" aria-hidden="true" />
              Makbuzu aç
            </Button>
          </li>
        ))}
      </ul>
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
    </div>
  );
}

function IntentDetails({ intent }: { intent: PaymentIntent }) {
  return (
    <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-small">
      {intent.allocations.map((a) => (
        <div key={a.liableParty} className="contents">
          <dt className="text-muted">{partyLabel(a.liableParty)} carisi</dt>
          <dd className="text-right tabular-nums">{formatTRY(a.amount)}</dd>
        </div>
      ))}
      <dt className="font-medium">Toplam</dt>
      <dd className="text-right font-semibold tabular-nums">{formatTRY(intent.amount)}</dd>
      {intent.paidAt && (
        <>
          <dt className="text-muted">Ödeme zamanı</dt>
          <dd className="text-right">{formatDateTime(intent.paidAt)}</dd>
        </>
      )}
    </dl>
  );
}

function Actions({ canRetry }: { canRetry: boolean }) {
  return (
    <div className="flex flex-wrap gap-3 border-t border-border pt-4">
      {canRetry && (
        <Link
          to="/app/odeme"
          className="inline-flex h-10 items-center rounded-md bg-primary px-4 text-small font-medium text-on-primary hover:bg-primary-hover"
        >
          Tekrar dene
        </Link>
      )}
      <Link
        to="/app/dues"
        className="inline-flex h-10 items-center rounded-md border border-border-strong px-4 text-small font-medium hover:bg-surface-muted"
      >
        Borçlarım
      </Link>
    </div>
  );
}

function IntentResult({ intentId, returned }: { intentId: string; returned?: 'ok' | 'fail' }) {
  const intent = usePaymentIntent(intentId);

  if (intent.isPending) {
    return (
      <Card role="status" aria-label="Ödeme sonucu yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-5 w-1/2" />
      </Card>
    );
  }
  if (intent.isError) return <PortalQueryState error={intent.error} onRetry={() => void intent.refetch()} />;

  const view = intentResultView(intent.data, intent.timedOut, returned);
  return (
    <Card className="flex flex-col gap-4">
      <ResultHeader view={view} pending={!view.terminal} />
      <IntentDetails intent={intent.data} />
      {intent.data.status === 'SUCCEEDED' && <Receipts intent={intent.data} />}
      <Actions canRetry={view.canRetry} />
    </Card>
  );
}

/**
 * Saglayici donus sayfasi: `?intent=<id>[&result=ok|fail]` veya `?error=invalid|not_found`.
 * PayTR donusu odeme iframe'inin icinde acilir: sayfa kendini ust pencereye tasir.
 */
export function PaymentResultPage() {
  const [params] = useSearchParams();
  const intentId = params.get('intent');
  const error = params.get('error');
  const returned = returnResult(params.get('result'));
  const [escaping, setEscaping] = useState(false);
  useEffect(() => {
    if (escapeFrame(window)) setEscaping(true);
  }, []);

  if (escaping) {
    return (
      <p role="status" className="flex items-center gap-2 text-small text-muted">
        <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
        Ödeme sonucuna yönlendiriliyorsunuz…
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <h1 className="text-title font-bold">Ödeme sonucu</h1>
      {intentId ? (
        <IntentResult intentId={intentId} returned={returned} />
      ) : (
        <Card className="flex flex-col gap-4">
          <ResultHeader view={callbackErrorView(error ?? 'invalid')} />
          <Actions canRetry={false} />
        </Card>
      )}
    </div>
  );
}
