import { Tabs } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { UserRound } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { DevModeBadge, HeaderBrand } from '@/components/HeaderBrand';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { tabBarOptions, tabOptions } from './options';

export type FieldTab = { name: string; title: string; icon: LucideIcon };

/**
 * Saha rolleri (guvenlik, bina gorevlisi): rolun isleri (ilki `index.tsx`) ve en sonda Hesabım
 * (`account.tsx`). Ayrinti ekranlari sekmelerin ustundeki yigindadir (`app/<rol>/_layout.tsx`).
 */
export function FieldRoleTabs({ tabs }: { tabs: readonly FieldTab[] }) {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        ...tabBarOptions(colors),
        headerTitle: () => <HeaderBrand />,
        headerTitleAlign: 'left',
        headerRight: () => (
          <View style={styles.right}>
            <DevModeBadge />
          </View>
        ),
      }}
    >
      {tabs.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={tabOptions(t.title, t.icon)} />
      ))}
      <Tabs.Screen name="account" options={tabOptions('Hesabım', UserRound)} />
    </Tabs>
  );
}

const styles = StyleSheet.create({ right: { paddingRight: space(3) } });
