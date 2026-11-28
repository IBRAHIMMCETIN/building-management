import { ToggleRight } from 'lucide-react';
import { RequestFeatureButton } from '@/components/features/FeatureDisabledNotice';
import { Alert, Badge, Card, CardTitle, Skeleton } from '@/components/ui';
import { useSiteFeatures } from '@/context/SiteFeaturesContext';
import { PROFILE_LABELS } from '@/lib/features/catalog';

/**
 * Adim 1 - yoneticinin kendi sitesindeki ozellik durumu (salt okunur). Anahtarlari yalnizca platform
 * ekibi degistirir; kapali ozellik icin "Acilmasini istiyorum" talebi gonderilir. Gelistirilmemis
 * (yakinda) ozellikler icin talep dugmesi gosterilmez.
 */
export function SiteFeaturesCard() {
  const { status, view, catalog } = useSiteFeatures();

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle className="flex items-center gap-2">
        <ToggleRight className="size-5 text-muted" aria-hidden="true" />
        Site özellikleri
      </CardTitle>
      {status === 'loading' && <Skeleton className="h-24" />}
      {status === 'error' && <Alert tone="danger">Site özellikleri yüklenemedi.</Alert>}
      {view && (
        <>
          <p className="text-small text-muted">
            Kullanım modu: <span className="font-medium text-text">{PROFILE_LABELS[view.profile]}</span>. Özellikleri platform ekibi açar veya kapatır;
            kapalı bir özelliğe ihtiyacınız varsa talep gönderebilirsiniz.
          </p>
          <ul className="flex flex-col divide-y divide-border" aria-label="Site özellikleri">
            {catalog.map((def) => {
              const on = view.features[def.key];
              return (
                <li key={def.key} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-small font-medium">{def.label}</p>
                    <p className="text-small text-muted">{def.description}</p>
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                    {def.upcoming ? (
                      <Badge>Yakında</Badge>
                    ) : on ? (
                      <Badge tone="success">Açık</Badge>
                    ) : view.planRestricted?.includes(def.key) ? (
                      <Badge tone="warning">Aboneliğinizde yok</Badge>
                    ) : (
                      <Badge>Kapalı</Badge>
                    )}
                    {!on && !def.upcoming && <RequestFeatureButton feature={def.key} compact />}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Card>
  );
}
