import type { BottomTabBarButtonProps } from 'expo-router/js-tabs';
import { Platform, Pressable } from 'react-native';
import { MIN_TOUCH } from '@/theme/tokens';

/**
 * Alt sekme dugmesi: ekran okuyucuya "sekme" rolu ve secili durumu acikca verilir. react-navigation'in
 * varsayilan dugmesi web'de (react-native-web) rolsuz bir ogeye donusuyordu. iOS'ta VoiceOver `tab`
 * rolunu tutarsiz okudugu icin (react-navigation ile ayni karar) `button` + secili durumu kullanilir.
 */
export function TabButton({ children, style, onPress, onLongPress, testID, 'aria-label': label, 'aria-selected': selected }: BottomTabBarButtonProps) {
  const role = Platform.OS === 'ios' ? 'button' : 'tab';
  return (
    <Pressable
      accessibilityRole={role}
      role={role}
      accessibilityLabel={label}
      accessibilityState={{ selected: !!selected }}
      aria-selected={!!selected}
      onPress={onPress}
      onLongPress={onLongPress}
      testID={testID}
      style={[{ minHeight: MIN_TOUCH }, style]}
    >
      {children}
    </Pressable>
  );
}
