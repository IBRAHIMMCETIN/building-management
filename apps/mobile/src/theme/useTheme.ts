import { useColorScheme } from 'react-native';
import { type Palette, palettes } from './tokens';

export type AppTheme = { scheme: 'light' | 'dark'; colors: Palette };

/** Sistem acik/koyu temasina gore palet (web: prefers-color-scheme). */
export function useTheme(): AppTheme {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  return { scheme, colors: palettes[scheme] };
}
