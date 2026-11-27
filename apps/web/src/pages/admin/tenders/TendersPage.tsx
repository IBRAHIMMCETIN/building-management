import { Plus, Scale } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { TenderCard } from '@/components/tenders/TenderCard';
import { Alert, Button, Card, FilterChips, Skeleton } from '@/components/ui';
import { useTenderPermissions, useTenders } from '@/hooks/useTenders';
import { errorMessage } from '@/lib/api/errors';
import { TENDER_STATUSES, type TenderStatus } from '@/lib/api/tenders';
import { TENDER_STATUS_LABELS } from '@/lib/tenders/model';
import { TenderDialog } from './TenderDialog';

type Filter = 'all' | TenderStatus;

/**
 * "İhaleler": büyük tadilat / bakım işleri için teklif toplama. Yönetim taslaktan karara kadar
 * yürütür; denetçi yalnızca sakinlerle paylaşılmış ihaleleri salt okur görür. Filtre `?status=`.
 */
export function TendersPage() {
  const { canRead, canWrite } = useTenderPermissions();
  const list = useTenders();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const raw = params.get('status');
  const filter: Filter = raw && (TENDER_STATUSES as readonly string[]).includes(raw) ? (raw as TenderStatus) : 'all';

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">İhaleler</h1>
        <Alert>Bu rol ihaleleri görüntüleyemez.</Alert>
      </div>
    );
  }

  const items = list.data ?? [];
  const count = (s: TenderStatus) => items.filter((t) => t.status === s).length;
  const shown = filter === 'all' ? items : items.filter((t) => t.status === filter);
  const setFilter = (f: Filter) => {
    const next = new URLSearchParams(params);
    if (f === 'all') next.delete('status');
    else next.set('status', f);
    setParams(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">İhaleler</h1>
          <p className="text-small text-muted">Büyük tadilat ve bakım işlerinde teklif toplama, sakinlerle şeffaf paylaşım ve karar.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni ihale
          </Button>
        )}
      </div>

      {!canWrite && <Alert>Denetçi olarak yalnızca sakinlerle paylaşılmış ihaleleri görürsünüz.</Alert>}

      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Scale className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Henüz ihale yok</p>
          <p className="max-w-content text-small text-muted">Mantolama, asansör, çatı gibi büyük işler için en az üç teklif toplayın; teklifleri belgeleriyle sakinlerle paylaşıp kararı kayda geçirin.</p>
          {canWrite && (
            <Button variant="secondary" onClick={() => setCreating(true)}>
              İlk ihaleyi oluşturun
            </Button>
          )}
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          <FilterChips<Filter>
            label="Durum filtresi"
            value={filter}
            onChange={setFilter}
            options={[{ value: 'all', label: 'Tümü', count: items.length }, ...TENDER_STATUSES.filter((s) => count(s) > 0).map((s) => ({ value: s, label: TENDER_STATUS_LABELS[s], count: count(s) }))]}
          />
          {shown.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {shown.map((t) => (
                <li key={t.tenderId}>
                  <TenderCard tender={t} to={`/admin/tenders/${encodeURIComponent(t.tenderId)}`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-10 text-center text-small text-muted">Bu durumda ihale yok.</p>
          )}
        </div>
      )}

      {canWrite && <TenderDialog open={creating} onClose={() => setCreating(false)} />}
    </div>
  );
}
