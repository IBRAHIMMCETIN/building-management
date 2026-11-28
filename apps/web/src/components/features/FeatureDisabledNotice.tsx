import { Lock, Send } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Textarea } from '@/components/ui';
import { useSiteFeatures } from '@/context/SiteFeaturesContext';
import { useCanRequestFeature, useRequestFeature, useSiteFeatureRequests } from '@/hooks/useSiteFeatureAdmin';
import { errorMessage } from '@/lib/api/errors';
import { FEATURE_LABELS, type FeatureKey } from '@/lib/features/catalog';

/** Ozelligin okunur adi (API katalogu, yoksa yerel yedek). */
export function useFeatureLabel(key: FeatureKey): string {
  const { catalog } = useSiteFeatures();
  return catalog.find((d) => d.key === key)?.label ?? FEATURE_LABELS[key];
}

/**
 * Yoneticinin "acilmasini istiyorum" dugmesi: talep platform ekibine gider (denetim kaydiyla).
 * Bekleyen talep varsa durum gosterilir; yonetici disindaki rollerde hicbir sey cizilmez.
 */
export function RequestFeatureButton({ feature, compact = false }: { feature: FeatureKey; compact?: boolean }) {
  const canRequest = useCanRequestFeature();
  const requests = useSiteFeatureRequests();
  const request = useRequestFeature();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');

  if (!canRequest) return null;
  const pending = (requests.data ?? []).some((r) => r.feature === feature) || request.isSuccess;
  if (pending) {
    return (
      <p role="status" className="text-small text-muted">
        Açılma talebiniz platform ekibine iletildi.
      </p>
    );
  }
  if (!open) {
    return (
      <Button size={compact ? 'sm' : 'md'} variant="secondary" onClick={() => setOpen(true)}>
        <Send className="size-4" aria-hidden="true" />
        Açtırmak istiyorum
      </Button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        request.mutate({ feature, note: note.trim() || undefined });
      }}
    >
      <FormField label="Not (isteğe bağlı)" hint="Neden ihtiyaç duyduğunuzu kısaca yazabilirsiniz.">
        <Textarea value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      {request.isError && <Alert tone="danger">{errorMessage(request.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={request.isPending}>
          Talebi gönder
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

/**
 * Kapali ozellik gorunumu: kapali bir ekrana / sekmeye dogrudan adresle gelindiginde gosterilir.
 * Ozellikler yuklenirken bos kalir (yanlis "kapali" mesaji gostermemek icin).
 */
export function FeatureDisabledNotice({ feature, title }: { feature: FeatureKey; title?: string }) {
  const { status } = useSiteFeatures();
  const label = useFeatureLabel(feature);
  if (status === 'loading') return <div role="status" aria-label="Yükleniyor" className="h-24" />;
  return (
    <Card className="flex flex-col items-start gap-3">
      <CardTitle className="flex items-center gap-2">
        <Lock className="size-5 text-muted" aria-hidden="true" />
        {title ?? label}
      </CardTitle>
      <p className="text-small text-muted">
        {status === 'error'
          ? 'Site ayarları şu an yüklenemedi. Lütfen biraz sonra tekrar deneyin.'
          : 'Bu özellik siteniz için kapalı. Açılması için platform ekibine talep gönderebilirsiniz.'}
      </p>
      {status !== 'error' && <RequestFeatureButton feature={feature} />}
    </Card>
  );
}
