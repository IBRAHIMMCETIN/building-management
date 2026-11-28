import { zodResolver } from '@hookform/resolvers/zod';
import {
  DEMO_HONEYPOT_FIELD,
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
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Card, FormField, Input, Select, Textarea } from '@/components/ui';
import { ApiError, NetworkError, errorMessage } from '@/lib/api/errors';
import { submitDemoRequest } from '@/lib/api/publicDemoRequests';

const EMPTY: DemoRequestFormValues = {
  fullName: '',
  email: '',
  phone: '',
  organization: '',
  unitRange: '',
  message: '',
  kvkkConsent: false,
  [DEMO_HONEYPOT_FIELD]: '',
};

type Submit = (payload: ReturnType<typeof toDemoRequestPayload>) => Promise<unknown>;

export const TOO_MANY_REQUESTS_MESSAGE = 'Çok fazla istek gönderildi. Lütfen birkaç dakika sonra tekrar deneyin.';
export const SEND_FAILED_MESSAGE =
  'Talebiniz gönderilemedi: bağlantı kurulamadı ya da kısa sürede çok fazla istek gönderildi. Lütfen birkaç dakika sonra tekrar deneyin.';

/**
 * Gonderim hatasinin metni. API'nin kendi 429'u Turkce mesaj ve sure tasir; API Gateway'in rota
 * throttling 429'unda govde bizim bicimimizde degildir (genel mesaj) ve CORS basliklari olmayabilir:
 * tarayici o zaman yaniti ag hatasi olarak gorur, bu yuzden ag hatasi da "cok fazla istek olabilir"
 * diye anlatilir.
 */
export function demoSubmitErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return err.body?.message ?? TOO_MANY_REQUESTS_MESSAGE;
  if (err instanceof NetworkError) return SEND_FAILED_MESSAGE;
  return errorMessage(err);
}

/**
 * Demo talep formu (`#iletisim`). Dogrulama paylasilan zod semasiyla (alan altinda hata; API ile ayni
 * kurallar), gonderim kimliksiz `POST /api/public/demo-requests`. Basarida form yerine onay paneli; hata
 * (ag, 429, 400) gonder dugmesinin ustunde, girilen degerler korunur.
 *
 * On-render HTML'de (hidrasyondan once veya JS parcasi inmezse) form tarayicinin kendi gonderimine
 * KAPALIDIR: `method="post"` (alanlar adreste gorunmez) ve gonder dugmesi bilesen baglanana kadar
 * devre disi (Enter ile ortuk gonderim de olmaz).
 */
export function DemoRequestForm({ submit = submitDemoRequest }: { submit?: Submit }) {
  const [mounted, setMounted] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string>();
  const doneRef = useRef<HTMLDivElement>(null);
  const form = useForm<DemoRequestFormValues, unknown, DemoRequestFormOutput>({ resolver: zodResolver(demoRequestFormSchema), defaultValues: EMPTY });
  const { errors, isSubmitting } = form.formState;

  useEffect(() => setMounted(true), []);

  const onSubmit = form.handleSubmit(async (values) => {
    setError(undefined);
    try {
      await submit(toDemoRequestPayload(values, KVKK_NOTICE.version));
      setDone(true);
      form.reset(EMPTY);
      requestAnimationFrame(() => doneRef.current?.focus());
    } catch (err) {
      setError(demoSubmitErrorMessage(err));
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
      <form method="post" action="#iletisim" className="flex flex-col gap-4" noValidate onSubmit={onSubmit} aria-label="Demo talep formu">
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

        {/* Bal kupu: gercek kullanici gormez ve bos birakir; anlamsiz ad, otomatik doldurma kapali. */}
        <div aria-hidden="true" className="sr-only">
          <label>
            Bu alanı boş bırakın
            <input type="text" tabIndex={-1} autoComplete="off" data-1p-ignore data-lpignore="true" {...form.register(DEMO_HONEYPOT_FIELD)} />
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
        <Button type="submit" loading={isSubmitting} disabled={!mounted} className="self-start">
          <Send className="size-4" aria-hidden="true" />
          Demo talebini gönder
        </Button>
      </form>
    </Card>
  );
}
