import { ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useReviewQueue } from '@/hooks/usePayments';
import { errorMessage } from '@/lib/api/errors';
import type { ReviewQueueItem } from '@/lib/api/payments';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { intentStatusLabel, intentStatusTone } from '@/lib/payments/manager';
import { refundProgress } from '@/lib/payments/review';
import { ReviewDialog } from './ReviewDialog';

function QueueRow({ item, onOpen }: { item: ReviewQueueItem; onOpen: () => void }) {
  const progress = refundProgress(item.refund);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{item.apartmentName}</p>
          <Badge tone={intentStatusTone(item.status)}>{intentStatusLabel(item.status)}</Badge>
          <span className="font-semibold tabular-nums">{formatTRY(item.amount)}</span>
        </div>
        <p className="text-small text-muted">
          Daire {item.unitId} · {formatDateTime(item.createdAt)}
          {item.providerPaymentId && ` · iyzico ${item.providerPaymentId}`}
        </p>
        {item.status === 'NEEDS_REVIEW' && item.review && <p className="text-small text-warning">{item.review.reason}</p>}
        {progress && (
          <p className="text-small text-muted">
            {progress.done}/{progress.total} kalem iade edildi
            {progress.failed > 0 && <span className="text-danger"> · {progress.failed} kalem reddedildi</span>}
          </p>
        )}
      </div>
      <Button size="sm" variant={item.status === 'NEEDS_REVIEW' ? 'primary' : 'secondary'} onClick={onOpen}>
        {item.status === 'NEEDS_REVIEW' ? 'İncele' : 'Ayrıntı'}
      </Button>
    </li>
  );
}

/** Tum apartmanlarda inceleme bekleyen / iadesi suren online odemeler. Bos ise gorunmez. */
export function ReviewQueue() {
  const queue = useReviewQueue();
  const [open, setOpen] = useState<ReviewQueueItem | null>(null);

  // Diyalog kuyruktan bagimsiz: karar sonrasi kayit kuyruktan dussede acik kalir (sonuc gorunur).
  const dialog = (
    <ReviewDialog
      target={open ? { apartmentId: open.apartmentId, intentId: open.intentId, apartmentName: open.apartmentName } : null}
      onClose={() => setOpen(null)}
    />
  );
  if (queue.isPending) return <Skeleton className="h-20 w-full" />;
  if (queue.isError) return <Alert tone="danger">İnceleme kuyruğu yüklenemedi: {errorMessage(queue.error)}</Alert>;
  if (queue.data.items.length === 0) return dialog;

  const waiting = queue.data.items.filter((i) => i.status === 'NEEDS_REVIEW').length;
  return (
    <Card className="flex flex-col gap-3 border-warning/40">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>
          <span className="inline-flex items-center gap-2">
            <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
            İnceleme bekleyen ödemeler
          </span>
        </CardTitle>
        <span className="text-small text-muted">
          {waiting} karar bekliyor · {queue.data.items.length - waiting} iade sürüyor
        </span>
      </div>
      <p className="text-small text-muted">
        Kartından çekim yapılmış ama deftere yazılmamış ödemeler. Her kararda iyzico yeniden sorgulanır; gerekçe denetim kaydına yazılır.
      </p>
      <ul className="flex flex-col gap-2">
        {queue.data.items.map((item) => (
          <QueueRow key={`${item.apartmentId}:${item.intentId}`} item={item} onOpen={() => setOpen(item)} />
        ))}
      </ul>
      {dialog}
    </Card>
  );
}
