import { Clock, type LucideIcon } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { WebLinkButton } from '@/components/WebLinkButton';
import { AppText, Badge, Card, Screen } from '@/components/ui';
import { radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Props = {
  title: string;
  description: string;
  icon: LucideIcon;
  /** Web uygulamasindaki karsilik (EXPO_PUBLIC_WEB_URL'e eklenir). */
  webPath: string;
};

/** Mobilde henuz olmayan ekran: "Yakında — şimdilik web'den" ve web'de acma baglantisi. */
export function ComingSoonScreen({ title, description, icon: Icon, webPath }: Props) {
  const { colors } = useTheme();
  return (
    <Screen>
      <Card style={styles.card}>
        <View style={[styles.icon, { backgroundColor: colors.surfaceMuted }]}>
          <Icon size={28} color={colors.accent} aria-hidden />
        </View>
        <AppText variant="heading" weight="semibold" accessibilityRole="header" style={styles.center}>
          {title}
        </AppText>
        <View>
          <Badge tone="accent" icon={Clock} label="Yakında — şimdilik web'den" />
        </View>
        <AppText variant="small" tone="muted" style={styles.center}>
          {description}
        </AppText>
        <AppText variant="small" tone="secondary" style={styles.center}>
          Bu ekran mobil uygulamaya sonraki sürümde gelecek. O zamana kadar aynı hesapla web uygulamasından kullanabilirsiniz.
        </AppText>
        <WebLinkButton path={webPath} label="Web'de aç" align="center" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  card: { alignItems: 'center', paddingVertical: space(8) },
  icon: { width: 56, height: 56, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});
