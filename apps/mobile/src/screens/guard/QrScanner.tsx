import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, View } from 'react-native';
import { Flashlight, FlashlightOff, Settings } from '@/components/icons';
import { Alert, AppText, Button, Spinner } from '@/components/ui';
import { radii, space, withAlpha } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

/** Kamera izni reddinde gosterilen aciklama (izin istemi oncesi de ayni gerekce). */
export const CAMERA_REASON = 'Misafirin geçiş QR kodunu okutmak için kamera izni gerekiyor. Görüntü kaydedilmez; yalnızca QR kodu okunur.';

type Props = { onResult: (text: string) => void; onClose: () => void };

/**
 * Arka kamerayla QR okuma (expo-camera; web: pages/admin/gate/QrScanner.tsx). Ilk okunan degerde
 * tarama durur ve `onResult` cagrilir (kamera sonraki karelerde ayni kodu tekrar bildirir). Uygulama
 * arka plana gecince kamera kapanir, one gelince yeniden acilir; ekrandan cikinca (unmount) kapanir.
 * Izin verilmezse aciklama + ayarlar baglantisi; gorevli kisa kodu elle yazabilir. Gece icin fener.
 */
export function QrScanner({ onResult, onClose }: Props) {
  const { colors } = useTheme();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [active, setActive] = useState(AppState.currentState !== 'background');
  const done = useRef(false);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);

  if (!permission) return <Spinner label="Kamera izni kontrol ediliyor" />;

  if (!permission.granted) {
    const blocked = !permission.canAskAgain;
    return (
      <View style={styles.gap}>
        <Alert tone="warning">
          {blocked ? `Kamera izni kapalı. ${CAMERA_REASON} İzni telefonun Ayarlar > YÖNESİST > Kamera bölümünden açabilirsiniz.` : `Kamera izni gerekli. ${CAMERA_REASON}`}
        </Alert>
        {blocked ? (
          <Button size="large" block variant="secondary" icon={Settings} label="Ayarları aç" onPress={() => void Linking.openSettings()} />
        ) : (
          <Button size="large" block label="Kameraya izin ver" onPress={() => void requestPermission()} />
        )}
        <Button block variant="ghost" label="Vazgeç, kısa kodu yazacağım" onPress={onClose} />
      </View>
    );
  }

  const handle = (r: BarcodeScanningResult) => {
    if (done.current || !r.data) return;
    done.current = true;
    onResult(r.data);
  };

  return (
    <View style={styles.gap}>
      <View style={[styles.frame, { borderColor: colors.borderStrong, backgroundColor: colors.surfaceMuted }]}>
        {active && (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={handle}
            accessibilityLabel="Kamera görüntüsü"
          />
        )}
        <View pointerEvents="none" style={styles.target} aria-hidden />
        <View pointerEvents="none" style={[styles.caption, { backgroundColor: colors.scrim }]}>
          <AppText variant="small" weight="medium" style={styles.captionText} accessibilityLiveRegion="polite">
            QR kodu çerçeveye getirin
          </AppText>
        </View>
      </View>
      <View style={styles.row}>
        <View style={styles.flex}>
          <Button
            size="large"
            block
            variant="secondary"
            icon={torch ? FlashlightOff : Flashlight}
            label={torch ? 'Feneri kapat' : 'Feneri aç'}
            accessibilityState={{ selected: torch }}
            onPress={() => setTorch((t) => !t)}
          />
        </View>
        <View style={styles.flex}>
          <Button size="large" block variant="secondary" label="Kamerayı kapat" onPress={onClose} />
        </View>
      </View>
    </View>
  );
}

/** Kamera goruntusunun ustu: tema (acik / koyu) degil, canli goruntu zemin (web: `text-white`, `border-white/80`). */
const ON_CAMERA = '#ffffff';
const ON_CAMERA_FRAME = withAlpha(ON_CAMERA, 0.8);

const styles = StyleSheet.create({
  gap: { gap: space(3) },
  row: { flexDirection: 'row', gap: space(2) },
  flex: { flex: 1 },
  frame: { width: '100%', aspectRatio: 1, maxHeight: 420, alignSelf: 'center', overflow: 'hidden', borderRadius: radii.xl, borderWidth: StyleSheet.hairlineWidth * 2 },
  target: { position: 'absolute', top: space(8), bottom: space(8), left: space(8), right: space(8), borderRadius: radii.lg, borderWidth: space(1), borderColor: ON_CAMERA_FRAME },
  caption: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingVertical: space(2), alignItems: 'center' },
  captionText: { color: ON_CAMERA },
});
