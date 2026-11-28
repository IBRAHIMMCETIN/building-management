import { BRAND_NAME, BRAND_PARTS, BRAND_TAGLINE } from '@bm/shared/brand';
import { Image, StyleSheet, View } from 'react-native';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './ui/AppText';

const mark = require('../../assets/mark.png') as number;
const markDark = require('../../assets/mark-dark.png') as number;

/** Logo simgesi (web BrandMark): koyu temada lacivert kisimlari acik renkli surum. */
export function BrandMark({ size = 28, decorative = true }: { size?: number; decorative?: boolean }) {
  const { scheme } = useTheme();
  return (
    <Image
      source={scheme === 'dark' ? markDark : mark}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessible={!decorative}
      accessibilityLabel={decorative ? undefined : BRAND_NAME}
      accessibilityIgnoresInvertColors
    />
  );
}

/** Kelime marka: "YÖNE" + turuncu "SİST", istege bagli alt satir (web BrandWordmark). */
export function BrandWordmark({ tagline = false }: { tagline?: boolean }) {
  const { colors } = useTheme();
  return (
    <View style={styles.wordmark} accessible accessibilityRole="header" accessibilityLabel={tagline ? `${BRAND_NAME}, ${BRAND_TAGLINE}` : BRAND_NAME}>
      <AppText variant="heading" weight="extrabold" style={[styles.word, { color: colors.brandInk }]}>
        {BRAND_PARTS[0]}
        <AppText variant="heading" weight="extrabold" tone="brandOrange" style={styles.word}>
          {BRAND_PARTS[1]}
        </AppText>
      </AppText>
      {tagline && (
        <AppText variant="caption" tone="muted" weight="medium" style={styles.tagline}>
          {BRAND_TAGLINE.toLocaleUpperCase('tr-TR')}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wordmark: { alignItems: 'center', gap: 2 },
  word: { letterSpacing: 1 },
  tagline: { letterSpacing: 0.6, textAlign: 'center' },
});
