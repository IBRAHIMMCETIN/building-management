import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button, FormField, PasswordInput } from '@/components/ui';
import { PasswordRules } from './PasswordRules';
import { type NewPasswordFormInput, newPasswordFormSchema } from './schemas';

type Props = {
  submitLabel: string;
  pending: boolean;
  onSubmit: (newPassword: string) => void;
};

/** Ilk giris (NEW_PASSWORD_REQUIRED) ve sifre sifirlama onayi icin ortak sifre alanlari. */
export function NewPasswordForm({ submitLabel, pending, onSubmit }: Props) {
  const form = useForm<NewPasswordFormInput>({
    resolver: zodResolver(newPasswordFormSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });
  const { errors } = form.formState;
  const value = form.watch('newPassword');

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit((v) => onSubmit(v.newPassword))}>
      <FormField label="Yeni şifre" error={errors.newPassword?.message}>
        <PasswordInput autoComplete="new-password" autoFocus {...form.register('newPassword')} />
      </FormField>
      <PasswordRules value={value} />
      <FormField label="Yeni şifre (tekrar)" error={errors.confirmPassword?.message}>
        <PasswordInput autoComplete="new-password" {...form.register('confirmPassword')} />
      </FormField>
      <Button type="submit" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}
