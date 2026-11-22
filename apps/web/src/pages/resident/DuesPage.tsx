import { ReceiptText } from 'lucide-react';
import { useMemo } from 'react';
import { BankTransferCard } from '@/components/portal/BankTransferCard';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { PayOnlineButton } from '@/components/portal/PayOnlineButton';
import { PortalStatusBadge } from '@/components/portal/PortalStatusBadge';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitContext';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { documentsApi } from '@/lib/api/documents';
import { useMyStatement, useMySummary } from '@/hooks/usePortal';
import { formatDate } from '@/lib/dates';
import { type StatementRow, mergeStatement } from '@/lib/api/portal';
import { cn } from '@/lib/cn';
import { formatTRY } from '@/lib/money';

const TYPE_LABEL: Record<StatementRow['entryType'], string> = {
  ACCRUAL: 'Tahakkuk',
  COLLECTION: 'Tahsilat',
  REVERSAL: 'Düzeltme',
  LATE_FEE: 'Gecikme tazminatı',
  OTHER: 'Diğer',
};

function SummaryCard() {
  const summary = useMySummary();
  if (summary.isPending) {
    return (
      <Card role="status" aria-label="Borç durumu yükleniyor" className="flex flex-col gap-3">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-9 w-1/2" />
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      </Card>
    );
  }
  if (summary.isError) return <PortalQueryState error={summary.error} onRetry={() => void summary.refetch()} />;
  const s = summary.data;

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-small text-muted">
            {s.unitLabel} · {s.relationLabel}
          </p>
          <p className="text-small text-muted">Güncel borç</p>
          <p className={cn('text-title font-bold tabular-nums', s.debt === 0 && 'text-success')}>{formatTRY(s.debt)}</p>
        </div>
        <PortalStatusBadge status={s.status} />
      </div>
      {s.overdueAmount > 0 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-small text-warning">
          {formatTRY(s.overdueAmount)} gecikmede (en eski vade {s.oldestOverdueDueDate ? formatDate(s.oldestOverdueDueDate) : '—'}, {s.daysOverdue} gün).
        </p>
      )}
      {s.accruedLateFee > 0 && (
        <p className="text-small text-muted">
          Bugüne kadar işleyen gecikme tazminatı: <strong className="text-warning tabular-nums">{formatTRY(s.accruedLateFee)}</strong>. Ödenen
          kısım için tazminat ödeme gününde durur; işleyen tutar her ayın 1’inde borcunuza eklenir.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-md bg-surface-muted p-3">
          <dt className="text-small text-muted">Toplam tahakkuk</dt>
          <dd className="font-semibold tabular-nums">{formatTRY(s.totalCharged)}</dd>
        </div>
        <div className="rounded-md bg-surface-muted p-3">
          <dt className="text-small text-muted">Toplam ödenen</dt>
          <dd className="font-semibold text-success tabular-nums">{formatTRY(s.totalPaid)}</dd>
        </div>
        {s.advance > 0 ? (
          <div className="col-span-2 rounded-md bg-surface-muted p-3 sm:col-span-1">
            <dt className="text-small text-muted">Avans</dt>
            <dd className="font-semibold text-success tabular-nums">{formatTRY(s.advance)}</dd>
          </div>
        ) : s.nextDue ? (
          <div className="col-span-2 rounded-md bg-surface-muted p-3 sm:col-span-1">
            <dt className="text-small text-muted">Sıradaki son ödeme</dt>
            <dd className="font-semibold tabular-nums">{formatDate(s.nextDue.dueDate)}</dd>
          </div>
        ) : null}
      </dl>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PayOnlineButton />
        <span className="ml-auto">
          <ChangeUnitLink />
        </span>
      </div>
    </Card>
  );
}

/** Borc: notr; tahsilat: yesil. Iptal edilen satir ustu cizili + "İptal edildi" rozeti. */
function Amount({ row }: { row: StatementRow }) {
  const isCredit = row.credit > 0;
  return (
    <span className={cn('font-semibold tabular-nums', isCredit ? 'text-success' : 'text-text', row.reversed && 'text-muted line-through')}>
      {isCredit ? `−${formatTRY(row.credit)}` : formatTRY(row.debit)}
    </span>
  );
}

function RowMeta({ row }: { row: StatementRow }) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <Badge tone={row.entryType === 'COLLECTION' ? 'success' : 'neutral'}>{TYPE_LABEL[row.entryType]}</Badge>
      {row.reversed && <Badge tone="warning">İptal edildi</Badge>}
      {row.entryType === 'ACCRUAL' && row.dueDate && <span className="text-small text-muted">Son ödeme {formatDate(row.dueDate)}</span>}
    </span>
  );
}

type DocOpener = ReturnType<typeof useOpenDocument>;

/** Makbuz no: tahsilat satirinda PDF'i yeni sekmede acar. */
function ReceiptLink({ row, docs, unitId }: { row: StatementRow; docs: DocOpener; unitId?: string }) {
  if (!row.receiptNumber) return <span className="text-muted">—</span>;
  const paymentId = row.paymentId;
  if (!paymentId) return <span className="font-mono">{row.receiptNumber}</span>;
  return (
    <Button
      size="xs"
      variant="subtle"
      className="-ml-2.5 font-mono"
      loading={docs.pendingId === paymentId}
      aria-label={`${row.receiptNumber} numaralı makbuzu aç`}
      onClick={() => void docs.open(paymentId, () => documentsApi.myReceipt(paymentId, unitId))}
    >
      {docs.pendingId !== paymentId && <ReceiptText className="size-3.5" aria-hidden="true" />}
      {row.receiptNumber}
    </Button>
  );
}

function Movements() {
  const statement = useMyStatement();
  const docs = useOpenDocument();
  const { unitId } = usePortalUnit();
  const rows = useMemo(() => (statement.data ? mergeStatement(statement.data) : []), [statement.data]);

  if (statement.isPending) {
    return (
      <div role="status" aria-label="Hareketler yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-14 w-full" />
        ))}
      </div>
    );
  }
  // Ust kart secici/bos durumu zaten gosterir; burada tekrar etmeyiz.
  if (statement.isError) return null;
  if (rows.length === 0) {
    return (
      <Card className="flex flex-col items-center gap-2 py-10 text-center">
        <ReceiptText className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Henüz hesap hareketi yok</p>
        <p className="text-small text-muted">Aidat tahakkukları ve ödemeleriniz burada listelenecek.</p>
      </Card>
    );
  }

  return (
    <section aria-labelledby="movements-title" className="flex flex-col gap-3">
      <h2 id="movements-title" className="text-heading font-semibold">
        Hesap hareketleri
      </h2>
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}

      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Hesap hareketleri, en yeni önce</caption>
          <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Tarih</th>
              <th scope="col" className="px-4 py-3 font-medium">Açıklama</th>
              <th scope="col" className="px-4 py-3 font-medium">Makbuz No</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Borç</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Tahsilat</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-text-secondary [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted/40">
            {rows.map((r) => (
              <tr key={`${r.transactionId}-${r.liableParty}`} className={cn('align-top', r.reversed && 'opacity-70')}>
                <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDate(r.date)}</td>
                <td className="px-4 py-3">
                  <span className={cn(r.reversed && 'line-through')}>{r.description}</span>
                  <span className="mt-1 block">
                    <RowMeta row={r} />
                  </span>
                </td>
                <td className="px-4 py-3 text-small whitespace-nowrap">
                  <ReceiptLink row={r} docs={docs} unitId={unitId} />
                </td>
                <td className={cn('px-4 py-3 text-right tabular-nums', r.reversed && 'line-through')}>
                  {r.debit > 0 ? formatTRY(r.debit) : <span className="text-muted">—</span>}
                </td>
                <td className={cn('px-4 py-3 text-right tabular-nums', r.reversed ? 'line-through' : 'text-success')}>
                  {r.credit > 0 ? formatTRY(r.credit) : <span className="text-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-2 md:hidden" aria-label="Hesap hareketleri">
        {rows.map((r) => (
          <li key={`${r.transactionId}-${r.liableParty}`} className={cn('rounded-xl border border-border bg-surface/60 p-4 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong', r.reversed && 'opacity-70')}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={cn('font-medium', r.reversed && 'line-through')}>{r.description}</p>
                <p className="text-small text-muted">{formatDate(r.date)}</p>
                {r.receiptNumber && (
                  <div className="mt-1">
                    <ReceiptLink row={r} docs={docs} unitId={unitId} />
                  </div>
                )}
              </div>
              <Amount row={r} />
            </div>
            <div className="mt-2">
              <RowMeta row={r} />
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DuesPage() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-title font-bold">Borçlarım</h1>
      <SummaryCard />
      <BankTransferCard />
      <Movements />
    </div>
  );
}
