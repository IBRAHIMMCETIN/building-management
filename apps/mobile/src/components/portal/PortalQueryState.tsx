import { errorMessage } from '@bm/shared/api/errors';
import { isNoMembership, unitChoicesFrom } from '@bm/shared/api/portal';
import { Building2, House } from '@/components/icons';
import { useEffect } from 'react';
import { View } from 'react-native';
import { Alert, AppText, Button, Card, EmptyState, ListRow } from '@/components/ui';
import { usePortalUnit } from '@/context/PortalUnitProvider';
import { space } from '@/theme/tokens';

type Props = { error: unknown; onRetry: () => void };

/**
 * Portal sorgusunun hata durumlari (web: components/portal/PortalQueryState.tsx):
 *  - Birden fazla daire  -> daire secici
 *  - Kayitli secim artik gecersiz (403 + secili daire) -> secim sifirlanir, otomatik yeniden denenir
 *  - Aktif daire yok     -> bilgilendirici bos durum
 *  - Diger               -> hata + tekrar dene
 */
export function PortalQueryState({ error, onRetry }: Props) {
  const { unitId, selectUnit } = usePortalUnit();
  const choices = unitChoicesFrom(error);
  const staleSelection = isNoMembership(error) && unitId !== undefined;

  useEffect(() => {
    if (staleSelection) selectUnit(undefined);
  }, [staleSelection, selectUnit]);

  if (staleSelection) return null;

  if (choices) {
    return (
      <Card>
        <View style={{ gap: space(1) }}>
          <AppText variant="heading" weight="semibold" accessibilityRole="header">
            Daire seçin
          </AppText>
          <AppText variant="small" tone="muted">
            Bu apartmanda birden fazla daireniz var. Hangisinin hesabını görmek istersiniz?
          </AppText>
        </View>
        {choices.map((c) => (
          <ListRow key={c.unitId} icon={House} title={c.label} subtitle={c.relationLabel} onPress={() => selectUnit(c.unitId)} />
        ))}
      </Card>
    );
  }

  if (isNoMembership(error)) {
    return (
      <EmptyState
        icon={Building2}
        title="Henüz bir daireye atanmadınız"
        description="Borç ve ödeme bilgileriniz, apartman yöneticiniz sizi dairenize malik veya kiracı olarak eklediğinde burada görünecek."
      />
    );
  }

  return (
    <Card>
      <Alert tone="danger">{errorMessage(error)}</Alert>
      <Button variant="secondary" label="Tekrar dene" onPress={onRetry} />
    </Card>
  );
}
