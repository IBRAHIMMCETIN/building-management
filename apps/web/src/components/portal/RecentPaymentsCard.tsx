import { ArrowRight, Receipt } from 'lucide-react';
import { Link } from 'react-router';
import { Card, CardTitle, Skeleton } from '@/components/ui';
import { useMyReceipts } from '@/hooks/usePortal';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

const METHOD_LABEL = { cash: 'Elden', bank_transfer: 'Havale / EFT', card: 'Kart' } as const;

/** Son 3 odeme (makbuz). Daire secimi hatalarini borc karti gosterdigi icin burada sessiz kalinir. */
export function RecentPaymentsCard() {
  const q = useMyReceipts();
  if (q.isError) return null;
  const items = (q.data?.items ?? []).filter((i) => i.status === 'valid').slice(0, 3);

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle className="flex items-center gap-2">
        <Receipt className="size-5 text-muted" aria-hidden="true" />
        Son ödemeleriniz
      </CardTitle>
      {q.isPending ? (
        <div role="status" aria-label="Ödemeler yükleniyor" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : items.length === 0 ? (
        <p className="text-small text-muted">Henüz kayıtlı ödemeniz yok.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((p) => (
            <li key={p.paymentId} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <span className="flex flex-col">
                <span className="font-medium">{formatDate(p.paidAt)}</span>
                <span className="text-small text-muted">{METHOD_LABEL[p.method]}</span>
              </span>
              <span className="font-semibold tabular-nums">{formatTRY(p.amount)}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-border pt-3">
        <Link to="/app/dues" className="inline-flex items-center gap-1 text-small font-medium text-accent underline-offset-4 hover:underline">
          Tüm ödemeler ve borç ayrıntısı
          <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}
