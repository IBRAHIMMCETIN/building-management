import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { Button, FormField, Input } from '@/components/ui';
import { type TotpInput, totpSchema } from './schemas';

export function TotpForm({ pending, onSubmit }: { pending: boolean; onSubmit: (code: string) => void }) {
  const form = useForm<TotpInput>({ resolver: zodResolver(totpSchema), defaultValues: { code: '' } });

  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit((v) => onSubmit(v.code))}>
      <FormField label="Doğrulama kodu" error={form.formState.errors.code?.message}>
        <Input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          autoFocus
          className="tracking-[0.4em]"
          {...form.register('code')}
        />
      </FormField>
      <Button type="submit" loading={pending}>
        Doğrula
      </Button>
    </form>
  );
}
