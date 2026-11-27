import { zodResolver } from '@hookform/resolvers/zod';
import { CheckCircle2, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Textarea } from '@/components/ui';
import { useCreatePoll, useUpdatePoll } from '@/hooks/usePolls';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { AUDIENCE_HINTS, AUDIENCE_LABELS, MAX_OPTIONS, MIN_OPTIONS, POLL_AUDIENCES, POLL_WEIGHTINGS, type Poll, WEIGHTING_HINTS, WEIGHTING_LABELS } from '@/lib/api/polls';
import { nowIstanbulLocal } from '@/lib/dates';
import { FORM_FIELDS, type PollForm, type PollValues, formDefaults, pollFormSchema, toCreateInput, toUpdateInput } from './schemas';

type Props = {
  open: boolean;
  onClose: () => void;
  /** Verilirse taslak duzenlenir; yoksa yeni oylama. */
  poll?: Poll;
};

/** Oylama taslagi: yayin listeden onayla yapilir (yayindan sonra soru ve secenekler degismez). */
export function PollDialog({ open, onClose, poll }: Props) {
  const create = useCreatePoll();
  const update = useUpdatePoll();
  const [saved, setSaved] = useState(false);
  const editing = Boolean(poll);

  const form = useForm<PollForm, unknown, PollValues>({ resolver: zodResolver(pollFormSchema), defaultValues: formDefaults(poll) });
  const { errors } = form.formState;
  const options = form.watch('options');
  const timing = form.watch('timing');
  const secret = form.watch('secret');

  useEffect(() => {
    if (!open) return;
    create.reset();
    update.reset();
    setSaved(false);
    form.reset(formDefaults(poll));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, poll]);

  // Gizli oylamada ara sonuc acilamaz.
  useEffect(() => {
    if (secret) form.setValue('resultsVisibleBeforeClose', false);
  }, [secret, form]);

  const saveError = create.error ?? update.error;
  const pending = create.isPending || update.isPending;
  const setOptions = (next: string[]) => form.setValue('options', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });

  const submit = form.handleSubmit(async (v) => {
    try {
      if (poll) await update.mutateAsync({ id: poll.pollId, input: toUpdateInput(v, poll.version) });
      else await create.mutateAsync(toCreateInput(v));
      setSaved(true);
    } catch (err) {
      applyApiFieldError(err, form.setError, FORM_FIELDS);
    }
  });

  const close = () => !pending && onClose();
  const title = editing ? 'Taslağı düzenle' : 'Yeni oylama';

  if (saved) {
    return (
      <Dialog open={open} onClose={close} title={title}>
        <div className="flex flex-col items-center gap-3 py-2 text-center">
          <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
          <p className="font-semibold">Taslak kaydedildi</p>
          <p className="text-small text-muted">Sakinler taslağı göremez. Hazır olduğunuzda listeden yayınlayın.</p>
          <Button className="mt-2" onClick={onClose}>
            Tamam
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onClose={close} title={title} className="max-w-xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {saveError && !Object.values(errors).some((e) => e?.type === 'server') && <Alert tone="danger">{errorMessage(saveError)}</Alert>}

        <FormField label="Soru / başlık" error={errors.title?.message}>
          <Input autoComplete="off" maxLength={150} placeholder="Örn. Asansörler yenilensin mi?" {...form.register('title')} />
        </FormField>

        <FormField label="Açıklama (isteğe bağlı)" error={errors.description?.message}>
          <Textarea maxLength={2000} placeholder="Teklifler, maliyet, karar gerekçesi…" {...form.register('description')} />
        </FormField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Seçenekler</legend>
          <p className="text-small text-muted">
            Her bölüm tek seçenek işaretler. En az {MIN_OPTIONS}, en fazla {MAX_OPTIONS} seçenek.
          </p>
          <ol className="flex flex-col gap-2">
            {options.map((value, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-small text-muted tabular-nums">{i + 1}.</span>
                <Input
                  aria-label={`${i + 1}. seçenek`}
                  autoComplete="off"
                  maxLength={200}
                  value={value}
                  invalid={Boolean(errors.options) && !value.trim()}
                  onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                />
                {options.length > MIN_OPTIONS && (
                  <Button size="sm" variant="ghost" aria-label={`${i + 1}. seçeneği kaldır`} onClick={() => setOptions(options.filter((_, j) => j !== i))}>
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {errors.options?.message && <p className="text-small text-danger">{errors.options.message}</p>}
          {options.length < MAX_OPTIONS && (
            <div>
              <Button size="xs" variant="subtle" onClick={() => setOptions([...options, ''])}>
                <Plus className="size-3.5" aria-hidden="true" />
                Seçenek ekle
              </Button>
            </div>
          )}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Kimler oy kullanır?</legend>
          <div className="flex flex-col gap-2">
            {POLL_AUDIENCES.map((a) => (
              <label key={a} className="flex items-start gap-2">
                <input type="radio" value={a} className="mt-1 size-4 accent-accent" {...form.register('audience')} />
                <span>
                  <span className="block">{AUDIENCE_LABELS[a]}</span>
                  <span className="block text-small text-muted">{AUDIENCE_HINTS[a]}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Oy ağırlığı</legend>
          <div className="flex flex-col gap-2">
            {POLL_WEIGHTINGS.map((w) => (
              <label key={w} className="flex items-start gap-2">
                <input type="radio" value={w} className="mt-1 size-4 accent-accent" {...form.register('weighting')} />
                <span>
                  <span className="block">{WEIGHTING_LABELS[w]}</span>
                  <span className="block text-small text-muted">{WEIGHTING_HINTS[w]}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-small text-muted">Hisseli bölümde paydaşlardan biri bölümün tek oyunu kullanır; sonraki oy öncekinin yerine geçer.</p>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Gizlilik ve sonuçlar</legend>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 size-4 accent-accent" {...form.register('secret')} />
            <span>
              <span className="block">Gizli oylama (önerilir)</span>
              <span className="block text-small text-muted">Yönetim hangi bölümün neyi seçtiğini göremez; seçeneklerin dağılımı oylama bitince açıklanır.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1 size-4 accent-accent disabled:opacity-60" disabled={secret} {...form.register('resultsVisibleBeforeClose')} />
            <span>
              <span className="block">Oy verenler sonuçları oylama sürerken görebilsin</span>
              <span className="block text-small text-muted">{secret ? 'Gizli oylamada kullanılamaz.' : 'Kapalıysa sonuçlar oylama bitince açıklanır.'}</span>
            </span>
          </label>
          {errors.resultsVisibleBeforeClose?.message && <p className="text-small text-danger">{errors.resultsVisibleBeforeClose.message}</p>}
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Başlangıç</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <label className="inline-flex items-center gap-2">
              <input type="radio" value="now" className="size-4 accent-accent" {...form.register('timing')} />
              Yayınlayınca hemen
            </label>
            <label className="inline-flex items-center gap-2">
              <input type="radio" value="scheduled" className="size-4 accent-accent" {...form.register('timing')} />
              İleri bir tarihte
            </label>
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          {timing === 'scheduled' && (
            <FormField label="Başlangıç tarihi ve saati" error={errors.opensAt?.message}>
              <Input type="datetime-local" min={nowIstanbulLocal()} {...form.register('opensAt')} />
            </FormField>
          )}
          <FormField label="Bitiş tarihi ve saati" error={errors.closesAt?.message} hint="Bu zamandan sonra oy kabul edilmez.">
            <Input type="datetime-local" min={nowIstanbulLocal()} {...form.register('closesAt')} />
          </FormField>
        </div>

        <p className="text-small text-muted">
          Oy hakkı ve arsa payları başlangıç günündeki mülkiyet kayıtlarına (oy listesi) göre belirlenir. Yayınlanan oylamanın sorusu ve seçenekleri değiştirilemez.
        </p>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={pending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={pending}>
            Taslak olarak kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
