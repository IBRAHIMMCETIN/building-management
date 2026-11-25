import { ArrowRight, Wrench } from 'lucide-react';
import { Link } from 'react-router';
import { Card, CardTitle, Skeleton } from '@/components/ui';
import { useMyTickets } from '@/hooks/usePortalTickets';
import { PORTAL_OPEN_STATUSES, awaitsMyConfirmation } from '@/lib/api/portalTickets';

/** Ana sayfa: acik talep sayisi ve onayini bekleyenler. */
export function MyTicketsCard() {
  const list = useMyTickets(PORTAL_OPEN_STATUSES);
  const items = list.data?.items ?? [];
  const waiting = items.filter(awaitsMyConfirmation).length;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <Wrench className="size-5 text-muted" aria-hidden="true" />
        Arıza / Talep
      </CardTitle>
      {list.isPending ? (
        <Skeleton className="h-6 w-1/2" />
      ) : list.isError ? (
        <p className="text-small text-muted">Talepler şu an yüklenemedi.</p>
      ) : (
        <p className="text-small">
          {items.length === 0 ? 'Açık talebiniz yok.' : `${items.length} açık talep`}
          {waiting > 0 && <span className="ml-1 font-medium text-success">· {waiting} talep onayınızı bekliyor</span>}
        </p>
      )}
      <div className="flex flex-wrap gap-4 text-small">
        <Link to="/app/talepler/yeni" className="font-medium text-accent underline-offset-4 hover:underline">
          Arıza bildir
        </Link>
        <Link to="/app/talepler" className="inline-flex items-center gap-1 text-muted hover:text-text">
          Taleplerim
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </Card>
  );
}
