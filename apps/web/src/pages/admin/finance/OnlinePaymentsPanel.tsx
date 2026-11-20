import { CreditCard, ReceiptText, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, FilterChips, Skeleton } from '@/components/ui';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useManagerPayments, useNeedsReviewCount, usePaymentAccountSummary } from '@/hooks/usePayments';
import { documentsApi } from '@/lib/api/documents';
import { errorMessage } from '@/lib/api/errors';
import type { IntentStatus, ManagerIntent } from '@/lib/api/payments';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { REVIEW_ACTION_LABELS, accountStatusView, formatBasisPoints, intentStatusLabel, intentStatusTone } from '@/lib/payments/manager';
import { partyLabel } from '@/lib/payments/result';
import { cn } from '@/lib/cn';
import { useUnitOptions } from './useUnitOptions';

type Filter = 'all' | IntentStatus;

const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'SUCCEEDED', label: 'Başarılı' },
  { value: 'PENDING', label: 'Bekleyen' },
  { value: 'FAILED', label: 'Başarısız' },
  { value: 'NEEDS_REVIEW', label: 'İnceleme gerekli' },
  { value: 'REFUNDED', label: 'İade edildi' },
];

type DocOpener = ReturnType<typeof useOpenDocument>;

function AccountCard() {
  const account = usePaymentAccountSummary();
  if (account.isPending) {
    return (
      <Card role="status" aria-label="Ödeme hesabı yükleniyor" className="flex flex-col gap-2">
        <Skeleton className="h-5 w-1/4" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
    );
  }
  if (account.isError) return <Alert tone="danger">{errorMessage(account.error)}</Alert>;

  const a = account.data;
  const view = accountStatusView(a);
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <CreditCard className="size-4" aria-hidden="true" />
            Online ödeme hesabı
          </span>
        </CardTitle>
        <div className="flex gap-1.5">
          {a.sandbox && <Badge tone="accent">Test ortamı</Badge>}
          <Badge tone={view.tone}>{view.label}</Badge>
        </div>
      </div>
      <p className="text-small text-muted">{view.body}</p>
      {a.status !== 'not_registered' && (
        <dl className="grid gap-3 text-small sm:grid-cols-3">
          {a.ibanMasked && (
            <div className="rounded-md bg-surface-muted p-3">
              <dt className="text-muted">Aktarım IBAN</dt>
              <dd className="font-medium tabular-nums">{a.ibanMasked}</dd>
            </div>
          )}
          {a.platformFeeBasisPoints !== undefined && (
            <div className="rounded-md bg-surface-muted p-3">
              <dt className="text-muted">Platform payı</dt>
              <dd className="font-medium">{formatBasisPoints(a.platformFeeBasisPoints)}</dd>
            </div>
          )}
          {a.updatedAt && (
            <div className="rounded-md bg-surface-muted p-3">
              <dt className="text-muted">Son güncelleme</dt>
              <dd className="font-medium">{formatDateTime(a.updatedAt)}</dd>
            </div>
          )}
        </dl>
      )}
    </Card>
  );
}

function ReviewBanner({ onShow }: { onShow: () => void }) {
  const review = useNeedsReviewCount();
  if (!review.data || review.data.count === 0) return null;
  const { count, more } = review.data;
  return (
    <div role="alert" className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-warning">
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-0.5 size-5 shrink-0" aria-hidden="true" />
        <div className="text-small">
          <p className="font-semibold">
            {count}
            {more ? '+' : ''} online ödeme inceleme bekliyor
          </p>
          <p>
            Kartından çekim yapılmış ancak deftere yazılamamış ödemeler. Sakinden tekrar ödeme istemeyin; platform yöneticisi ödemeyi
            sağlayıcıdan doğrulayıp deftere işler veya tam iade eder. Karar ve gerekçe burada görünür.
          </p>
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onShow}>
        Göster
      </Button>
    </div>
  );
}

function ReceiptButtons({ intent, docs }: { intent: ManagerIntent; docs: DocOpener }) {
  const ids = intent.paymentIds ?? [];
  if (intent.status !== 'SUCCEEDED' || ids.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5">
      {ids.map((paymentId, i) => (
        <Button
          key={paymentId}
          variant="subtle"
          size="xs"
          loading={docs.pendingId === paymentId}
          onClick={() => void docs.open(paymentId, () => documentsApi.receiptForPayment(paymentId))}
        >
          <ReceiptText className="size-3.5" aria-hidden="true" />
          {intent.receiptNumbers?.[i] ?? 'Makbuz'}
        </Button>
      ))}
    </div>
  );
}

function IntentNote({ intent }: { intent: ManagerIntent }) {
  const decision = intent.resolution && (
    <p className="mt-1 text-small text-muted">
      Platform kararı: <span className="font-medium text-text">{REVIEW_ACTION_LABELS[intent.resolution.action].done}</span> ·{' '}
      {formatDateTime(intent.resolution.at)} — “{intent.resolution.note}”
      {intent.refundedAmount !== undefined && ` · ${formatTRY(intent.refundedAmount)} iade edildi`}
    </p>
  );
  if (intent.status === 'NEEDS_REVIEW' && intent.review) {
    return <p className="mt-1 text-small text-warning">{intent.review.reason}</p>;
  }
  if (intent.status === 'FAILED' && intent.failure) {
    return (
      <>
        <p className="mt-1 text-small text-muted">{intent.failure.message}</p>
        {decision}
      </>
    );
  }
  return decision ?? null;
}

function Breakdown({ intent }: { intent: ManagerIntent }) {
  return (
    <p className="text-small text-muted">
      {intent.allocations
        .map((a) => `${partyLabel(a.liableParty)}: ${formatTRY(a.amount)}${a.lateFee > 0 ? ` (tazminat ${formatTRY(a.lateFee)})` : ''}`)
        .join(' · ')}
    </p>
  );
}

export function OnlinePaymentsPanel() {
  const [filter, setFilter] = useState<Filter>('all');
  const query = useManagerPayments(filter === 'all' ? undefined : filter);
  const units = useUnitOptions();
  const docs = useOpenDocument();
  const unitLabel = useMemo(() => new Map(units.options.map((u) => [u.unitId, u.label])), [units.options]);
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const label = (unitId: string) => unitLabel.get(unitId) ?? 'Daire';

  let list;
  if (query.isPending) {
    list = (
      <div role="status" aria-label="Online ödemeler yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  } else if (query.isError) {
    list = (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(query.error)}</Alert>
        <Button variant="secondary" onClick={() => void query.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  } else if (items.length === 0) {
    list = (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <CreditCard className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">{filter === 'all' ? 'Henüz online ödeme yok' : 'Bu durumda online ödeme yok'}</p>
        <p className="max-w-content text-small text-muted">
          Sakinler kartla ödeme yaptığında işlemler burada listelenir; başarılı ödemeler ayrıca Hareketler sekmesinde tahsilat olarak görünür.
        </p>
      </Card>
    );
  } else {
    list = (
      <>
        <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm md:block">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Online ödemeler</caption>
            <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">Tarih</th>
                <th scope="col" className="px-4 py-3 font-medium">Daire</th>
                <th scope="col" className="px-4 py-3 font-medium">Dağılım</th>
                <th scope="col" className="px-4 py-3 font-medium">Durum</th>
                <th scope="col" className="px-4 py-3 text-right font-medium">Tutar</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border text-text-secondary">
              {items.map((it) => (
                <tr key={it.intentId} className={cn('align-top', it.status === 'NEEDS_REVIEW' && 'bg-warning/5')}>
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDateTime(it.paidAt ?? it.createdAt)}</td>
                  <td className="px-4 py-3 whitespace-nowrap">{label(it.unitId)}</td>
                  <td className="px-4 py-3">
                    <Breakdown intent={it} />
                    <IntentNote intent={it} />
                    <ReceiptButtons intent={it} docs={docs} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={intentStatusTone(it.status)}>{intentStatusLabel(it.status)}</Badge>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <span className="font-semibold tabular-nums">{formatTRY(it.amount)}</span>
                    {it.platformFee > 0 && <p className="text-xs text-muted">Platform payı {formatTRY(it.platformFee)}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <ul className="flex flex-col gap-2 md:hidden" aria-label="Online ödemeler">
          {items.map((it) => (
            <li
              key={it.intentId}
              className={cn(
                'flex flex-col gap-1 rounded-xl border border-border bg-surface/60 p-4 shadow-sm',
                it.status === 'NEEDS_REVIEW' && 'border-warning/40 bg-warning/5',
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">{label(it.unitId)}</p>
                  <p className="text-small text-muted">{formatDateTime(it.paidAt ?? it.createdAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold tabular-nums">{formatTRY(it.amount)}</p>
                  <Badge tone={intentStatusTone(it.status)}>{intentStatusLabel(it.status)}</Badge>
                </div>
              </div>
              <Breakdown intent={it} />
              <IntentNote intent={it} />
              <ReceiptButtons intent={it} docs={docs} />
            </li>
          ))}
        </ul>

        {query.hasNextPage && (
          <Button variant="secondary" className="self-center" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            Daha eski ödemeleri yükle
          </Button>
        )}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <AccountCard />
      {filter !== 'NEEDS_REVIEW' && <ReviewBanner onShow={() => setFilter('NEEDS_REVIEW')} />}
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
      <FilterChips<Filter> label="Ödeme durumu" value={filter} onChange={setFilter} options={FILTERS} />
      {list}
    </div>
  );
}
