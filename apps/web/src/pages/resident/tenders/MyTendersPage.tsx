import { Scale } from 'lucide-react';
import { TenderCard } from '@/components/tenders/TenderCard';
import { Alert, Card, Skeleton } from '@/components/ui';
import { useMyTenders } from '@/hooks/useTenders';
import { errorMessage } from '@/lib/api/errors';

/** Sakin "İhaleler": yönetimin sakinlerle paylaştığı ihaleler (teklifler yan yana, belgeler, karar). */
export function MyTendersPage() {
  const list = useMyTenders();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-title font-bold">İhaleler</h1>
        <p className="text-small text-muted">Büyük tadilat ve bakım işleri için alınan teklifler, belgeleri ve yönetimin kararı.</p>
      </div>
      {list.isPending ? (
        <div role="status" aria-label="İhaleler yükleniyor" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : list.data.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Scale className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Paylaşılmış ihale yok</p>
          <p className="text-small text-muted">Yönetim bir iş için aldığı teklifleri paylaştığında burada yan yana görebilirsiniz.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((t) => (
            <li key={t.tenderId}>
              <TenderCard tender={t} to={`/app/ihale/${encodeURIComponent(t.tenderId)}`} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
