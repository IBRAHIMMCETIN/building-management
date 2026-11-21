import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, FormField, Select, Skeleton } from '@/components/ui';
import { usePaymentSettings, useUpdatePaymentSettings } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { PlatformApartment } from '@/lib/api/payments';
import { DEFAULT_PROVIDER_OPTION, providerLabel, toProviderSetting } from '@/lib/payments/platform';

type Props = { apartment: PlatformApartment | null; onClose: () => void };

/**
 * Apartman bazinda odeme saglayicisi: iyzico / PayTR / ortam varsayilani. Surum kosullu (PUT
 * expectedVersion). Devam eden odemeler kendi saglayicisinda tamamlanir; yeni saglayicida alt uye
 * isyeri hesabi yoksa apartmanda online odeme o hesap acilana kadar kapali gorunur.
 */
export function ProviderDialog({ apartment, onClose }: Props) {
  const settings = usePaymentSettings(apartment?.apartmentId ?? null);
  const update = useUpdatePaymentSettings();
  const [value, setValue] = useState(DEFAULT_PROVIDER_OPTION);

  useEffect(() => {
    if (settings.data) setValue(settings.data.paymentProvider ?? DEFAULT_PROVIDER_OPTION);
  }, [settings.data]);
  useEffect(() => {
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [apartment?.apartmentId]);

  const save = async () => {
    if (!apartment || !settings.data) return;
    try {
      await update.mutateAsync({
        apartmentId: apartment.apartmentId,
        paymentProvider: toProviderSetting(value),
        expectedVersion: settings.data.version,
      });
      onClose();
    } catch (err) {
      // 409: baska biri degistirdi; guncel surum okunur, kullanici tekrar kaydeder.
      if (err instanceof ApiError && err.status === 409) void settings.refetch();
    }
  };

  const s = settings.data;
  const unchanged = s ? (s.paymentProvider ?? DEFAULT_PROVIDER_OPTION) === value : true;

  return (
    <Dialog open={apartment !== null} onClose={onClose} title="Ödeme sağlayıcısı">
      <div className="flex flex-col gap-4">
        <p className="text-small text-muted">
          <strong className="text-text">{apartment?.name}</strong> için sakin ödemelerinin alınacağı sağlayıcı.
        </p>
        {settings.isPending ? (
          <Skeleton className="h-10 w-full" />
        ) : settings.isError ? (
          <Alert tone="danger">{errorMessage(settings.error)}</Alert>
        ) : (
          <>
            <FormField label="Sağlayıcı" hint={`Şu an kullanılan: ${providerLabel(s?.effectiveProvider)}`}>
              <Select value={value} onChange={(e) => setValue(e.target.value)}>
                <option value={DEFAULT_PROVIDER_OPTION}>Ortam varsayılanı ({providerLabel(s?.defaultProvider)})</option>
                {s?.available.map((p) => (
                  <option key={p.name} value={p.name}>
                    {providerLabel(p.name)}
                    {p.sandbox ? ' (test)' : ''}
                  </option>
                ))}
              </Select>
            </FormField>
            <Alert>
              Başlamış ödemeler kendi sağlayıcısında tamamlanır. Seçilen sağlayıcıda bu apartmanın ödeme hesabı yoksa, hesap açılana kadar sakinler online
              ödeme yapamaz.
            </Alert>
          </>
        )}
        {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={update.isPending} disabled={!s || unchanged} onClick={() => void save()}>
            Kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
