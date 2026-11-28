import { errorMessage } from '@bm/shared/api/errors';
import { newPasswordFormSchema } from '@bm/shared/auth/forms';
import type { SignInStep } from '@bm/shared/auth/session';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowLeft } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Button, TextField } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useAuthFlow } from '@/context/AuthFlowProvider';
import { routeForStep } from '@/lib/auth/flow';
import { fieldErrors } from '@/lib/forms';
import { space } from '@/theme/tokens';
import { AuthLayout } from './AuthLayout';
import { PasswordRules } from './PasswordRules';

/** Gecici sifreyle ilk giris (NEW_PASSWORD_REQUIRED): kendi sifresini belirler (web: NewPasswordForm). */
export function NewPasswordScreen() {
  const auth = useAuth();
  const router = useRouter();
  const flow = useAuthFlow();
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const confirm = useMutation({
    mutationFn: auth.confirmNewPassword,
    onSuccess: (step: SignInStep) => {
      flow.dispatch({ type: 'step', step });
      const route = routeForStep(step);
      if (route) router.replace(route);
    },
  });

  const submit = () => {
    const parsed = newPasswordFormSchema.safeParse({ newPassword, confirmPassword });
    setErrors(fieldErrors(parsed));
    if (parsed.success) confirm.mutate(parsed.data.newPassword);
  };

  return (
    <AuthLayout title="Yeni şifre belirleyin" description="Geçici şifrenizle ilk kez giriş yaptınız. Devam etmek için kendi şifrenizi belirleyin.">
      {flow.state.email ? (
        <AppText variant="small" tone="muted">
          {flow.state.email}
        </AppText>
      ) : null}
      {confirm.isError && <Alert tone="danger">{errorMessage(confirm.error)}</Alert>}
      <View style={styles.form}>
        <TextField label="Yeni şifre" value={newPassword} onChangeText={setNewPassword} error={errors.newPassword} password autoComplete="new-password" textContentType="newPassword" />
        <PasswordRules value={newPassword} />
        <TextField
          label="Yeni şifre (tekrar)"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          error={errors.confirmPassword}
          password
          autoComplete="new-password"
          textContentType="newPassword"
          onSubmitEditing={submit}
        />
        <Button label="Şifreyi kaydet ve devam et" block loading={confirm.isPending} onPress={submit} />
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
