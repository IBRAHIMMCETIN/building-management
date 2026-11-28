import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X } from '@/components/icons';
import { AppText } from '@/components/ui';
import { MIN_TOUCH, radii, space } from '@/theme/tokens';
import { useTheme } from '@/theme/useTheme';

type Props = {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
};

/**
 * Alttan acilan pencere (web: components/ui/Dialog.tsx). Cerceve ust cubuk daire secicisiyle ayni
 * (UnitPicker): karartma, tema zemini, ust koseler yuvarlak; baslik + "Kapat", icerik kaydirilir,
 * klavye acilinca yukari itilir.
 *
 * Erisilebilirlik: karartma pencerenin KARDESIDIR (ebeveyni degil) ve ekran okuyucudan gizlidir;
 * RN'de Pressable varsayilan olarak tek bir erisilebilir oge oldugundan ebeveyn karartma tum
 * pencereyi tek bir "Kapat" ogesine cevirirdi. Pencere `accessibilityViewIsModal` (VoiceOver arkadaki
 * ekrani okumaz), iOS kacis hareketi ve Android geri tusu kapatir; gorunen "Kapat" dugmesi basliktadir.
 */
export function Sheet({ open, title, onClose, children }: Props) {
  const { colors } = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.fill}>
        <Pressable
          accessible={false}
          importantForAccessibility="no-hide-descendants"
          accessibilityElementsHidden
          onPress={onClose}
          style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]}
        />
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} pointerEvents="box-none" style={styles.bottom}>
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <View accessibilityViewIsModal onAccessibilityEscape={onClose} style={[styles.sheet, { backgroundColor: colors.bg }]}>
              <View style={styles.header}>
                <AppText variant="heading" weight="semibold" accessibilityRole="header" style={styles.title}>
                  {title}
                </AppText>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Kapat"
                  onPress={onClose}
                  style={({ pressed }) => [styles.close, pressed && { backgroundColor: colors.surfaceMuted }]}
                >
                  <X size={20} color={colors.muted} aria-hidden />
                </Pressable>
              </View>
              <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
                {children}
              </ScrollView>
            </View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  bottom: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%', maxHeight: '92%' },
  sheet: { borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, paddingTop: space(2), flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingLeft: space(4), paddingRight: space(2) },
  title: { flex: 1 },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space(4), paddingTop: space(2), gap: space(4) },
});
