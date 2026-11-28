import { Eye, EyeOff } from '@/components/icons';
import { type ComponentRef, type Ref, useState } from 'react';
import { Pressable, StyleSheet, TextInput, type TextInputProps, View } from 'react-native';
import { MIN_TOUCH, radii, space, typeScale } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';
import { AppText } from './AppText';

export type TextFieldProps = Omit<TextInputProps, 'style'> & {
  label: string;
  error?: string;
  /** Sifre alani: goster/gizle dugmesi (web PasswordInput). */
  password?: boolean;
  /** Odak yonetimi (ornek: kayittan sonra siradaki sayac). */
  ref?: Ref<TextFieldHandle>;
};

/** Alanin odak / temizleme tutamaci (`ref`). */
export type TextFieldHandle = ComponentRef<typeof TextInput>;

/** Etiketli giris alani (web FormField + Input). Hata metni alanin altinda ve ekran okuyucuda. */
export function TextField({ label, error, password = false, editable = true, onFocus, onBlur, autoCapitalize, multiline, ref, ...props }: TextFieldProps) {
  const { colors } = useTheme();
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(false);
  const borderColor = error ? colors.danger : focused ? colors.accent : colors.borderStrong;

  return (
    <View style={styles.field}>
      <AppText variant="small" weight="medium">
        {label}
      </AppText>
      <View style={[styles.inputRow, { borderColor, backgroundColor: colors.surface }, !editable && { opacity: 0.6 }]}>
        <TextInput
          ref={ref}
          accessibilityLabel={label}
          accessibilityHint={error}
          aria-invalid={!!error}
          placeholderTextColor={colors.muted}
          autoCorrect={false}
          {...props}
          multiline={multiline}
          textAlignVertical={multiline ? 'top' : undefined}
          secureTextEntry={password && !visible}
          autoCapitalize={password ? 'none' : autoCapitalize}
          editable={editable}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[styles.input, typeScale.body, { color: colors.text }, multiline && styles.multiline]}
        />
        {password && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={visible ? 'Şifreyi gizle' : 'Şifreyi göster'}
            onPress={() => setVisible((v) => !v)}
            style={styles.toggle}
            hitSlop={6}
          >
            {visible ? <EyeOff size={20} color={colors.muted} aria-hidden /> : <Eye size={20} color={colors.muted} aria-hidden />}
          </Pressable>
        )}
      </View>
      {error && (
        <AppText variant="small" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </AppText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  field: { gap: space(1.5) },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: MIN_TOUCH + 4,
    borderRadius: radii.md,
    borderWidth: 1,
  },
  input: { flex: 1, paddingHorizontal: space(3), paddingVertical: space(2.5) },
  /** Cok satirli not / aciklama: en az uc satir. */
  multiline: { minHeight: space(22) },
  toggle: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
});
