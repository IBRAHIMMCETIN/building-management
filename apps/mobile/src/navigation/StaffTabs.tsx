import { Tabs } from 'expo-router/js-tabs';
import type { LucideIcon } from 'lucide-react-native';
import { UserRound } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { DevModeBadge, HeaderBrand } from '@/components/HeaderBrand';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { tabBarOptions, tabOptions } from './options';

/**
 * Saha rolleri (guvenlik, bina gorevlisi) icin iki sekme: rolun ana isi (M3'te gelecek ekran) ve
 * Hesabım. Ana is sekmesinin dosyasi `index.tsx`, Hesabım `account.tsx`.
 */
export function FieldRoleTabs({ mainTitle, mainIcon }: { mainTitle: string; mainIcon: LucideIcon }) {
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
      <Tabs.Screen name="index" options={tabOptions(mainTitle, mainIcon)} />
      <Tabs.Screen name="account" options={tabOptions('Hesabım', UserRound)} />
    </Tabs>
  );
}

const styles = StyleSheet.create({ right: { paddingRight: space(3) } });
