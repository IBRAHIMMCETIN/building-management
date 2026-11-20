import { ArrowRight, CircleCheck, TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { PayOnlineButton } from '@/components/portal/PayOnlineButton';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { PortalStatusBadge } from '@/components/portal/PortalStatusBadge';
import { Card, CardTitle, Skeleton } from '@/components/ui';
import { usePaymentQuote } from '@/hooks/usePayments';
import { useMyAnnouncements, useMySummary } from '@/hooks/usePortal';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

/** Online odeme aciksa buton; degilse elden/havale notu. */
function OnlinePayHint() {
  const quote = usePaymentQuote();
  if (quote.data?.onlinePaymentEnabled && quote.data.totalDue > 0) return <PayOnlineButton className="self-start" />;
  return <p className="text-small text-muted">Ödemelerinizi apartman yöneticinize elden veya banka havalesiyle yapabilirsiniz.</p>;
}

function DebtCard() {
  const summary = useMySummary();

  if (summary.isPending) {
    return (
      <Card role="status" aria-label="Borç özeti yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-9 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
    );
  }
  if (summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;

  const s = summary.data;
  const clear = s.debt === 0;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <CardTitle>Güncel borç</CardTitle>
          <p className="text-small text-muted">
            {s.unitLabel} · {s.relationLabel}
          </p>
        </div>
        <PortalStatusBadge status={s.status} />
      </div>

      {clear ? (
        <div className="flex items-center gap-3 rounded-md bg-success/10 px-4 py-3 text-success">
          <CircleCheck className="size-6 shrink-0" aria-hidden="true" />
          <div>
            <p className="font-semibold">Borcunuz bulunmamaktadır</p>
            {s.advance > 0 && <p className="text-small">{formatTRY(s.advance)} avansınız var; sonraki aidatlarınızdan düşülecek.</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-title font-bold tabular-nums">{formatTRY(s.debt)}</p>
          {s.overdueAmount > 0 ? (
            <p className="flex items-start gap-2 text-small text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {formatTRY(s.overdueAmount)} tutarın son ödeme tarihi {s.daysOverdue} gün önce geçti.
                {s.accruedLateFee > 0
                  ? ` Bugüne kadar işleyen gecikme tazminatı ${formatTRY(s.accruedLateFee)}; ayın 1'inde borcunuza eklenir.`
                  : ' Gecikme tazminatı uygulanabilir.'}
              </span>
            </p>
          ) : s.nextDue ? (
            <p className="text-small text-muted">
              {s.nextDue.description} · son ödeme <strong>{formatDate(s.nextDue.dueDate)}</strong>
            </p>
          ) : null}
          <OnlinePayHint />
        </div>
      )}

      {s.lastPayment && (
        <p className="text-small text-muted">
          Son ödeme: {formatDate(s.lastPayment.paidAt)} · {formatTRY(s.lastPayment.amount)} ({s.lastPayment.receiptNumber})
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <Link to="/app/dues" className="inline-flex items-center gap-1 text-small font-medium text-accent underline-offset-4 hover:underline">
          Hesap hareketlerim
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
        <ChangeUnitLink />
      </div>
    </Card>
  );
}

/** Son 3 duyuru. Daire secimi / uyelik hatalari borc kartinda gosterildigi icin burada sessiz kalinir. */
function LatestAnnouncementsCard() {
  const list = useMyAnnouncements();
  if (list.isError) return null;

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle>Son duyurular</CardTitle>
      {list.isPending ? (
        <div role="status" aria-label="Duyurular yükleniyor" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : list.data.length === 0 ? (
        <p className="text-small text-muted">Güncel duyuru yok.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {list.data.slice(0, 3).map((a) => (
            <li key={a.announcementId} className="flex flex-col gap-0.5 py-2 first:pt-0 last:pb-0">
              <span className="font-medium break-words">{a.title}</span>
              <time dateTime={a.publishAt} className="text-small text-muted">
                {formatDateTime(a.publishAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border pt-3">
        <Link to="/app/announcements" className="inline-flex items-center gap-1 text-small font-medium text-accent underline-offset-4 hover:underline">
          Tüm duyurular
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

export function ResidentHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Hoş geldiniz</h1>
      <DebtCard />
      <LatestAnnouncementsCard />
    </div>
  );
}
