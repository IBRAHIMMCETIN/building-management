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
 * klavye acilinca yukari itilir. Karartmaya veya geri tusuna basinca kapanir.
 */
export function Sheet({ open, title, onClose, children }: Props) {
  const { colors } = useTheme();
  return (
    <Modal visible={open} transparent animationType="fade" onRequestClose={onClose}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
        <Pressable accessibilityLabel="Kapat" style={[styles.scrim, { backgroundColor: colors.scrim }]} onPress={onClose}>
          <SafeAreaView edges={['bottom']} style={styles.sheetWrap}>
            <Pressable style={[styles.sheet, { backgroundColor: colors.bg }]} onPress={(e) => e.stopPropagation()}>
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
            </Pressable>
          </SafeAreaView>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { flex: 1, justifyContent: 'flex-end' },
  sheetWrap: { width: '100%', maxHeight: '92%' },
  sheet: { borderTopLeftRadius: radii.xl, borderTopRightRadius: radii.xl, paddingTop: space(2), flexShrink: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: space(2), paddingLeft: space(4), paddingRight: space(2) },
  title: { flex: 1 },
  close: { width: MIN_TOUCH, height: MIN_TOUCH, borderRadius: radii.full, alignItems: 'center', justifyContent: 'center' },
  content: { padding: space(4), paddingTop: space(2), gap: space(4) },
});
