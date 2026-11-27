import { zodResolver } from '@hookform/resolvers/zod';
import { Plus, X } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useAssemblies, useSaveAssembly } from '@/hooks/useAssemblies';
import {
  ASSEMBLY_KINDS,
  type Assembly,
  DECISION_KINDS,
  DECISION_PRESETS,
  type DecisionKind,
  KIND_LABELS,
  MAJORITY_LABELS,
  MAJORITY_RULES,
  MAX_AGENDA_ITEMS,
  type MajorityRule,
  SECOND_MEETING_MAX_DAYS,
  firstMeetingCandidates,
  kindLabel,
} from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { formatDateTime } from '@/lib/dates';
import { type AgendaRow, type AssemblyForm, type AssemblyValues, FORM_FIELDS, emptyAgendaRow, formDefaults, makeAssemblyFormSchema, planGapWarning, toInput } from './schemas';

type Props = { open: boolean; onClose: () => void; assembly?: Assembly };

/**
 * Toplanti kaydi: tur, tarih-saat, yer / cevrim ici baglanti, ilk toplantida bildirilen ikinci
 * toplanti ve gundem (madde basina karar turu ve gerekli cogunluk). Oy listesi dondurulmadan once
 * duzenlenir.
 */
export function AssemblyDialog({ open, onClose, assembly }: Props) {
  const save = useSaveAssembly();
  const list = useAssemblies();
  const candidates = useMemo(() => firstMeetingCandidates(list.data ?? [], assembly?.assemblyId), [list.data, assembly?.assemblyId]);
  const schema = useMemo(() => makeAssemblyFormSchema(candidates), [candidates]);
  const form = useForm<AssemblyForm, unknown, AssemblyValues>({ resolver: zodResolver(schema), defaultValues: formDefaults(assembly) });
  const { errors } = form.formState;
  const agenda = form.watch('agenda');
  const firstMeetingId = form.watch('firstMeetingId');
  const gapWarning = planGapWarning({ scheduledAt: form.watch('scheduledAt'), planAt: form.watch('planAt'), firstMeetingId });

  useEffect(() => {
    if (!open) return;
    save.reset();
    form.reset(formDefaults(assembly));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, assembly]);

  const setAgenda = (next: AgendaRow[]) => form.setValue('agenda', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const patchRow = (i: number, patch: Partial<AgendaRow>) => setAgenda(agenda.map((a, j) => (j === i ? { ...a, ...patch } : a)));
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

        <FormField
          label="İkinci toplantı mı?"
          error={errors.firstMeetingId?.message}
          hint={
            candidates.length
              ? `İlk toplantıda yeter sayı sağlanamadıysa (KMK m.30) o toplantıyı seçin: en geç ${SECOND_MEETING_MAX_DAYS} gün içinde, yeter sayı aranmaz.`
              : 'Yeter sayısızlığı tutanağa geçmiş bir ilk toplantı yok.'
          }
        >
          <Select disabled={candidates.length === 0} {...form.register('firstMeetingId')}>
            <option value="">Hayır, ilk toplantı</option>
            {candidates.map((c) => (
              <option key={c.assemblyId} value={c.assemblyId}>
                {KIND_LABELS[c.kind]} · {formatDateTime(c.scheduledAt)}
              </option>
            ))}
          </Select>
        </FormField>

        {!firstMeetingId && (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Yeter sayı sağlanamazsa ikinci toplantı (isteğe bağlı)"
              error={errors.planAt?.message}
              hint={`KMK m.29: çağrıda bildirilir; ilk toplantıdan en az 7, en geç ${SECOND_MEETING_MAX_DAYS} gün sonra.`}
            >
              <Input type="datetime-local" {...form.register('planAt')} />
            </FormField>
            <FormField label="İkinci toplantının yeri" error={errors.planLocation?.message} hint="Boş bırakılırsa ilk toplantının yeri kullanılır.">
              <Input autoComplete="off" maxLength={300} {...form.register('planLocation')} />
            </FormField>
          </div>
        )}
        {gapWarning && <Alert>{gapWarning}</Alert>}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Gündem</legend>
          <p className="text-small text-muted">
            Her madde için karar türünü seçin: gerekli çoğunluk kanundan gelir (ör. yönetici seçimi bütün kat maliklerinin sayı ve arsa payı çoğunluğu, yönetim planı değişikliği beşte dört). Yönetim
            planındaki farklı çoğunluk için “Özel” türünü seçin.
          </p>
          <ol className="flex flex-col gap-3">
            {agenda.map((row, i) => (
              <li key={i} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-right text-small text-muted tabular-nums">{i + 1}.</span>
                  <Input
                    aria-label={`${i + 1}. gündem maddesi`}
                    autoComplete="off"
                    maxLength={300}
                    value={row.title}
                    invalid={Boolean(errors.agenda) && !row.title.trim()}
                    onChange={(e) => patchRow(i, { title: e.target.value })}
                  />
                  {agenda.length > 1 && (
                    <Button size="sm" variant="ghost" aria-label={`${i + 1}. maddeyi kaldır`} onClick={() => setAgenda(agenda.filter((_, j) => j !== i))}>
                      <X className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <div className="grid gap-2 pl-7 sm:grid-cols-2">
                  <Select
                    aria-label={`${i + 1}. madde karar türü`}
                    value={row.decisionKind}
                    onChange={(e) => patchRow(i, { decisionKind: e.target.value as DecisionKind, majority: '' })}
                  >
                    {DECISION_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {kindLabel(k)}
                      </option>
                    ))}
                  </Select>
                  {row.decisionKind === 'custom' ? (
                    <Select
                      aria-label={`${i + 1}. madde gerekli çoğunluk`}
                      value={row.majority}
                      invalid={Boolean(errors.agenda) && !row.majority}
                      onChange={(e) => patchRow(i, { majority: e.target.value as MajorityRule | '' })}
                    >
                      <option value="">Gerekli çoğunluğu seçin</option>
                      {MAJORITY_RULES.map((r) => (
                        <option key={r} value={r}>
                          {MAJORITY_LABELS[r]}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <p className="self-center text-xs text-muted">
                      {MAJORITY_LABELS[DECISION_PRESETS[row.decisionKind].rule]} ({DECISION_PRESETS[row.decisionKind].legal})
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ol>
          {errors.agenda?.message && <p className="text-small text-danger">{errors.agenda.message}</p>}
          {agenda.length < MAX_AGENDA_ITEMS && (
            <div>
              <Button size="xs" variant="subtle" onClick={() => setAgenda([...agenda, emptyAgendaRow()])}>
                <Plus className="size-3.5" aria-hidden="true" />
                Madde ekle
              </Button>
            </div>
          )}
        </fieldset>

        <p className="text-small text-muted">
          Hazirun cetveli toplantı günündeki mülkiyet kayıtlarından (oy listesi) hazırlanır. Oy listesi dondurulduktan sonra toplantı bilgileri ve gündem değiştirilemez; çağrı gönderildiyse
          değişiklikten sonra çağrıyı yeniden gönderin.
        </p>

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
