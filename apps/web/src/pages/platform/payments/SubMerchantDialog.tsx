import { zodResolver } from '@hookform/resolvers/zod';
import { Lock } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Dialog, FormField, Input, Select } from '@/components/ui';
import { useOnboardSubMerchant } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import { SUB_MERCHANT_TYPES, type PlatformApartment } from '@/lib/api/payments';
import {
  SUB_MERCHANT_FIELD_MAP,
  SUB_MERCHANT_TYPE_LABELS,
  type SubMerchantForm,
  emptySubMerchantForm,
  subMerchantFormSchema,
  toSubMerchantInput,
} from '@/lib/payments/subMerchant';

type Props = { apartment: PlatformApartment | null; sandbox: boolean; onClose: () => void };

const FIELDS = [
  'subMerchantType',
  'name',
  'email',
  'gsmNumber',
  'address',
  'iban',
  'taxOffice',
  'taxNumber',
  'legalCompanyTitle',
  'contactName',
  'contactSurname',
  'identityNumber',
  'platformFee',
] as const;

/** Apartmani odeme saglayicisinda alt uye isyeri olarak kaydeder (tek seferlik). */
export function SubMerchantDialog({ apartment, sandbox, onClose }: Props) {
  const onboard = useOnboardSubMerchant();
  const form = useForm<SubMerchantForm>({ resolver: zodResolver(subMerchantFormSchema), defaultValues: emptySubMerchantForm() });
  const { errors } = form.formState;
  const type = form.watch('subMerchantType');
  const personal = type === 'PERSONAL';
  const open = apartment !== null;

  useEffect(() => {
    if (!open) return;
    onboard.reset();
    form.reset({ ...emptySubMerchantForm(), name: apartment?.name ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  const submit = form.handleSubmit(async (values) => {
    if (!apartment) return;
    try {
      await onboard.mutateAsync({ apartmentId: apartment.apartmentId, input: toSubMerchantInput(values) });
      onClose();
    } catch (err) {
      applyApiFieldError(err, form.setError, FIELDS, SUB_MERCHANT_FIELD_MAP);
    }
  });

  const fieldErr = onboard.error instanceof ApiError && onboard.error.status === 400 && !!onboard.error.field;

  return (
    <Dialog open={open} onClose={onClose} title="Ödeme hesabı aç" className="max-w-2xl">
      <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
        <p className="text-small text-muted">
          <strong className="text-text">{apartment?.name}</strong> ({apartment?.district} / {apartment?.city}) ödeme sağlayıcısında alt üye
          işyeri olarak kaydedilir. Tahsilatlar aşağıdaki IBAN’a aktarılır.
        </p>
        {sandbox && <Alert>Test ortamı: kayıt sandbox hesabına yapılır, gerçek para aktarımı olmaz.</Alert>}

        <FormField label="İşyeri türü" error={errors.subMerchantType?.message}>
          <Select {...form.register('subMerchantType')}>
            {SUB_MERCHANT_TYPES.map((t) => (
              <option key={t} value={t}>
                {SUB_MERCHANT_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </FormField>

        {personal ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Ad" error={errors.contactName?.message}>
              <Input autoComplete="off" {...form.register('contactName')} />
            </FormField>
            <FormField label="Soyad" error={errors.contactSurname?.message}>
              <Input autoComplete="off" {...form.register('contactSurname')} />
            </FormField>
            <FormField label="T.C. kimlik no" error={errors.identityNumber?.message}>
              <Input inputMode="numeric" maxLength={11} autoComplete="off" {...form.register('identityNumber')} />
            </FormField>
          </div>
        ) : (
          <>
            <FormField label="Ticari unvan" error={errors.legalCompanyTitle?.message}>
              <Input autoComplete="off" {...form.register('legalCompanyTitle')} />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Vergi dairesi" error={errors.taxOffice?.message}>
                <Input autoComplete="off" {...form.register('taxOffice')} />
              </FormField>
              <FormField
                label={type === 'LIMITED_OR_JOINT_STOCK_COMPANY' ? 'Vergi no' : 'Vergi no (isteğe bağlı)'}
                error={errors.taxNumber?.message}
              >
                <Input inputMode="numeric" maxLength={10} autoComplete="off" {...form.register('taxNumber')} />
              </FormField>
            </div>
          </>
        )}

        <FormField label="İşyeri adı (isteğe bağlı)" error={errors.name?.message}>
          <Input autoComplete="off" {...form.register('name')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="E-posta" error={errors.email?.message}>
            <Input type="email" autoComplete="off" {...form.register('email')} />
          </FormField>
          <FormField label="Cep telefonu" error={errors.gsmNumber?.message}>
            <Input inputMode="tel" autoComplete="off" placeholder="05xx xxx xx xx" {...form.register('gsmNumber')} />
          </FormField>
        </div>
        <FormField label="Adres" error={errors.address?.message}>
          <Input autoComplete="off" {...form.register('address')} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <FormField label="IBAN" error={errors.iban?.message}>
            <Input autoComplete="off" placeholder="TR00 0000 0000 0000 0000 0000 00" {...form.register('iban')} />
          </FormField>
          <FormField label="Platform payı (%)" error={errors.platformFee?.message} hint="Her tahsilattan apartman payından kesilir.">
            <Input inputMode="decimal" autoComplete="off" {...form.register('platformFee')} />
          </FormField>
        </div>

        <p className="flex items-start gap-2 text-small text-muted">
          <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          Vergi, kimlik ve IBAN bilgileri yalnızca ödeme sağlayıcısına iletilir; sistemde maskeli IBAN, işyeri türü ve platform payı saklanır.
        </p>

        {onboard.isError && !fieldErr && <Alert tone="danger">{errorMessage(onboard.error)}</Alert>}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={onboard.isPending}>
            Kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
