import { errorMessage } from '@bm/shared/api/errors';
import { loginSchema } from '@bm/shared/auth/forms';
import { MOCK_TEMP_PASSWORD } from '@bm/shared/auth/mockScenarios';
import type { SignInStep } from '@bm/shared/auth/session';
import { ROLE_LABELS } from '@bm/shared/roles';
import { useMutation } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { LogIn } from '@/components/icons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Alert, AppText, Button, TextField } from '@/components/ui';
import { useAuth } from '@/context/AuthProvider';
import { useAuthFlow } from '@/context/AuthFlowProvider';
import { routeForStep } from '@/lib/auth/flow';
import { fieldErrors } from '@/lib/forms';
import { useServices } from '@/services';
import { space } from '@/theme/tokens';
import { AuthLayout } from './AuthLayout';

const MOCK_ACCOUNTS = [
  { email: 'resident@dev.local', label: ROLE_LABELS.resident },
  { email: 'security_guard@dev.local', label: ROLE_LABELS.security_guard },
  { email: 'building_staff@dev.local', label: ROLE_LABELS.building_staff },
  { email: 'apartment_manager@dev.local', label: ROLE_LABELS.apartment_manager },
  { email: 'multi@dev.local', label: 'Çoklu apartman' },
];

/** Giris (web: pages/auth/LoginPage.tsx). Sonraki adimlar ayri ekranlar: yeni sifre, MFA. */
export function LoginScreen() {
  const auth = useAuth();
  const { env } = useServices();
  const router = useRouter();
  const flow = useAuthFlow();
  const [email, setEmail] = useState(flow.state.email);
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  // Oturum sunucu tarafindan (401) dusurulduyse sebebi bir kez goster.
  const [expired] = useState(() => auth.consumeExpiredNotice());
  const notice = flow.state.notice;

  const login = useMutation({
    mutationFn: auth.signIn,
    onSuccess: (step: SignInStep) => {
      flow.dispatch({ type: 'step', step });
      const route = routeForStep(step);
      if (route) router.push(route);
    },
  });

  const submit = (values: { email: string; password: string }) => {
    const parsed = loginSchema.safeParse(values);
    setErrors(fieldErrors(parsed));
    if (!parsed.success) return;
    flow.dispatch({ type: 'submitted', email: parsed.data.email });
    login.mutate(parsed.data);
  };

  return (
    <AuthLayout title="Giriş yap" description="Yönetici ve sakinler için tek giriş noktası.">
      {expired && !login.isError && <Alert tone="danger">Oturumunuz sunucu tarafından reddedildi (401). Lütfen tekrar giriş yapın.</Alert>}
      {notice && !login.isError && <Alert tone="success">{notice}</Alert>}
      {login.isError && <Alert tone="danger">{errorMessage(login.error)}</Alert>}

      <View style={styles.form}>
        <TextField
          label="E-posta"
          value={email}
          onChangeText={setEmail}
          error={errors.email}
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="username"
          returnKeyType="next"
        />
        <TextField
          label="Şifre"
          value={password}
          onChangeText={setPassword}
          error={errors.password}
          password
          autoComplete="current-password"
          textContentType="password"
          returnKeyType="go"
          onSubmitEditing={() => submit({ email, password })}
        />
        <View style={styles.forgot}>
          <Button
            variant="ghost"
            label="Şifremi unuttum"
            onPress={() => {
              flow.dispatch({ type: 'submitted', email });
              router.push('/forgot-password');
            }}
          />
        </View>
        <Button label="Giriş yap" icon={LogIn} block loading={login.isPending} onPress={() => submit({ email, password })} />
      </View>

      {env.authMode === 'mock' && (
        <View style={styles.mock}>
          <AppText variant="small" tone="muted">
            {`Yerel geliştirme (mock). İlk giriş için şifre ${MOCK_TEMP_PASSWORD}, MFA için e-postaya +mfa ekleyin (kod 123456).`}
          </AppText>
          <View style={styles.mockButtons}>
            {MOCK_ACCOUNTS.map((a) => (
              <Button
                key={a.email}
                variant="secondary"
                label={a.label}
                disabled={login.isPending}
                onPress={() => {
                  setEmail(a.email);
                  submit({ email: a.email, password: 'Mock123456' });
                }}
              />
            ))}
          </View>
        </View>
      )}
    </AuthLayout>
  );
}

const styles = StyleSheet.create({
  form: { gap: space(4) },
  forgot: { alignItems: 'flex-end', marginTop: -space(2) },
  mock: { gap: space(2), paddingTop: space(2) },
  mockButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space(2) },
});
