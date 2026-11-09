import { Megaphone } from 'lucide-react';
import { ChangeUnitLink, PortalQueryState } from '@/components/portal/PortalQueryState';
import { Card, Skeleton } from '@/components/ui';
import { useMyAnnouncements } from '@/hooks/usePortal';
import { formatDateTime } from '@/lib/dates';

/** Sakin: dairesinin blogunu kapsayan, yayin penceresindeki duyurular (en yeni once). */
export function ResidentAnnouncementsPage() {
  const list = useMyAnnouncements();

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-title font-bold">Duyurular</h1>
        <ChangeUnitLink />
      </div>

      {list.isPending ? (
        <div role="status" aria-label="Duyurular yükleniyor" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-16" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      ) : list.data.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Megaphone className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Güncel duyuru yok</p>
          <p className="text-small text-muted">Yönetiminiz bir duyuru yayınladığında burada görünecek.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {list.data.map((a) => (
            <li key={a.announcementId}>
              <Card className="flex flex-col gap-2 p-5">
                <h2 className="text-heading font-semibold break-words">{a.title}</h2>
                <p className="text-small text-muted">
                  <time dateTime={a.publishAt}>{formatDateTime(a.publishAt)}</time>
                </p>
                <p className="text-body whitespace-pre-line break-words">{a.body}</p>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
