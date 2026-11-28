import { View } from 'react-native';
import { Alert, Button } from '@/components/ui';
import { space } from '@/theme/tokens';

/** Web onizlemesi: kamera ile okutma yalnizca telefonda / tablette; kisa kod elle yazilir. */
export function QrScanner({ onClose }: { onResult: (text: string) => void; onClose: () => void }) {
  return (
    <View style={{ gap: space(3) }}>
      <Alert tone="info">QR okutma bu web önizlemesinde yok; uygulamada arka kamerayla okutulur. Misafirin kısa kodunu aşağıya yazın.</Alert>
      <Button block variant="secondary" label="Kapat" onPress={onClose} />
    </View>
  );
}
