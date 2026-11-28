import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Input } from '@/components/ui';
import { useDismissFeatureRequest, usePendingFeatureRequests } from '@/hooks/useSiteFeatureAdmin';
import { errorMessage } from '@/lib/api/errors';
import type { FeatureRequest } from '@/lib/api/siteFeatures';
import { FEATURE_LABELS } from '@/lib/features/catalog';
import { REASON_MIN } from '@/lib/features/draft';
import { formatDateTime } from '@/lib/dates';

/**
 * Platform: yoneticilerin "acilmasini istiyorum" talepleri. "Ozellikleri ac" site ozellik
 * penceresini acar (ozellik acilinca talep otomatik kapanir); "Reddet" gerekceyle kapatir.
 * Bekleyen talep yoksa kart gosterilmez.
 */
export function FeatureRequestsCard({ onOpenSite }: { onOpenSite: (site: { siteId: string; name: string }) => void }) {
  const pending = usePendingFeatureRequests();
  const dismiss = useDismissFeatureRequest();
  const [rejecting, setRejecting] = useState<FeatureRequest | null>(null);
  const [reason, setReason] = useState('');

  const items = pending.data ?? [];
  if (pending.isPending || (items.length === 0 && !pending.isError)) return null;

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <Inbox className="size-5 text-muted" aria-hidden="true" />
        Özellik açma talepleri ({items.length})
      </CardTitle>
      {pending.isError && <Alert tone="danger">{errorMessage(pending.error)}</Alert>}
      <ul className="flex flex-col divide-y divide-border" aria-label="Özellik açma talepleri">
        {items.map((r) => {
          const name = r.siteName ?? r.apartmentId;
          const isRejecting = rejecting?.apartmentId === r.apartmentId && rejecting.feature === r.feature;
          return (
            <li key={`${r.apartmentId}-${r.feature}`} className="flex flex-col gap-2 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-small font-medium">
                    {name} · {FEATURE_LABELS[r.feature]}
                  </p>
                  <p className="text-small text-muted">
                    {formatDateTime(r.requestedAt)}
                    {r.note ? ` · “${r.note}”` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => onOpenSite({ siteId: r.apartmentId, name })}>
                    Özellikleri aç
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => {
                      setRejecting(r);
                      setReason('');
                      dismiss.reset();
                    }}>
                    Reddet
                  </Button>
                </div>
              </div>
              {isRejecting && (
                <form
                  className="flex flex-col gap-2 sm:flex-row sm:items-end"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (reason.trim().length < REASON_MIN) return;
                    dismiss.mutate({ siteId: r.apartmentId, feature: r.feature, reason: reason.trim() }, { onSuccess: () => setRejecting(null) });
                  }}
                >
                  <div className="flex-1">
                    <FormField label="Ret gerekçesi" hint={`En az ${REASON_MIN} karakter; denetim günlüğüne yazılır.`}>
                      <Input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
                    </FormField>
                  </div>
                  <Button type="submit" size="sm" variant="danger" disabled={reason.trim().length < REASON_MIN || dismiss.isPending}>
                    Reddet
                  </Button>
                  {dismiss.isError && <Alert tone="danger">{errorMessage(dismiss.error)}</Alert>}
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
