import { errorMessage } from '@bm/shared/api/errors';
import { forgotConfirmSchema, forgotRequestSchema } from '@bm/shared/auth/forms';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { ArrowLeft } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, Button, TextField } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useAuthFlow } from '@/context/AuthFlowProvider';
import { fieldErrors } from '@/lib/forms';
import { space } from '@/theme/tokens';
import { AuthLayout } from './AuthLayout';
import { PasswordRules } from './PasswordRules';

/** Sifremi unuttum: kod iste, kod + yeni sifreyle onayla (web: pages/auth/ForgotPasswordPage.tsx). */
export function ForgotPasswordScreen() {
  const { requestPasswordReset, confirmPasswordReset } = useAuth();
  const router = useRouter();
  const flow = useAuthFlow();
  const [email, setEmail] = useState(flow.state.email);
  const [sentTo, setSentTo] = useState<{ email: string; destination?: string } | null>(null);
  const [code, setCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  const request = useMutation({
    mutationFn: (target: string) => requestPasswordReset(target).then((r) => ({ email: target, ...r })),
    onSuccess: (result) => {
      setSentTo(result);
      setCode('');
      setNewPassword('');
      setConfirmPassword('');
    },
  });

  const confirm = useMutation({
    mutationFn: (values: { code: string; newPassword: string }) => confirmPasswordReset({ email: sentTo?.email ?? '', ...values }),
    onSuccess: () => {
      flow.dispatch({ type: 'passwordReset', email: sentTo?.email ?? '' });
      router.replace('/login');
    },
  });

  const submitRequest = () => {
    const parsed = forgotRequestSchema.safeParse({ email });
    setErrors(fieldErrors(parsed));
    if (parsed.success) request.mutate(parsed.data.email);
  };

  const submitConfirm = () => {
    const parsed = forgotConfirmSchema.safeParse({ code, newPassword, confirmPassword });
    setErrors(fieldErrors(parsed));
    if (parsed.success) confirm.mutate({ code: parsed.data.code, newPassword: parsed.data.newPassword });
  };

  return (
    <AuthLayout
      title="Şifremi unuttum"
      description={sentTo ? 'E-postanıza gelen kodu ve yeni şifrenizi girin.' : 'Hesabınıza kayıtlı e-posta adresine bir doğrulama kodu göndereceğiz.'}
    >
      {!sentTo ? (
        <View style={styles.form}>
          {flow.state.resetNotice && <Alert>{flow.state.resetNotice}</Alert>}
          {request.isError && <Alert tone="danger">{errorMessage(request.error)}</Alert>}
          <TextField
            label="E-posta"
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            keyboardType="email-address"
            autoCapitalize="none"
            autoComplete="email"
            textContentType="username"
            onSubmitEditing={submitRequest}
          />
          <Button label="Kod gönder" block loading={request.isPending} onPress={submitRequest} />
        </View>
      ) : (
        <View style={styles.form}>
          {/* Hesap yoksa da ayni mesaj gosterilir (kullanici varligi sizdirilmaz). */}
          <Alert tone="success">{`Hesap mevcutsa kod ${sentTo.destination ?? sentTo.email} adresine gönderildi.`}</Alert>
          {confirm.isError && <Alert tone="danger">{errorMessage(confirm.error)}</Alert>}
          <TextField
            label="Doğrulama kodu"
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))}
            error={errors.code}
            keyboardType="number-pad"
            autoComplete="one-time-code"
            textContentType="oneTimeCode"
            maxLength={6}
          />
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
            onSubmitEditing={submitConfirm}
          />
          <Button label="Şifreyi güncelle" block loading={confirm.isPending} onPress={submitConfirm} />
          <Button variant="ghost" label="Kodu tekrar gönder" loading={request.isPending} onPress={() => request.mutate(sentTo.email)} />
        </View>
      )}
      <Button
        variant="ghost"
        icon={ArrowLeft}
        label="Girişe dön"
        onPress={() => {
          flow.dispatch({ type: 'clearNotice' });
          if (router.canGoBack()) router.back();
          else router.replace('/login');
        }}
      />
    </AuthLayout>
  );
}

const styles = StyleSheet.create({ form: { gap: space(4) } });
