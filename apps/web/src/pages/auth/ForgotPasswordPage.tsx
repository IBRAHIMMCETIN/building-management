import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { Alert, Button, Card, CardTitle, FormField, Input, PasswordInput } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { errorMessage } from '@/lib/api/errors';
import { PasswordRules } from './PasswordRules';
import { type ForgotConfirmInput, type ForgotRequestInput, forgotConfirmSchema, forgotRequestSchema } from './schemas';

type LocationState = { email?: string; notice?: string } | null;

export function ForgotPasswordPage() {
  const { requestPasswordReset, confirmPasswordReset } = useAuth();
  const navigate = useNavigate();
  const state = useLocation().state as LocationState;
  const [sentTo, setSentTo] = useState<{ email: string; destination?: string } | null>(null);

  const requestForm = useForm<ForgotRequestInput>({
    resolver: zodResolver(forgotRequestSchema),
    defaultValues: { email: state?.email ?? '' },
  });
  const confirmForm = useForm<ForgotConfirmInput>({
    resolver: zodResolver(forgotConfirmSchema),
    defaultValues: { code: '', newPassword: '', confirmPassword: '' },
  });

  const request = useMutation({
    mutationFn: (email: string) => requestPasswordReset(email).then((r) => ({ email, ...r })),
    onSuccess: (result) => {
      setSentTo(result);
      confirmForm.reset();
    },
  });

  const confirm = useMutation({
    mutationFn: (values: ForgotConfirmInput) =>
      confirmPasswordReset({ email: sentTo?.email ?? '', code: values.code, newPassword: values.newPassword }),
    onSuccess: () =>
      navigate('/login', {
        replace: true,
        state: { email: sentTo?.email, notice: 'Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.' },
      }),
  });

  const newPasswordValue = confirmForm.watch('newPassword');

  return (
    <Card className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <CardTitle>Şifremi unuttum</CardTitle>
        <p className="text-small text-muted">
          {sentTo
            ? 'E-postanıza gelen kodu ve yeni şifrenizi girin.'
            : 'Hesabınıza kayıtlı e-posta adresine bir doğrulama kodu göndereceğiz.'}
        </p>
      </div>

      {!sentTo && (
        <>
          {state?.notice && <Alert>{state.notice}</Alert>}
          {request.isError && <Alert tone="danger">{errorMessage(request.error)}</Alert>}
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={requestForm.handleSubmit((v) => request.mutate(v.email))}
          >
            <FormField label="E-posta" error={requestForm.formState.errors.email?.message}>
              <Input type="email" autoComplete="username" inputMode="email" autoFocus {...requestForm.register('email')} />
            </FormField>
            <Button type="submit" loading={request.isPending}>
              Kod gönder
            </Button>
          </form>
        </>
      )}

      {sentTo && (
        <>
          {/* Hesap yoksa da ayni mesaj gosterilir (kullanici varligi sizdirilmaz). */}
          <Alert tone="success">Hesap mevcutsa kod {sentTo.destination ?? sentTo.email} adresine gönderildi.</Alert>
          {confirm.isError && <Alert tone="danger">{errorMessage(confirm.error)}</Alert>}
          <form
            className="flex flex-col gap-4"
            noValidate
            onSubmit={confirmForm.handleSubmit((v) => confirm.mutate(v))}
          >
            <FormField label="Doğrulama kodu" error={confirmForm.formState.errors.code?.message}>
              <Input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                className="tracking-[0.4em]"
                {...confirmForm.register('code')}
              />
            </FormField>
            <FormField label="Yeni şifre" error={confirmForm.formState.errors.newPassword?.message}>
              <PasswordInput autoComplete="new-password" {...confirmForm.register('newPassword')} />
            </FormField>
            <PasswordRules value={newPasswordValue} />
            <FormField label="Yeni şifre (tekrar)" error={confirmForm.formState.errors.confirmPassword?.message}>
              <PasswordInput autoComplete="new-password" {...confirmForm.register('confirmPassword')} />
            </FormField>
            <Button type="submit" loading={confirm.isPending}>
              Şifreyi güncelle
            </Button>
          </form>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            loading={request.isPending}
            onClick={() => request.mutate(sentTo.email)}
          >
            Kodu tekrar gönder
          </Button>
        </>
      )}

      <Link to="/login" className="inline-flex items-center gap-1 text-small text-accent underline-offset-4 hover:underline">
        <ArrowLeft className="size-4" aria-hidden="true" />
        Girişe dön
      </Link>
    </Card>
  );
}
