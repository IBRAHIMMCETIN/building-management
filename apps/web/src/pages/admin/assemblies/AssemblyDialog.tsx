import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useSaveAssembly } from '@/hooks/useAssemblies';
import { ASSEMBLY_KINDS, type Assembly, KIND_LABELS, MAX_AGENDA_ITEMS } from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { type AssemblyForm, type AssemblyValues, FORM_FIELDS, assemblyFormSchema, formDefaults, toInput } from './schemas';

type Props = { open: boolean; onClose: () => void; assembly?: Assembly };

/** Toplanti kaydi: tur, tarih-saat, yer / cevrim ici baglanti ve gundem (sayimdan once duzenlenir). */
export function AssemblyDialog({ open, onClose, assembly }: Props) {
  const save = useSaveAssembly();
  const form = useForm<AssemblyForm, unknown, AssemblyValues>({ resolver: zodResolver(assemblyFormSchema), defaultValues: formDefaults(assembly) });
  const { errors } = form.formState;
  const agenda = form.watch('agenda');

  useEffect(() => {
    if (!open) return;
    save.reset();
    form.reset(formDefaults(assembly));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, assembly]);

  const setAgenda = (next: string[]) => form.setValue('agenda', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const submit = form.handleSubmit(async (v) => {
    try {
      await save.mutateAsync({ id: assembly?.assemblyId, version: assembly?.version, input: toInput(v, assembly) });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, FORM_FIELDS);
    }
  });
  const close = () => !save.isPending && onClose();

  return (
    <Dialog open={open} onClose={close} title={assembly ? 'Toplantıyı düzenle' : 'Yeni genel kurul'} className="max-w-xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && <Alert tone="danger">{errorMessage(save.error)}</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Toplantı türü" error={errors.kind?.message}>
            <Select {...form.register('kind')}>
              {ASSEMBLY_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Tarih ve saat" error={errors.scheduledAt?.message}>
            <Input type="datetime-local" {...form.register('scheduledAt')} />
          </FormField>
        </div>

        <FormField label="Toplantı yeri" error={errors.location?.message} hint="Yer veya çevrim içi bağlantıdan en az biri gerekli.">
          <Input autoComplete="off" maxLength={300} placeholder="Örn. Site toplantı salonu" {...form.register('location')} />
        </FormField>
        <FormField label="Çevrim içi bağlantı (isteğe bağlı)" error={errors.onlineUrl?.message}>
          <Input type="url" autoComplete="off" maxLength={500} placeholder="https://" {...form.register('onlineUrl')} />
        </FormField>

        <label className="flex items-start gap-2">
          <input type="checkbox" className="mt-1 size-4 accent-accent" {...form.register('secondMeeting')} />
          <span>
            <span className="block">İkinci toplantı</span>
            <span className="block text-small text-muted">İlk toplantıda yeter sayı sağlanamadıysa (KMK m.30): toplantı yeter sayısı aranmaz.</span>
          </span>
        </label>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Gündem</legend>
          <ol className="flex flex-col gap-2">
            {agenda.map((value, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="w-5 shrink-0 text-right text-small text-muted tabular-nums">{i + 1}.</span>
                <Input
                  aria-label={`${i + 1}. gündem maddesi`}
                  autoComplete="off"
                  maxLength={300}
                  value={value}
                  invalid={Boolean(errors.agenda) && !value.trim()}
                  onChange={(e) => setAgenda(agenda.map((a, j) => (j === i ? e.target.value : a)))}
                />
                {agenda.length > 1 && (
                  <Button size="sm" variant="ghost" aria-label={`${i + 1}. maddeyi kaldır`} onClick={() => setAgenda(agenda.filter((_, j) => j !== i))}>
                    <X className="size-4" aria-hidden="true" />
                  </Button>
                )}
              </li>
            ))}
          </ol>
          {errors.agenda?.message && <p className="text-small text-danger">{errors.agenda.message}</p>}
          {agenda.length < MAX_AGENDA_ITEMS && (
            <div>
              <Button size="xs" variant="subtle" onClick={() => setAgenda([...agenda, ''])}>
                <Plus className="size-3.5" aria-hidden="true" />
                Madde ekle
              </Button>
            </div>
          )}
        </fieldset>

        <p className="text-small text-muted">Hazirun cetveli toplantı günündeki mülkiyet kayıtlarından (oy listesi) hazırlanır. Sayım kaydedildikten sonra toplantı bilgileri değiştirilemez.</p>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
