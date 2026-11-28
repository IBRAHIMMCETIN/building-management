import type { BottomTabBarButtonProps } from 'expo-router/js-tabs';
import type { Palette } from '@/theme/tokens';
import { typeScale } from '@/theme/tokens';
import { TabButton } from './TabButton';

/** Ortak ust cubuk gorunumu (yigin ve sekme ekranlari). */
export function headerOptions(colors: Palette) {
  return {
    headerStyle: { backgroundColor: colors.surface },
    headerTintColor: colors.text,
    headerTitleStyle: { fontWeight: '600' as const, fontSize: 17 },
    headerShadowVisible: true,
    headerBackTitle: 'Geri',
  };
}

/** Alt sekme cubugu (web ResidentLayout alt sekmeleri): aktif turkuaz, etiketler okunur kalir. */
export function tabBarOptions(colors: Palette) {
  return {
    ...headerOptions(colors),
    tabBarActiveTintColor: colors.accent,
    tabBarInactiveTintColor: colors.muted,
    tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
    tabBarLabelStyle: { fontSize: typeScale.caption.fontSize, fontWeight: '500' as const },
    tabBarButton: (props: BottomTabBarButtonProps) => <TabButton {...props} />,
    sceneStyle: { backgroundColor: colors.bg },
  };
}
