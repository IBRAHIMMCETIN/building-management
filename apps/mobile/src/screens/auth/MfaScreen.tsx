import { errorMessage } from '@bm/shared/api/errors';
import { totpSchema } from '@bm/shared/auth/forms';
import type { SignInStep } from '@bm/shared/auth/session';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowLeft, ShieldCheck } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Button, TextField } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useAuthFlow } from '@/context/AuthFlowProvider';
import { routeForStep } from '@/lib/auth/flow';
import { fieldErrors } from '@/lib/forms';
import { space } from '@/theme/tokens';
import { AuthLayout } from './AuthLayout';

/** Iki adimli dogrulama (TOTP) adimi (web: pages/auth/TotpForm.tsx). */
export function MfaScreen() {
  const auth = useAuth();
  const router = useRouter();
  const flow = useAuthFlow();
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const totp = useMutation({
    mutationFn: auth.confirmTotp,
    onSuccess: (step: SignInStep) => {
      flow.dispatch({ type: 'step', step });
      const route = routeForStep(step);
      if (route) router.replace(route);
    },
  });

  const submit = () => {
    const parsed = totpSchema.safeParse({ code });
    setErrors(fieldErrors(parsed));
    if (parsed.success) totp.mutate(parsed.data.code);
  };

  return (
    <AuthLayout title="İki adımlı doğrulama" description="Doğrulayıcı uygulamanızdaki 6 haneli kodu girin.">
      {flow.state.email ? (
        <AppText variant="small" tone="muted">
          {flow.state.email}
        </AppText>
      ) : null}
      {totp.isError && <Alert tone="danger">{errorMessage(totp.error)}</Alert>}
      <View style={styles.form}>
        <TextField
          label="Doğrulama kodu"
          value={code}
          onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
          error={errors.code}
          keyboardType="number-pad"
          autoComplete="one-time-code"
          textContentType="oneTimeCode"
          maxLength={6}
          autoFocus
          onSubmitEditing={submit}
        />
        <Button label="Doğrula" icon={ShieldCheck} block loading={totp.isPending} onPress={submit} />
      </View>
      <Button
        variant="ghost"
        icon={ArrowLeft}
        label="Farklı hesapla giriş yap"
        onPress={() => {
          flow.dispatch({ type: 'restart' });
          router.replace('/login');
        }}
      />
    </AuthLayout>
  );
}

const styles = StyleSheet.create({ form: { gap: space(4) } });
