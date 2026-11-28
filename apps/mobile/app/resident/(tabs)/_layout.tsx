import { Tabs } from 'expo-router/js-tabs';
import { Ellipsis, House, Megaphone, Receipt, Wrench } from '@/components/icons';
import { StyleSheet, View } from 'react-native';
import { DevModeBadge, HeaderBrand } from '@/components/HeaderBrand';
import { UnitPicker } from '@/components/portal/UnitPicker';
import { tabBarOptions } from '@/navigation/options';
import { space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

function HeaderRight() {
  return (
    <View style={styles.right}>
      <DevModeBadge />
      <UnitPicker />
    </View>
  );
}

/**
 * Sakin sekmeleri (web: layouts/residentNav.ts alt sekme cubugu): Ana Sayfa, Borçlarım, Talepler,
 * Duyurular ve Diğer. Ust cubukta site adi ve (birden fazla daire varsa) daire secici.
 */
export default function ResidentTabs() {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        ...tabBarOptions(colors),
        headerTitle: () => <HeaderBrand />,
        headerTitleAlign: 'left',
        headerRight: () => <HeaderRight />,
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Ana Sayfa', tabBarIcon: ({ color, size }) => <House color={color} size={size} aria-hidden /> }} />
      <Tabs.Screen name="dues" options={{ title: 'Borçlarım', tabBarIcon: ({ color, size }) => <Receipt color={color} size={size} aria-hidden /> }} />
      <Tabs.Screen name="tickets" options={{ title: 'Talepler', tabBarIcon: ({ color, size }) => <Wrench color={color} size={size} aria-hidden /> }} />
      <Tabs.Screen name="announcements" options={{ title: 'Duyurular', tabBarIcon: ({ color, size }) => <Megaphone color={color} size={size} aria-hidden /> }} />
      <Tabs.Screen name="more" options={{ title: 'Diğer', tabBarIcon: ({ color, size }) => <Ellipsis color={color} size={size} aria-hidden /> }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  right: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingLeft: space(2) },
});
