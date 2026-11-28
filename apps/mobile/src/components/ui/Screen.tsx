import type { ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

type Props = {
  children: ReactNode;
  /** Ekran basligi (ust cubukta baslik yoksa veya buyuk baslik isteniyorsa). */
  title?: string;
  /** Asagi cekip yenileme. */
  refreshing?: boolean;
  onRefresh?: () => void;
  /** Ust cubugu olmayan ekranlar (giris): ust guvenli alan da birakilir. */
  edges?: 'all' | 'bottom' | 'none';
  /** Kaydirma yerine sabit icerik (listeyi kendisi kaydiran ekranlar). */
  scroll?: boolean;
};

/** Ekran iskeleti: tema zemini, guvenli alanlar, 16 pt kenar boslugu, istege bagli asagi cek-yenile. */
export function Screen({ children, title, refreshing = false, onRefresh, edges = 'bottom', scroll = true }: Props) {
  const { colors } = useTheme();
  const safeEdges = edges === 'all' ? (['top', 'bottom', 'left', 'right'] as const) : edges === 'bottom' ? (['bottom', 'left', 'right'] as const) : ([] as const);
  const heading = title ? (
    <AppText variant="title" weight="bold" accessibilityRole="header">
      {title}
    </AppText>
  ) : null;

  return (
    <SafeAreaView edges={safeEdges} style={[styles.root, { backgroundColor: colors.bg }]}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} colors={[colors.accent]} /> : undefined}
        >
          {heading}
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.content, styles.fill]}>
          {heading}
          {children}
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: space(4), gap: space(4), paddingBottom: space(8) },
  fill: { flex: 1 },
});
