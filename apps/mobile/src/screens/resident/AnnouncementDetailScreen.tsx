import { formatDateTime } from '@bm/shared/dates';
import { Megaphone } from '@/components/icons';
import { PortalQueryState } from '@/components/portal/PortalQueryState';
import { RefetchErrorBanner } from '@/components/portal/RefetchErrorBanner';
import { AppText, Card, EmptyState, LoadingBlock, Screen } from '@/components/ui';
import { useMyAnnouncements } from '@/hooks/usePortal';

/**
 * Duyuru ayrintisi. API'de tekil duyuru ucu yoktur; liste sorgusunun (ayni onbellek) icinden okunur.
 * Yayin penceresi dolan duyuru listeden duser: "artik yayinda degil" gosterilir.
 */
export function AnnouncementDetailScreen({ id }: { id: string }) {
  const list = useMyAnnouncements();

  if (list.isPending) {
    return (
      <Screen>
        <LoadingBlock label="Duyuru yükleniyor" lines={5} />
      </Screen>
    );
  }
  if (!list.data) {
    return (
      <Screen>
        <PortalQueryState error={list.error} onRetry={() => void list.refetch()} />
      </Screen>
    );
  }

  const a = list.data.find((x) => x.announcementId === id);
  if (!a) {
    return (
      <Screen>
        <EmptyState icon={Megaphone} title="Duyuru bulunamadı" description="Bu duyuru artık yayında değil veya kaldırılmış olabilir." />
      </Screen>
    );
  }

  return (
    <Screen>
      {list.isError && <RefetchErrorBanner error={list.error} onRetry={() => void list.refetch()} />}
      <Card>
        <AppText variant="heading" weight="semibold" accessibilityRole="header">
          {a.title}
        </AppText>
        <AppText variant="small" tone="muted">
          {formatDateTime(a.publishAt)}
          {a.expiresAt ? ` · ${formatDateTime(a.expiresAt)} tarihine kadar` : ''}
        </AppText>
        <AppText tone="secondary" selectable>
          {a.body}
        </AppText>
      </Card>
    </Screen>
  );
}
