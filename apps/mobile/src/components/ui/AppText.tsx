import { Text, type TextProps, type TextStyle } from 'react-native';
import { typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

export type TextVariant = keyof typeof typeScale;
export type TextTone = 'text' | 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger' | 'onPrimary' | 'brandOrange';
type Weight = 'regular' | 'medium' | 'semibold' | 'bold' | 'extrabold';

const WEIGHTS: Record<Weight, TextStyle['fontWeight']> = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
};

export type AppTextProps = TextProps & {
  variant?: TextVariant;
  tone?: TextTone;
  weight?: Weight;
  /** Tutar sutunlari: rakamlar ayni genislikte (web: tabular-nums). */
  tabular?: boolean;
  strike?: boolean;
};

/** Tek metin bileseni: tip olcegi ve renkler temadan (web: text-small / text-heading / text-title). */
export function AppText({ variant = 'body', tone = 'text', weight = 'regular', tabular, strike, style, ...props }: AppTextProps) {
  const { colors } = useTheme();
  const color = {
    text: colors.text,
    secondary: colors.textSecondary,
    muted: colors.muted,
    accent: colors.accent,
    success: colors.success,
    warning: colors.warning,
    danger: colors.danger,
    onPrimary: colors.onPrimary,
    brandOrange: colors.brandOrange,
  }[tone];
  return (
    <Text
      maxFontSizeMultiplier={1.6}
      style={[
        typeScale[variant],
        { color, fontWeight: WEIGHTS[weight] },
        tabular && { fontVariant: ['tabular-nums'] },
        strike && { textDecorationLine: 'line-through' },
        style,
      ]}
      {...props}
    />
  );
}
