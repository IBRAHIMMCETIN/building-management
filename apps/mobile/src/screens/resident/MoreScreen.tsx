import { useRouter } from 'expo-router';
import { UserRound } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { AppText, ListRow, Screen } from '@/components/ui';
import { useSiteFeatures } from '@/context/SiteFeaturesProvider';
import { useIsActiveOwner } from '@/hooks/useContexts';
import { residentMoreFor } from '@/lib/nav';
import { space } from '@/theme/tokens';

/** "Diğer" sekmesi: web menusundeki kalan sayfalar (web: residentNav "Diğer" cekmecesi) + Hesabım. */
export function MoreScreen() {
  const router = useRouter();
  // Genel Kurul yalnizca malik uyeligi olana (kiraciya listede gorunmez; API de 403 doner); site ozelligi
  // kapali ogeler de gorunmez (Adim 1).
  const { isEnabled } = useSiteFeatures();
  const items = residentMoreFor(useIsActiveOwner(), undefined, isEnabled);

  return (
    <Screen title="Diğer">
      <View style={styles.list}>
        {items.map((item) => (
          <ListRow
            key={item.key}
            icon={item.icon}
            title={item.label}
            subtitle={item.description}
            onPress={() => router.push(item.route ?? { pathname: '/resident/web/[feature]', params: { feature: item.key } })}
          />
        ))}
      </View>
      <AppText variant="small" weight="semibold" tone="muted" accessibilityRole="header">
        Hesap
      </AppText>
      <ListRow icon={UserRound} title="Hesabım" subtitle="Profil, bildirimler, bağlam değiştirme, çıkış" onPress={() => router.push('/resident/account')} />
    </Screen>
  );
}

const styles = StyleSheet.create({ list: { gap: space(2) } });
