import { create } from 'qrcode/lib/core/qrcode';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import { radii, space } from '@/theme/tokens';

/**
 * QR kodu, yerel olarak react-native-svg ile cizilir (web: hooks/useQrDataUrl.ts, ayni `qrcode`
 * kutuphanesi ve hata duzeltme seviyesi M). Yalnizca kodlama cekirdegi kullanilir (tuval / dosya
 * cizicileri pakete girmez). Okutulabilmesi icin temadan bagimsiz beyaz zemin + siyah modul.
 */

/** Okuyucularin bekledigi sabit renkler (koyu temada da tersine cevrilmez). */
const QR_LIGHT = '#ffffff';
const QR_DARK = '#000000';
/** Sessiz bolge (modul). */
const MARGIN = 2;

export function QrCode({ value, size = 240, label = 'Geçiş QR kodu' }: { value: string; size?: number; label?: string }) {
  const { path, count } = useMemo(() => {
    const qr = create(value, { errorCorrectionLevel: 'M' });
    const n = qr.modules.size;
    const d: string[] = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) if (qr.modules.get(y, x)) d.push(`M${x + MARGIN} ${y + MARGIN}h1v1h-1z`);
    }
    return { path: d.join(''), count: n + MARGIN * 2 };
  }, [value]);

  return (
    <View style={styles.frame} accessible accessibilityRole="image" accessibilityLabel={label}>
      <Svg width={size} height={size} viewBox={`0 0 ${count} ${count}`}>
        <Rect x={0} y={0} width={count} height={count} fill={QR_LIGHT} />
        <Path d={path} fill={QR_DARK} />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignSelf: 'center', backgroundColor: QR_LIGHT, borderRadius: radii.lg, padding: space(2) },
});
