import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { BrandMark, BrandWordmark } from '@/components/Brand';
import { AppText, Card, Screen } from '@/components/ui';
import { space } from '@/theme/tokens';

/** Giris ekranlari iskeleti (web: layouts/AuthLayout.tsx): logo, kelime marka, ortada kart. */
export function AuthLayout({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Screen edges="all">
        <View style={styles.brand}>
          <BrandMark size={64} />
          <BrandWordmark tagline />
        </View>
        <Card style={styles.card}>
          <View style={styles.head}>
            <AppText variant="heading" weight="semibold" accessibilityRole="header">
              {title}
            </AppText>
            {description && (
              <AppText variant="small" tone="muted">
                {description}
              </AppText>
            )}
          </View>
          {children}
        </Card>
      </Screen>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  brand: { alignItems: 'center', gap: space(2), paddingTop: space(6), paddingBottom: space(2) },
  card: { gap: space(5), width: '100%', maxWidth: 480, alignSelf: 'center' },
  head: { gap: space(1) },
});
