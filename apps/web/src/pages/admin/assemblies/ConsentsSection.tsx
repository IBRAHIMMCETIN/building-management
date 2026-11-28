import { zodResolver } from '@hookform/resolvers/zod';
import { ChevronRight, FileSignature, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useConsents, useCreateConsent } from '@/hooks/useAssemblies';
import {
  CONSENT_KINDS,
  CONSENT_RULES,
  CONSENT_STATUS_LABELS,
  CONSENT_STATUS_TONES,
  DECISION_LABELS,
  DECISION_PRESETS,
  MAJORITY_LABELS,
  type MajorityRule,
  kindLabel,
} from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { formatDate } from '@/lib/dates';
import { ConsentDetailDialog } from './ConsentDetailDialog';
import { CONSENT_FORM_FIELDS, type ConsentForm, type ConsentValues, consentDefaults, consentFormSchema, consentRule, toConsentInput } from './schemas';

/**
 * Toplanti disinda yazili riza (KMK m.19/2; diger turler yoruma dayali, README "Hukuki yorum"):
 * talepler, yeni talep, ayrinti (bolum bazinda riza / itiraz, sonuc, PDF).
 */
export function ConsentsSection({ canWrite }: { canWrite: boolean }) {
  const list = useConsents();
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = list.data ?? [];

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <FileSignature className="size-5 text-muted" aria-hidden="true" />
          Yazılı rıza (toplantı dışında)
        </CardTitle>
        {canWrite && (
          <Button size="sm" variant="secondary" onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni rıza talebi
          </Button>
        )}
      </div>
      <p className="text-small text-muted">
        Kanunun yazılı rızaya izin verdiği kararlar (ör. ortak yerlerde inşaat, dış cephe boyası: bütün kat maliklerinin beşte dördünün yazılı rızası, KMK m.19/2) toplantı yapılmadan imza
        toplanarak kaydedilir. Sayım toplantı kararlarıyla aynı kurallarla yapılır; rıza kayıtları değişmez, düzeltme gerekçeli yeni kayıttır.
      </p>
      {list.isPending ? (
        <Skeleton className="h-16" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="text-small text-muted">Henüz yazılı rıza talebi yok.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {items.map((c) => (
            <li key={c.consentId} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="min-w-0">
                <p className="font-medium break-words">{c.title}</p>
                <p className="text-xs text-muted">
                  {kindLabel(c.decisionKind)} · {MAJORITY_LABELS[c.rule]} · oy listesi {formatDate(c.rollDate)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.result && <Badge tone={c.result.decision === 'accepted' ? 'success' : 'danger'}>{DECISION_LABELS[c.result.decision]}</Badge>}
                <Badge tone={CONSENT_STATUS_TONES[c.status]}>{CONSENT_STATUS_LABELS[c.status]}</Badge>
                <Button size="xs" variant="subtle" onClick={() => setOpenId(c.consentId)}>
                  Aç
                  <ChevronRight className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {canWrite && <ConsentDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => setOpenId(id)} />}
      <ConsentDetailDialog consentId={openId} canWrite={canWrite} onClose={() => setOpenId(null)} />
    </Card>
  );
}

function ConsentDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (consentId: string) => void }) {
  const create = useCreateConsent();
  const form = useForm<ConsentForm, unknown, ConsentValues>({ resolver: zodResolver(consentFormSchema), defaultValues: consentDefaults() });
  const { errors } = form.formState;
  const kind = form.watch('decisionKind');
  const majority = form.watch('majority');
  useEffect(() => {
    if (!open) return;
    create.reset();
    form.reset(consentDefaults());
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);
  const rule = consentRule(kind, majority as MajorityRule | '');
  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await create.mutateAsync(toConsentInput(v));
      onClose();
      onCreated(r.consent.consentId);
    } catch (err) {
      applyApiFieldError(err, form.setError, CONSENT_FORM_FIELDS);
    }
  });
  const close = () => !create.isPending && onClose();

  return (
    <Dialog open={open} onClose={close} title="Yeni yazılı rıza talebi">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {create.isError && !Object.values(errors).some((e) => e?.type === 'server') && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <FormField label="Konu" error={errors.title?.message}>
          <Input autoComplete="off" maxLength={300} placeholder="Örn. Dış cephenin farklı renkte boyanması" {...form.register('title')} />
        </FormField>
        <FormField label="Açıklama (isteğe bağlı)" error={errors.description?.message}>
          <Textarea rows={3} maxLength={2000} {...form.register('description')} />
        </FormField>
        <FormField label="Karar türü" error={errors.decisionKind?.message}>
          <Select {...form.register('decisionKind', { onChange: () => form.setValue('majority', '') })}>
            {CONSENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </Select>
        </FormField>
        {kind === 'custom' ? (
          <FormField label="Gerekli çoğunluk" error={errors.majority?.message}>
            <Select {...form.register('majority')}>
              <option value="">Gerekli çoğunluğu seçin</option>
              {CONSENT_RULES.map((r) => (
                <option key={r} value={r}>
                  {MAJORITY_LABELS[r]}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <p className="text-small text-muted">
            Gerekli: {rule ? MAJORITY_LABELS[rule] : '—'} ({DECISION_PRESETS[kind].legal})
          </p>
        )}
        <p className="text-small text-muted">
          Oy listesi bugünkü mülkiyet kayıtlarından dondurulur; payda bütün kat malikleridir. Toplantı kararı gerektiren türler (genel karar, işletme projesi, yönetici / denetçi seçimi) burada
          kaydedilemez.
        </p>
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={create.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={create.isPending}>
            Talebi aç
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
