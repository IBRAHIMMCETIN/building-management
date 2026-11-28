import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEMO_LIMITS,
  DEMO_UNIT_RANGES,
  DEMO_UNIT_RANGE_LABELS,
  type DemoRequestFormOutput,
  type DemoRequestFormValues,
  demoRequestFormSchema,
  toDemoRequestPayload,
} from '@bm/shared/api/demoRequests';
import { KVKK_NOTICE } from '@bm/shared/legal/documents';
import { CircleCheck, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Card, FormField, Input, Select, Textarea } from '@/components/ui';
import { errorMessage } from '@/lib/api/errors';
import { submitDemoRequest } from '@/lib/api/publicDemoRequests';

const EMPTY: DemoRequestFormValues = {
  fullName: '',
  email: '',
  phone: '',
  organization: '',
  unitRange: '',
  message: '',
  kvkkConsent: false,
  website: '',
};

type Submit = (payload: ReturnType<typeof toDemoRequestPayload>) => Promise<unknown>;

/**
 * Demo talep formu (`#iletisim`). Dogrulama paylasilan zod semasiyla (alan altinda hata), gonderim
 * kimliksiz `POST /api/public/demo-requests`. Basarida form yerine onay paneli; hata (ag, 429, 400)
 * formun ustunde, girilen degerler korunur. Bal kupu alani ekran okuyucudan ve klavyeden gizlidir.
 */
export function DemoRequestForm({ submit = submitDemoRequest }: { submit?: Submit }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const doneRef = useRef<HTMLDivElement>(null);
  const form = useForm<DemoRequestFormValues, unknown, DemoRequestFormOutput>({ resolver: zodResolver(demoRequestFormSchema), defaultValues: EMPTY });
  const { errors, isSubmitting } = form.formState;

  const onSubmit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      await submit(toDemoRequestPayload(values, KVKK_NOTICE.version));
      setDone(true);
      form.reset(EMPTY);
      requestAnimationFrame(() => doneRef.current?.focus());
    } catch (err) {
      setError(errorMessage(err));
    }
  });

  if (done) {
    return (
      <Card className="flex flex-col items-start gap-3">
        <div ref={doneRef} tabIndex={-1} role="status" className="flex flex-col gap-2 focus:outline-none">
          <p className="flex items-center gap-2 text-heading font-semibold text-success">
            <CircleCheck className="size-6 shrink-0" aria-hidden="true" />
            Talebiniz alındı
          </p>
          <p className="text-small text-text-secondary">Teşekkürler. Sitenizin ihtiyaçlarını konuşmak için en kısa sürede sizinle iletişime geçeceğiz.</p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setDone(false)}>
          Yeni talep gönder
        </Button>
      </Card>
    );
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" noValidate onSubmit={onSubmit} aria-label="Demo talep formu">
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Ad soyad" error={errors.fullName?.message}>
            <Input autoComplete="name" maxLength={DEMO_LIMITS.fullName} {...form.register('fullName')} />
          </FormField>
          <FormField label="E-posta" error={errors.email?.message}>
            <Input type="email" autoComplete="email" inputMode="email" maxLength={DEMO_LIMITS.email} {...form.register('email')} />
          </FormField>
          <FormField label="Telefon (isteğe bağlı)" error={errors.phone?.message}>
            <Input type="tel" autoComplete="tel" inputMode="tel" maxLength={DEMO_LIMITS.phone} {...form.register('phone')} />
          </FormField>
          <FormField label="Site veya firma adı" error={errors.organization?.message}>
            <Input autoComplete="organization" maxLength={DEMO_LIMITS.organization} {...form.register('organization')} />
          </FormField>
        </div>
        <FormField label="Bağımsız bölüm sayısı" error={errors.unitRange?.message}>
          <Select {...form.register('unitRange')}>
            <option value="">Seçin</option>
            {DEMO_UNIT_RANGES.map((r) => (
              <option key={r} value={r}>
                {DEMO_UNIT_RANGE_LABELS[r]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Mesajınız (isteğe bağlı)" error={errors.message?.message} hint="Blok sayısı, mevcut yönetim yazılımınız veya özellikle görmek istediğiniz modüller.">
          <Textarea rows={4} maxLength={DEMO_LIMITS.message} {...form.register('message')} />
        </FormField>

        {/* Bal kupu: gercek kullanici gormez ve bos birakir. */}
        <div aria-hidden="true" className="sr-only">
          <label>
            Web siteniz (boş bırakın)
            <input type="text" tabIndex={-1} autoComplete="off" {...form.register('website')} />
          </label>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="flex items-start gap-3 text-small text-text-secondary">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-accent"
              aria-invalid={errors.kvkkConsent ? true : undefined}
              aria-describedby={errors.kvkkConsent ? 'kvkk-consent-error' : undefined}
              {...form.register('kvkkConsent')}
            />
            <span>
              Kişisel verilerimin demo talebime dönüş yapılması amacıyla işlenmesine ilişkin{' '}
              <a href={KVKK_NOTICE.path} target="_blank" rel="noopener noreferrer" className="font-medium text-accent underline underline-offset-4">
                KVKK Aydınlatma Metni
                <span className="sr-only"> (yeni sekmede açılır)</span>
              </a>
              ’ni okudum.
            </span>
          </label>
          {errors.kvkkConsent && (
            <p id="kvkk-consent-error" className="text-small text-danger">
              {errors.kvkkConsent.message}
            </p>
          )}
        </div>

        {/* Gonderim hatasi dugmenin hemen ustunde: kullanici o sirada formun sonundadir. */}
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" loading={isSubmitting} className="self-start">
          <Send className="size-4" aria-hidden="true" />
          Demo talebini gönder
        </Button>
      </form>
    </Card>
  );
}
