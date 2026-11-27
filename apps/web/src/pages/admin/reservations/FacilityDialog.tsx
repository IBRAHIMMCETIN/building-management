import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useSaveFacility } from '@/hooks/useReservations';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { type Facility, SLOT_LENGTHS } from '@/lib/api/reservations';
import type { Block } from '@/lib/api/units';
import { WEEKDAYS, formatMinutes } from '@/lib/reservations/model';
import { FACILITY_FIELD_MAP, FACILITY_FORM_FIELDS, type FacilityForm, type FacilityValues, facilityDefaults, facilitySchema, maxDurationChoices, toFacilityInput } from './schemas';

type Props = { open: boolean; onClose: () => void; facility?: Facility; blocks: Block[] };

const DEFAULT_INCOME = 'income-dues';

export function FacilityDialog({ open, onClose, facility, blocks }: Props) {
  const save = useSaveFacility();
  const [key, renewKey] = useIdempotencyKey();
  const incomeAccounts = useFinanceAccounts('income');
  const form = useForm<FacilityForm, unknown, FacilityValues>({ resolver: zodResolver(facilitySchema), defaultValues: facilityDefaults(facility) });
  const { errors } = form.formState;
  const slotMinutes = Number(form.watch('slotMinutes'));
  const days = form.watch('days');
  const selectedBlocks = form.watch('blockIds');
  const fee = form.watch('fee');

  useEffect(() => {
    if (!open) return;
    save.reset();
    renewKey();
    form.reset(facilityDefaults(facility));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, facility]);

  // Dilim uzunlugu degisince en uzun sure gecerli bir kata cekilir.
  useEffect(() => {
    const max = Number(form.getValues('maxBookingMinutes'));
    if (slotMinutes && (max < slotMinutes || max % slotMinutes)) form.setValue('maxBookingMinutes', String(slotMinutes));
  }, [slotMinutes, form]);

  const submit = form.handleSubmit(async (v) => {
    try {
      await save.mutateAsync({ ...(facility ? { id: facility.facilityId, version: facility.version } : {}), idempotencyKey: key, input: toFacilityInput(v) });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, FACILITY_FORM_FIELDS, FACILITY_FIELD_MAP);
    }
  });

  const toggleBlock = (blockId: string, checked: boolean) =>
    form.setValue('blockIds', checked ? [...selectedBlocks, blockId] : selectedBlocks.filter((id) => id !== blockId), { shouldDirty: true });
  const conflict = save.error instanceof ApiError && save.error.status === 409;
  const close = () => !save.isPending && onClose();

  return (
    <Dialog open={open} onClose={close} title={facility ? 'Ortak alanı düzenle' : 'Yeni ortak alan'} variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
          <Alert tone="danger">{conflict ? 'Ortak alan bu arada değiştirildi. Pencereyi kapatıp yeniden açın.' : errorMessage(save.error)}</Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-2">
            <FormField label="Ad" error={errors.name?.message}>
              <Input autoComplete="off" maxLength={80} placeholder="Örn. Toplantı salonu, tenis kortu" {...form.register('name')} />
            </FormField>
          </div>
          <FormField label="Kapasite (kişi)" error={errors.capacity?.message}>
            <Input inputMode="numeric" {...form.register('capacity')} />
          </FormField>
        </div>

        <FormField label="Açıklama (isteğe bağlı)" error={errors.description?.message} hint="Sakinlerin göreceği kullanım kuralları.">
          <Textarea rows={3} maxLength={500} {...form.register('description')} />
        </FormField>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Açılış saatleri</legend>
          <p className="text-small text-muted">Saatler :00 veya :30 olmalı. Gece yarısına kadar açık için kapanışı 00:00 girin.</p>
          <ul className="flex flex-col gap-2">
            {WEEKDAYS.map((d, i) => (
              <li key={d.day} className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <label className="inline-flex w-32 items-center gap-2 text-small">
                  <input type="checkbox" className="size-4 accent-accent" {...form.register(`days.${i}.enabled`)} />
                  {d.label}
                </label>
                {days[i]?.enabled ? (
                  <span className="flex items-center gap-2">
                    <Input type="time" step={1800} aria-label={`${d.label} açılış`} className="w-28" {...form.register(`days.${i}.open`)} />
                    <span className="text-muted">–</span>
                    <Input type="time" step={1800} aria-label={`${d.label} kapanış`} className="w-28" {...form.register(`days.${i}.close`)} />
                  </span>
                ) : (
                  <span className="text-small text-muted">Kapalı</span>
                )}
              </li>
            ))}
          </ul>
          {errors.days?.message && <p className="text-small text-danger">{errors.days.message}</p>}
          {errors.days?.root?.message && <p className="text-small text-danger">{errors.days.root.message}</p>}
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Dilim uzunluğu" error={errors.slotMinutes?.message}>
            <Select {...form.register('slotMinutes')}>
              {SLOT_LENGTHS.map((m) => (
                <option key={m} value={String(m)}>
                  {formatMinutes(m)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="En uzun rezervasyon" error={errors.maxBookingMinutes?.message}>
            <Select {...form.register('maxBookingMinutes')}>
              {maxDurationChoices(slotMinutes || 60).map((m) => (
                <option key={m} value={String(m)}>
                  {formatMinutes(m)}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Rezervasyon penceresi (gün)" error={errors.advanceDays?.message} hint="Sakin en fazla kaç gün sonrası için rezervasyon yapabilir.">
            <Input inputMode="numeric" {...form.register('advanceDays')} />
          </FormField>
          <FormField label="Daire başına aktif rezervasyon" error={errors.maxActivePerUnit?.message} hint="Bekleyen ve onaylı, henüz bitmemiş rezervasyonlar.">
            <Input inputMode="numeric" {...form.register('maxActivePerUnit')} />
          </FormField>
          <FormField label="Sakin iptali için en az (saat)" error={errors.cancelNoticeHours?.message} hint="Başlangıçtan bu kadar saat öncesine kadar sakin iptal edebilir.">
            <Input inputMode="numeric" {...form.register('cancelNoticeHours')} />
          </FormField>
          <FormField label="Ücret (TL, isteğe bağlı)" error={errors.fee?.message} hint="Onayda oturanın carisine borç olarak yazılır; iptalde ters kayıtla iade edilir.">
            <Input inputMode="decimal" placeholder="Ücretsiz" {...form.register('fee')} />
          </FormField>
          {fee && (
            <FormField label="Gelir hesabı" error={errors.incomeAccountId?.message}>
              <Select {...form.register('incomeAccountId')}>
                <option value="">Aidat Gelirleri</option>
                {(incomeAccounts.data ?? [])
                  .filter((a) => a.accountId !== 'income-late-fee' && a.accountId !== DEFAULT_INCOME)
                  .map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </FormField>
          )}
        </div>

        <label className="inline-flex items-center gap-2 text-body">
          <input type="checkbox" className="size-4 accent-accent" {...form.register('requiresApproval')} />
          Rezervasyonlar yönetici onayı gerektirsin
        </label>

        {blocks.length > 1 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small font-medium">Hangi bloklar kullanabilsin?</legend>
            <p className="text-small text-muted">Blok seçmezseniz tüm daireler rezervasyon yapabilir.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {blocks.map((b) => (
                <label key={b.blockId} className="inline-flex items-center gap-2 text-body">
                  <input type="checkbox" className="size-4 accent-accent" checked={selectedBlocks.includes(b.blockId)} onChange={(e) => toggleBlock(b.blockId, e.target.checked)} />
                  {b.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            {facility ? 'Kaydet' : 'Ortak alanı oluştur'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
