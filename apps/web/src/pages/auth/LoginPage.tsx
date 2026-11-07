import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, LogIn } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, CardTitle, FormField, Input, PasswordInput } from '@/components/ui';
import { env } from '@/config/env';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/lib/api/errors';
import type { AuthSession, SignInStep } from '@/lib/auth/session';
import { ROLE_LABELS, homePathForRole } from '@/types/roles';
import { NewPasswordForm } from './NewPasswordForm';
import { type LoginInput, loginSchema } from './schemas';
import { TotpForm } from './TotpForm';

type Stage = 'credentials' | 'newPassword' | 'totp';

type LoginLocationState = { from?: string; email?: string; notice?: string } | null;

const MOCK_ACCOUNTS = [
  { email: 'apartment_manager@dev.local', label: ROLE_LABELS.apartment_manager },
  { email: 'resident@dev.local', label: ROLE_LABELS.resident },
  { email: 'observer@dev.local', label: ROLE_LABELS.observer },
  { email: 'platform_admin@dev.local', label: ROLE_LABELS.platform_admin },
  { email: 'multi@dev.local', label: 'Çoklu apartman' },
];

export function LoginPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as LoginLocationState;
  const [stage, setStage] = useState<Stage>('credentials');
  const [email, setEmail] = useState(state?.email ?? '');

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: state?.email ?? '', password: '' },
  });

  const finish = (session: AuthSession) => {
    const role = session.claims.role;
    // Rol claim'i yoksa (birden fazla apartman, secim yapilmamis) once baglam secilir.
    const target = !role ? '/select-context' : (state?.from ?? homePathForRole(role));
    navigate(target, { replace: true });
  };

  const handleStep = (step: SignInStep) => {
    switch (step.type) {
      case 'done':
        return finish(step.session);
      case 'newPasswordRequired':
        return setStage('newPassword');
      case 'totpRequired':
        return setStage('totp');
      case 'resetPasswordRequired':
        return navigate('/forgot-password', {
          state: { email, notice: 'Şifreniz yönetici tarafından sıfırlandı. Yeni şifre belirlemek için kod isteyin.' },
        });
    }
  };

  const login = useMutation({ mutationFn: auth.signIn, onSuccess: handleStep });
  const newPassword = useMutation({ mutationFn: auth.confirmNewPassword, onSuccess: handleStep });
  const totp = useMutation({ mutationFn: auth.confirmTotp, onSuccess: handleStep });

  const active = stage === 'credentials' ? login : stage === 'newPassword' ? newPassword : totp;

  const restart = () => {
    newPassword.reset();
    totp.reset();
    form.resetField('password');
    setStage('credentials');
  };

  const submitCredentials = (values: LoginInput) => {
    setEmail(values.email);
    login.mutate(values);
  };

  return (
    <Card className="flex flex-col gap-6">
      {stage === 'credentials' && (
        <>
          <div className="flex flex-col gap-1">
            <CardTitle>Giriş yap</CardTitle>
            <p className="text-small text-muted">Yönetici ve sakinler için tek giriş noktası.</p>
          </div>

          {state?.notice && !login.isError && <Alert tone="success">{state.notice}</Alert>}
          {login.isError && <Alert tone="danger">{errorMessage(login.error)}</Alert>}

          <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit(submitCredentials)}>
            <FormField label="E-posta" error={form.formState.errors.email?.message}>
              <Input type="email" autoComplete="username" inputMode="email" {...form.register('email')} />
            </FormField>
            <FormField label="Şifre" error={form.formState.errors.password?.message}>
              <PasswordInput autoComplete="current-password" {...form.register('password')} />
            </FormField>
            <div className="-mt-1 flex justify-end">
              <Link
                to="/forgot-password"
                // Form kontrolsuz (uncontrolled): e-posta tiklama aninda okunmali, render aninda degil.
                onClick={(e) => {
                  e.preventDefault();
                  navigate('/forgot-password', { state: { email: form.getValues('email') } });
                }}
                className="text-small text-accent underline-offset-4 hover:underline"
              >
                Şifremi unuttum
              </Link>
            </div>
            <Button type="submit" loading={login.isPending}>
              <LogIn className="size-4" aria-hidden="true" />
              Giriş yap
            </Button>
          </form>

          {env.authMode === 'mock' && (
            <div className="flex flex-col gap-2 border-t border-border pt-4">
              <p className="text-small text-muted">
                Yerel geliştirme (mock). İlk giriş için şifre <code>Gecici12345</code>, MFA için e-postaya{' '}
                <code>+mfa</code> ekleyin (kod <code>123456</code>).
              </p>
              <div className="flex flex-wrap gap-2">
                {MOCK_ACCOUNTS.map((a) => (
                  <Button
                    key={a.email}
                    size="sm"
                    variant="secondary"
                    disabled={login.isPending}
                    onClick={() => submitCredentials({ email: a.email, password: 'Mock123456' })}
                  >
                    {a.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {stage !== 'credentials' && (
        <>
          <div className="flex flex-col gap-1">
            <CardTitle>{stage === 'newPassword' ? 'Yeni şifre belirleyin' : 'İki adımlı doğrulama'}</CardTitle>
            <p className="text-small text-muted">
              {stage === 'newPassword'
                ? 'Geçici şifrenizle ilk kez giriş yaptınız. Devam etmek için kendi şifrenizi belirleyin.'
                : 'Doğrulayıcı uygulamanızdaki 6 haneli kodu girin.'}
            </p>
            <p className="text-small text-muted">{email}</p>
          </div>

          {active.isError && <Alert tone="danger">{errorMessage(active.error)}</Alert>}

          {stage === 'newPassword' ? (
            <NewPasswordForm
              submitLabel="Şifreyi kaydet ve devam et"
              pending={newPassword.isPending}
              onSubmit={(pw) => newPassword.mutate(pw)}
            />
          ) : (
            <TotpForm pending={totp.isPending} onSubmit={(code) => totp.mutate(code)} />
          )}

          <Button variant="ghost" size="sm" onClick={restart} className="self-start">
            <ArrowLeft className="size-4" aria-hidden="true" />
            Farklı hesapla giriş yap
          </Button>
        </>
      )}
    </Card>
  );
}
