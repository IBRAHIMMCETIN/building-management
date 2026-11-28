import type { LucideIcon } from 'lucide-react-native';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';
import { Card } from './Card';

/** Yer tutucu kutu (web Skeleton). Ekran okuyucudan gizlidir; kapsayici "yukleniyor" der. */
export function Skeleton({ height = 16, width = '100%', style }: { height?: number; width?: ViewStyle['width']; style?: ViewStyle }) {
  const { colors } = useTheme();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ height, width, borderRadius: radii.md, backgroundColor: colors.surfaceMuted }, style]}
    />
  );
}

/** Yukleniyor durumu: kapsayici etiketli (web: role="status" aria-label="... yükleniyor"). */
export function LoadingBlock({ label, lines = 3 }: { label: string; lines?: number }) {
  return (
    <Card accessible accessibilityRole="progressbar" accessibilityLabel={label}>
      <Skeleton height={20} width="40%" />
      <Skeleton height={32} width="60%" />
      {Array.from({ length: Math.max(0, lines - 2) }, (_, i) => (
        <Skeleton key={i} height={14} width="80%" />
      ))}
    </Card>
  );
}

export function Spinner({ label }: { label: string }) {
  const { colors } = useTheme();
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel={label} style={styles.spinner}>
      <ActivityIndicator color={colors.accent} />
      <AppText variant="small" tone="muted">
        {label}
      </AppText>
    </View>
  );
}

/** Bos durum (web: ortalanmis ikon + baslik + aciklama karti). */
export function EmptyState({ icon: Icon, title, description }: { icon: LucideIcon; title: string; description?: string }) {
  const { colors } = useTheme();
  return (
    <Card style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.surfaceMuted }]}>
        <Icon size={24} color={colors.accent} aria-hidden />
      </View>
      <AppText variant="body" weight="semibold" style={styles.center}>
        {title}
      </AppText>
      {description && (
        <AppText variant="small" tone="muted" style={styles.center}>
          {description}
        </AppText>
      )}
    </Card>
  );
}

const styles = StyleSheet.create({
  spinner: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingVertical: space(3) },
  empty: { alignItems: 'center', paddingVertical: space(8) },
  emptyIcon: { width: 48, height: 48, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});
