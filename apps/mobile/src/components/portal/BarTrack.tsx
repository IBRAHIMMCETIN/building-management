import { useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';
import Svg, { Line, Rect } from 'react-native-svg';
import { radii } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

export type BarSegment = { /** 0..1 */ fraction: number; color: string };

type Props = {
  /** Soldan saga dizilen dolgu parcalari (toplam en fazla 1). */
  segments: readonly BarSegment[];
  /** Karsilastirma cizgisi (ornek: bina ortalamasi), 0..1. */
  marker?: number;
  height?: number;
};

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

/**
 * Yatay cubuk (web: oylama sonuc cubugu, tuketim gecmisi, ortak / tuketim payi ayrimi). Cizim
 * react-native-svg ile; deger her zaman yanindaki metinde / kapsayicinin etiketinde verilir, cubuk
 * ekran okuyucudan gizlidir (web: aria-hidden). Renkler temadan (acik / koyu).
 */
export function BarTrack({ segments, marker, height = 8 }: Props) {
  const { colors } = useTheme();
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const r = Math.min(radii.full, height / 2);

  let x = 0;
  const parts = segments.map((s) => {
    const w = clamp(s.fraction) * width;
    const part = { x, w, color: s.color };
    x += w;
    return part;
  });
  const m = marker === undefined ? undefined : clamp(marker) * width;

  return (
    <View
      onLayout={onLayout}
      style={{ height: marker === undefined ? height : height + 4, justifyContent: 'center' }}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {width > 0 && (
        <Svg width={width} height={marker === undefined ? height : height + 4}>
          <Rect x={0} y={marker === undefined ? 0 : 2} width={width} height={height} rx={r} fill={colors.surfaceMuted} />
          {parts.map((p, i) => (p.w > 0 ? <Rect key={i} x={p.x} y={marker === undefined ? 0 : 2} width={p.w} height={height} rx={r} fill={p.color} /> : null))}
          {m !== undefined && <Line x1={m} x2={m} y1={0} y2={height + 4} stroke={colors.textSecondary} strokeWidth={2} />}
        </Svg>
      )}
    </View>
  );
}
