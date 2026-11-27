import { zodResolver } from '@hookform/resolvers/zod';
import { type ChangeEvent, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useSaveEquipment } from '@/hooks/useEquipment';
import { useFinanceAccounts } from '@/hooks/useFinance';
import type { Equipment } from '@/lib/api/equipment';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import type { Block } from '@/lib/api/units';
import { EQUIPMENT_CATEGORIES, EQUIPMENT_CATEGORY_LABELS, INSPECTION_LABELS, INSPECTION_LABEL_TEXT } from '@/lib/equipment/model';
import { EQUIPMENT_FIELD_MAP, EQUIPMENT_FORM_FIELDS, type EquipmentForm, type EquipmentValues, equipmentDefaults, equipmentFormSchema, toEquipmentInput } from './schemas';

type Props = { open: boolean; onClose: () => void; equipment?: Equipment; blocks: Block[]; onSaved?: (id: string) => void };

/** Ekipman kaydi / duzenleme (yonetim). Surum catismasinda (409) pencere yeniden acilmali. */
export function EquipmentDialog({ open, onClose, equipment, blocks, onSaved }: Props) {
  const save = useSaveEquipment();
  const suppliers = useFinanceAccounts('payable');
  const form = useForm<EquipmentForm, unknown, EquipmentValues>({ resolver: zodResolver(equipmentFormSchema), defaultValues: equipmentDefaults(equipment) });
  const { errors } = form.formState;

  useEffect(() => {
    if (!open) return;
    save.reset();
    form.reset(equipmentDefaults(equipment));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, equipment]);

  const submit = form.handleSubmit(async (v) => {
    try {
      const r = await save.mutateAsync({ ...(equipment ? { id: equipment.equipmentId, version: equipment.version } : {}), input: toEquipmentInput(v) });
      onClose();
      onSaved?.(r.equipment.equipmentId);
    } catch (err) {
      applyApiFieldError(err, form.setError, EQUIPMENT_FORM_FIELDS, EQUIPMENT_FIELD_MAP);
    }
  });

  const conflict = save.error instanceof ApiError && save.error.status === 409;
  const close = () => !save.isPending && onClose();
  const currentSupplier = equipment?.serviceCompany?.supplierAccountId;
  const supplierField = form.register('supplierAccountId');
  /** Cari degisince firma adi yeni carinin adiyla yenilenir (elle degistirilebilir); cari kaldirilinca ad kalir. */
  const changeSupplier = async (ev: ChangeEvent<HTMLSelectElement>) => {
    await supplierField.onChange(ev);
    const picked = (suppliers.data ?? []).find((a) => a.accountId === ev.target.value);
    if (picked) form.setValue('serviceName', picked.name, { shouldDirty: true });
  };

  return (
    <Dialog open={open} onClose={close} title={equipment ? 'Ekipmanı düzenle' : 'Yeni ekipman'} variant="wide">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        {save.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
          <Alert tone="danger">{conflict ? 'Ekipman kaydı bu arada değiştirildi. Pencereyi kapatıp yeniden açın.' : errorMessage(save.error)}</Alert>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Ad" error={errors.name?.message}>
            <Input autoComplete="off" maxLength={120} placeholder="Örn. A Blok asansörü" {...form.register('name')} />
          </FormField>
          <FormField label="Kategori" error={errors.category?.message}>
            <Select {...form.register('category')}>
              {EQUIPMENT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {EQUIPMENT_CATEGORY_LABELS[c]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Blok (isteğe bağlı)" error={errors.blockId?.message} hint="Boş bırakırsanız site geneli sayılır.">
            <Select {...form.register('blockId')}>
              <option value="">Site geneli</option>
              {blocks.map((b) => (
                <option key={b.blockId} value={b.blockId}>
                  {b.name}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Konum (isteğe bağlı)" error={errors.location?.message}>
            <Input autoComplete="off" maxLength={120} placeholder="Örn. bodrum kat makine dairesi" {...form.register('location')} />
          </FormField>
          <FormField label="Marka (isteğe bağlı)" error={errors.brand?.message}>
            <Input autoComplete="off" maxLength={80} {...form.register('brand')} />
          </FormField>
          <FormField label="Model (isteğe bağlı)" error={errors.model?.message}>
            <Input autoComplete="off" maxLength={80} {...form.register('model')} />
          </FormField>
          <FormField label="Seri no (isteğe bağlı)" error={errors.serialNumber?.message}>
            <Input autoComplete="off" maxLength={80} {...form.register('serialNumber')} />
          </FormField>
          <FormField label="Kurulum / devreye alma (isteğe bağlı)" error={errors.installDate?.message}>
            <Input type="date" {...form.register('installDate')} />
          </FormField>
          <FormField label="Garanti bitişi (isteğe bağlı)" error={errors.warrantyEndDate?.message} hint="30 gün kala günlük özete ve bu ekrana düşer.">
            <Input type="date" {...form.register('warrantyEndDate')} />
          </FormField>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Servis firması</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Tedarikçi carisi (isteğe bağlı)" error={errors.supplierAccountId?.message} hint="Finans’taki tedarikçi hesabına bağlar.">
              <Select {...supplierField} onChange={(ev) => void changeSupplier(ev)}>
                <option value="">—</option>
                {/* Bagli cari Finans'ta pasife alinmis olabilir: secili kalir, kayit engellenmez. */}
                {currentSupplier && !(suppliers.data ?? []).some((a) => a.accountId === currentSupplier) && (
                  <option value={currentSupplier}>{`${equipment?.serviceCompany?.name ?? 'Tedarikçi carisi'} (pasif)`}</option>
                )}
                {(suppliers.data ?? []).map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Firma adı (isteğe bağlı)" error={errors.serviceName?.message} hint="Boşsa tedarikçi carisinin adı kullanılır.">
              <Input autoComplete="off" maxLength={120} {...form.register('serviceName')} />
            </FormField>
            <FormField label="Telefon (isteğe bağlı)" error={errors.servicePhone?.message}>
              <Input type="tel" autoComplete="off" maxLength={30} {...form.register('servicePhone')} />
            </FormField>
            <FormField label="E-posta (isteğe bağlı)" error={errors.serviceEmail?.message}>
              <Input type="email" autoComplete="off" maxLength={120} {...form.register('serviceEmail')} />
            </FormField>
            <FormField label="Servis sözleşmesi bitişi (isteğe bağlı)" error={errors.serviceContractEndDate?.message}>
              <Input type="date" {...form.register('serviceContractEndDate')} />
            </FormField>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium">Periyodik kontrol</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Son kontrol" error={errors.lastInspectionDate?.message}>
              <Input type="date" {...form.register('lastInspectionDate')} />
            </FormField>
            <FormField label="Sonraki kontrol" error={errors.nextInspectionDate?.message}>
              <Input type="date" {...form.register('nextInspectionDate')} />
            </FormField>
            <FormField label="Etiket" error={errors.inspectionLabel?.message}>
              <Select {...form.register('inspectionLabel')}>
                <option value="">—</option>
                {INSPECTION_LABELS.map((l) => (
                  <option key={l} value={l}>
                    {INSPECTION_LABEL_TEXT[l]}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        </fieldset>

        <FormField label="Not (isteğe bağlı)" error={errors.notes?.message}>
          <Textarea rows={3} maxLength={2000} {...form.register('notes')} />
        </FormField>

        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={close} disabled={save.isPending}>
            Vazgeç
          </Button>
          <Button type="submit" loading={save.isPending}>
            {equipment ? 'Kaydet' : 'Ekipmanı kaydet'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
