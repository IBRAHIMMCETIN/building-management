import { Lock } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, FormField, Input } from '@/components/ui';
import { useUpdatePaymentAccount } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { PlatformApartment } from '@/lib/api/payments';
import { MAX_PLATFORM_FEE_BASIS_POINTS, formatBasisPoints } from '@/lib/payments/manager';
import { type AccountForm, accountForm, buildAccountPatch, kurusToFeeInput, providerLabel } from '@/lib/payments/platform';

type Props = { apartment: PlatformApartment | null; onClose: () => void };
type Errors = Partial<Record<keyof AccountForm, string>>;

/** API alan adi -> form alani (400 yanitindaki `field`). */
const API_FIELDS: Record<string, keyof AccountForm> = {
  platformFeeBasisPoints: 'platformFee',
  posRateBasisPoints: 'posRate',
  posFixedFeeKurus: 'posFixed',
  iban: 'iban',
  accountHolderName: 'accountHolderName',
  invoiceRecipient: 'recipientTaxNumber',
};

/**
 * Platform yoneticisi: alt uye isyeri hesabinin ayarlari. Platform payi, POS komisyonu (bos =
 * ortam varsayilani), aktarim alicisi (tam IBAN + hesap sahibi; kaydedildikten sonra yalnizca
 * maskeli gorunur) ve komisyon faturasi muhatabi (VKN). Yalnizca degisen alanlar gonderilir.
 */
export function AccountSettingsDialog({ apartment, onClose }: Props) {
  const update = useUpdatePaymentAccount();
  const acc = apartment?.account ?? null;
  const [form, setForm] = useState<AccountForm | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!acc) return;
    setForm(accountForm(acc));
    setErrors({});
    setNotice(null);
    update.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [apartment?.apartmentId]);

  const set = <K extends keyof AccountForm>(key: K, value: AccountForm[K]) => {
    setForm((f) => (f ? { ...f, [key]: value } : f));
    setErrors((e) => ({ ...e, [key]: undefined }));
    setNotice(null);
  };

  const save = async () => {
    if (!apartment || !acc || !form) return;
    const r = buildAccountPatch(acc, form, MAX_PLATFORM_FEE_BASIS_POINTS);
    if (!r.ok) {
      setErrors(r.errors);
      return;
    }
    if (!r.changed) {
      setNotice('Değişiklik yok.');
      return;
    }
    try {
      await update.mutateAsync({ apartmentId: apartment.apartmentId, patch: r.patch });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.field && API_FIELDS[err.field]) {
        setErrors({ [API_FIELDS[err.field] as keyof AccountForm]: err.message });
      }
    }
  };

  const fees = acc?.effectiveFees;
  const fieldError = update.error instanceof ApiError && update.error.status === 400 && !!update.error.field && !!API_FIELDS[update.error.field];

  return (
    <Dialog open={apartment !== null && acc !== null} onClose={onClose} title="Ödeme hesabı ayarları" className="max-w-2xl">
      {acc && form && (
        <form
          className="flex flex-col gap-5"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="text-small text-muted">
            <strong className="text-text">{apartment?.name}</strong> · {providerLabel(acc.provider)} hesabı. Komisyon değişiklikleri bundan sonra
            başlatılan ödemelere uygulanır.
          </p>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-small font-semibold">Komisyon</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Platform payı (%)" error={errors.platformFee} hint={`KDV dahil; en fazla ${formatBasisPoints(MAX_PLATFORM_FEE_BASIS_POINTS)}`}>
                <Input inputMode="decimal" value={form.platformFee} onChange={(e) => set('platformFee', e.target.value)} />
              </FormField>
              <FormField
                label="POS oranı (%)"
                error={errors.posRate}
                hint={fees && acc.posRateBasisPoints === undefined ? `Boş: varsayılan ${formatBasisPoints(fees.posRateBasisPoints)}` : 'Boş: ortam varsayılanı'}
              >
                <Input inputMode="decimal" placeholder="varsayılan" value={form.posRate} onChange={(e) => set('posRate', e.target.value)} />
              </FormField>
              <FormField
                label="POS sabit ücret (₺)"
                error={errors.posFixed}
                hint={fees && acc.posFixedFeeKurus === undefined ? `Boş: varsayılan ₺${kurusToFeeInput(fees.posFixedFeeKurus)}` : 'Boş: ortam varsayılanı'}
              >
                <Input inputMode="decimal" placeholder="varsayılan" value={form.posFixed} onChange={(e) => set('posFixed', e.target.value)} />
              </FormField>
            </div>
            <p className="text-small text-muted">
              POS tutarı sağlayıcı sözleşmesindeki orandır; ödemede tahmini olarak apartman payından düşülür ve faturasını sağlayıcı keser. Platform
              komisyon faturası yalnızca platform payını kapsar.
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-small font-semibold">Aktarım hesabı</legend>
            <p className="text-small">
              Kayıtlı IBAN: <span className="font-mono">{acc.ibanMasked ?? '—'}</span>
              {acc.payeeOnFile === false && <span className="text-warning"> · şifreli alıcı kayıtlı değil (PayTR aktarımı yapılamaz)</span>}
            </p>
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={form.changePayee} onChange={(e) => set('changePayee', e.target.checked)} />
              IBAN ve hesap sahibini değiştir
            </label>
            {form.changePayee && (
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="IBAN (tam)" error={errors.iban}>
                  <Input
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="TR00 0000 0000 0000 0000 0000 00"
                    value={form.iban}
                    onChange={(e) => set('iban', e.target.value)}
                  />
                </FormField>
                <FormField label="Hesap sahibi adı" error={errors.accountHolderName} hint="Bankadaki ad/unvan ile aynı olmalı.">
                  <Input autoComplete="off" value={form.accountHolderName} onChange={(e) => set('accountHolderName', e.target.value)} />
                </FormField>
              </div>
            )}
            <p className="flex items-start gap-2 text-small text-muted">
              <Lock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Tam IBAN KMS ile şifrelenerek saklanır ve hiçbir ekranda geri gösterilmez. Yeni IBAN sonraki aktarımlardan itibaren kullanılır.
            </p>
          </fieldset>

          <fieldset className="flex flex-col gap-3">
            <legend className="mb-2 text-small font-semibold">Komisyon faturası muhatabı</legend>
            <div className="grid gap-4 sm:grid-cols-3">
              <FormField label="Unvan" error={errors.recipientTitle}>
                <Input autoComplete="off" value={form.recipientTitle} onChange={(e) => set('recipientTitle', e.target.value)} />
              </FormField>
              <FormField label="VKN" error={errors.recipientTaxNumber}>
                <Input
                  inputMode="numeric"
                  maxLength={10}
                  autoComplete="off"
                  value={form.recipientTaxNumber}
                  onChange={(e) => set('recipientTaxNumber', e.target.value)}
                />
              </FormField>
              <FormField label="Vergi dairesi" error={errors.recipientTaxOffice}>
                <Input autoComplete="off" value={form.recipientTaxOffice} onChange={(e) => set('recipientTaxOffice', e.target.value)} />
              </FormField>
            </div>
            <p className="text-small text-muted">
              VKN yoksa fatura taslağı “VKN eksik” olarak kalır. Girdikten sonra Komisyon Faturaları ekranında taslağı yenileyin. Üç alanı da boşaltmak
              muhatabı kaldırır.
            </p>
          </fieldset>

          {notice && <Alert>{notice}</Alert>}
          {update.isError && !fieldError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button type="submit" loading={update.isPending}>
              Kaydet
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
