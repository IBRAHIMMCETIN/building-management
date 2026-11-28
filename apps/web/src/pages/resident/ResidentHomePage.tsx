import { ArrowRight, CircleCheck, TriangleAlert, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { BankTransferCard } from '@/components/portal/BankTransferCard';
import { ExpenseDonutCard } from '@/components/portal/ExpenseDonutCard';
import { PayOnlineButton } from '@/components/portal/PayOnlineButton';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { RecentPaymentsCard } from '@/components/portal/RecentPaymentsCard';
import { Card, CardTitle, Skeleton } from '@/components/ui';
import { usePaymentQuote } from '@/hooks/usePayments';
import { useMyAnnouncements, useMySummary } from '@/hooks/usePortal';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { MyTicketsCard } from './tickets/MyTicketsCard';

/** Online odeme aciksa buton; degilse elden/havale notu. */
function OnlinePayHint() {
  const quote = usePaymentQuote();
  if (quote.data?.onlinePaymentEnabled && quote.data.totalDue > 0) return <PayOnlineButton className="self-start" />;
  return <p className="text-small text-muted">Ödemenizi aşağıdaki IBAN'a havale ederek veya yöneticinize elden yapabilirsiniz.</p>;
}

/**
 * Adim 3 - "Borcunuz" karti: tek bakista tutar ve son odeme tarihi. Sakin ekraninda muhasebe
 * terimi kullanilmaz (cari, tahakkuk, mahsup...).
 */
function DebtCard() {
  const summary = useMySummary();

  if (summary.isPending) {
    return (
      <Card role="status" aria-label="Borç bilgisi yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </Card>
    );
  }
  if (summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;

  const s = summary.data;
  const clear = s.debt === 0;

  return (
    <Card className="flex flex-col gap-4" aria-labelledby="debt-title">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="debt-title" className="text-heading font-semibold">
            Borcunuz
          </h2>
          <p className="text-small text-muted">
            {s.unitLabel} · {s.relationLabel}
          </p>
        </div>
        <ChangeUnitLink />
      </div>

      {clear ? (
        <div className="flex items-center gap-3 rounded-md bg-success/10 px-4 py-4 text-success">
          <CircleCheck className="size-8 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-lg font-semibold">Borcunuz yok</p>
            {s.advance > 0 && <p className="text-small">{formatTRY(s.advance)} fazla ödemeniz var; sonraki aidatlarınızdan düşülecek.</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-4xl font-bold tabular-nums sm:text-5xl" data-testid="debt-amount">
            {formatTRY(s.debt)}
          </p>
          {s.overdueAmount > 0 ? (
            <p className="flex items-start gap-2 rounded-md bg-warning/10 px-3 py-2 text-small text-warning">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {formatTRY(s.overdueAmount)} tutarın son ödeme günü {s.daysOverdue} gün önce geçti.
                {s.accruedLateFee > 0 ? ` Gecikme bedeli bugüne kadar ${formatTRY(s.accruedLateFee)}; ayın 1'inde borcunuza eklenir.` : ' Gecikme bedeli eklenebilir.'}
              </span>
            </p>
          ) : s.nextDue ? (
            <p className="text-small text-muted">
              Son ödeme günü: <strong className="text-text">{formatDate(s.nextDue.dueDate)}</strong>
            </p>
          ) : null}
          <OnlinePayHint />
        </div>
      )}

      <div className="border-t border-border pt-3">
        <Link to="/app/dues" className="inline-flex items-center gap-1 text-small font-medium text-accent underline-offset-4 hover:underline">
          Borç ayrıntısı
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}

/** Buyuk, tek dokunusla "Ariza bildir" (telefonda tam genislik). */
function ReportFaultButton() {
  return (
    <Link
      to="/app/talepler/yeni"
      className="flex items-center justify-center gap-3 rounded-xl bg-primary px-5 py-4 text-lg font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <Wrench className="size-6" aria-hidden="true" />
      Arıza bildir
    </Link>
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

/**
 * Adim 3 - sade sakin ana sayfasi (teknolojiyi az kullanan sakin icin tek bakista):
 *  1. Borcunuz (buyuk tutar, son odeme gunu)  2. IBAN ve referans kodu (tek dokunusla kopyala)
 *  3. Ariza bildir  4. Aidatiniz nereye gidiyor? (`resident.expenseChart` aciksa)
 *  5. Son odemeleriniz  6. Son duyurular  7. Taleplerim
 */
export function ResidentHomePage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Hoş geldiniz</h1>
      <div className="grid gap-6 lg:grid-cols-2 lg:gap-4">
        <div className="flex flex-col gap-6 lg:gap-4">
          <DebtCard />
          <ReportFaultButton />
          <BankTransferCard />
        </div>
        <div className="flex flex-col gap-6 lg:gap-4">
          <ExpenseDonutCard />
          <RecentPaymentsCard />
          <LatestAnnouncementsCard />
          <MyTicketsCard />
        </div>
      </div>
    </div>
  );
}
