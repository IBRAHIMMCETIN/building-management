import { errorMessage } from '@bm/shared/api/errors';
import { StyleSheet, View } from 'react-native';
import { Alert, Button } from '@/components/ui';
import { space } from '@/theme/tokens';

/**
 * Veri ekrandayken arka plan yenilemesi (asagi cek, uygulama one gelince, oy / soru sonrasi) hata
 * verirse: tam hata durumu yerine satir ici uyari + tekrar dene. Ekrandaki veri ve yarim kalan
 * girisler (secim, soru taslagi) korunur. Veri hic yoksa ekran tam hata durumunu (PortalQueryState) gosterir.
 */
export function RefetchErrorBanner({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <View style={styles.box}>
      <Alert tone="warning">{`Güncel bilgiler alınamadı; son yüklenen bilgiler gösteriliyor. ${errorMessage(error)}`}</Alert>
      <Button variant="secondary" label="Tekrar dene" onPress={onRetry} />
    </View>
  );
}

const styles = StyleSheet.create({ box: { gap: space(2) } });
