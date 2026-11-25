import { ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Badge, FilterChips, Skeleton } from '@/components/ui';
import { useMyTickets } from '@/hooks/usePortalTickets';
import { errorMessage } from '@/lib/api/errors';
import { PORTAL_CLOSED_STATUSES, PORTAL_OPEN_STATUSES, awaitsMyConfirmation } from '@/lib/api/portalTickets';
import { formatDate } from '@/lib/dates';
import { CATEGORY_LABELS } from '@/lib/tickets/model';

/** Sakin "Arıza / Talep": actigim ve dairemin talepleri; onayimi bekleyenler vurgulu. */
export function MyTicketsPage() {
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const list = useMyTickets(tab === 'open' ? PORTAL_OPEN_STATUSES : PORTAL_CLOSED_STATUSES);
  const items = [...(list.data?.items ?? [])].sort((a, b) => Number(awaitsMyConfirmation(b)) - Number(awaitsMyConfirmation(a)));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-title font-bold">Arıza / Talep</h1>
        <Link to="/app/talepler/yeni" className="inline-flex h-10 items-center gap-2 rounded-md bg-primary px-4 text-small font-medium text-on-primary shadow-sm hover:bg-primary-hover">
          <Plus className="size-4" aria-hidden="true" />
          Yeni talep
        </Link>
      </div>
      <FilterChips label="Talep durumu" value={tab} onChange={setTab} options={[{ value: 'open', label: 'Açık' }, { value: 'closed', label: 'Kapanan' }]} />
      {list.isPending ? (
        <Skeleton className="h-40" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">{tab === 'open' ? 'Açık talebiniz yok. Bir arıza bildirmek için "Yeni talep"e dokunun.' : 'Kapanmış talep yok.'}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((t) => {
            const waiting = awaitsMyConfirmation(t);
            return (
              <li key={t.ticketId}>
                <Link
                  to={`/app/talepler/${encodeURIComponent(t.ticketId)}`}
                  className={`flex items-center gap-3 rounded-xl border bg-surface p-3 shadow-xs hover:border-border-strong ${waiting ? 'border-success/50' : 'border-border'}`}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-xs text-muted">
                      <span className="font-mono">{t.number}</span> · {CATEGORY_LABELS[t.category]} · {formatDate(t.createdAt)}
                    </span>
                    <span className="font-medium">{t.title}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <TicketStatusBadge status={t.status} />
                      {waiting && <Badge tone="success">Onayınızı bekliyor</Badge>}
                      {t.location.kind === 'common' && <span className="text-xs text-muted">Ortak alan · {t.location.area}</span>}
                    </span>
                  </span>
                  <ChevronRight className="size-5 text-muted" aria-hidden="true" />
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
