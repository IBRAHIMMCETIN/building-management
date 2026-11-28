import { DEMO_UNIT_RANGE_LABELS } from '@bm/shared/api/demoRequests';
import { Inbox, Mail, Phone } from 'lucide-react';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { useDemoRequests } from '@/hooks/usePlatform';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';

/**
 * Platform: tanitim sayfasindaki formdan gelen demo talepleri (en yeni once, 25'er). Kayitlar 2 yil
 * sonra otomatik silinir. Talep sahibine e-posta henuz otomatik gitmez; donus buradaki bilgilerle
 * elle yapilir.
 */
export function DemoRequestsPage() {
  const list = useDemoRequests();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  let body;
  if (list.isPending) {
    body = (
      <div role="status" aria-label="Demo talepleri yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  } else if (list.isError) {
    body = (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
        <Button variant="secondary" onClick={() => void list.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  } else if (items.length === 0) {
    body = (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <Inbox className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Henüz demo talebi yok</p>
        <p className="max-w-content text-small text-muted">Tanıtım sayfasındaki formdan gelen talepler burada listelenir.</p>
      </Card>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2" aria-label="Demo talepleri">
        {items.map((r) => (
          <li key={r.requestId} className="flex flex-col gap-3 rounded-xl border border-border bg-surface/60 p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{r.organization}</p>
                  <Badge>{DEMO_UNIT_RANGE_LABELS[r.unitRange]}</Badge>
                </div>
                <p className="text-small text-muted">
                  {r.fullName} · {formatDateTime(r.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-small">
                <a href={`mailto:${r.email}`} className="inline-flex items-center gap-1.5 text-accent underline-offset-4 hover:underline">
                  <Mail className="size-4" aria-hidden="true" />
                  {r.email}
                </a>
                {r.phone && (
                  <a href={`tel:${r.phone.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-1.5 text-accent underline-offset-4 hover:underline">
                    <Phone className="size-4" aria-hidden="true" />
                    {r.phone}
                  </a>
                )}
              </div>
            </div>
            {r.message && <p className="text-small whitespace-pre-line text-text-secondary">{r.message}</p>}
            <p className="text-small text-muted">
              KVKK onayı: aydınlatma metni {r.kvkkVersion}
              {r.ipMasked ? ` · IP ${r.ipMasked}` : ''}
            </p>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <Inbox className="size-5" aria-hidden="true" />
          Demo talepleri
        </h1>
        <p className="text-small text-muted">
          Tanıtım sayfasındaki formdan gelen talepler, en yeni önce. Talep sahibine otomatik e-posta gitmez; dönüşü buradaki bilgilerle yapın.
          Kayıtlar 2 yıl sonra kendiliğinden silinir.
        </p>
      </div>
      {body}
      {list.hasNextPage && (
        <Button variant="secondary" className="self-center" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
          Daha fazla yükle
        </Button>
      )}
    </div>
  );
}
