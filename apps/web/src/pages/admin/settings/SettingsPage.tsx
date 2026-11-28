import { zodResolver } from '@hookform/resolvers/zod';
import { CalendarClock, Save } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { Alert, Button, Card, CardTitle, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useSite, useSitePermissions, useUpdateSiteSettings } from '@/hooks/useSite';
import { useUnits } from '@/hooks/useUnits';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { applyApiFieldError } from '@/lib/api/formErrors';
import type { Site } from '@/lib/api/sites';
import { formatTRY, parseTRYToKurus } from '@/lib/money';
import { AccountChartCard } from './AccountChartCard';
import { SiteFeaturesCard } from './SiteFeaturesCard';
import {
  SETTINGS_FIELD_MAP,
  STATUTORY_LATE_FEE_BP,
  type SettingsForm,
  type SettingsValues,
  formDefaults,
  parsePercentToBasisPoints,
  settingsSchema,
  toUpdateInput,
} from './schemas';

const KEY_LABELS = { equal: 'Eşit (daire başına)', area: 'Metrekareye göre', land_share: 'Arsa payına göre' } as const;
const PARTY_LABELS = {
  occupant: 'Oturan (kiracı, yoksa malik) — işletme gideri',
  owner: 'Kat maliki — demirbaş / yatırım gideri',
} as const;

const FIELDS = ['dueDayOfMonth', 'lateFeeRate', 'planAmount', 'planKey', 'planParty', 'planIncomeAccountId'] as const;

export function SettingsPage() {
  const { canRead, canWrite } = useSitePermissions();
  const site = useSite();

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Ayarlar</h1>
        <Alert>Bu rol apartman ayarlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="text-title font-bold">Ayarlar</h1>
        <p className="text-small text-muted">Aidat vadesi, gecikme tazminatı, otomatik aylık aidat, hesap planı ve site özellikleri.</p>
      </div>
      {site.isPending ? (
        <Card role="status" aria-label="Ayarlar yükleniyor" className="flex flex-col gap-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </Card>
      ) : site.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(site.error)}</Alert>
          <Button variant="secondary" onClick={() => void site.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      ) : (
        <SettingsFormView site={site.data} readOnly={!canWrite} />
      )}
      <AccountChartCard canWrite={canWrite} />
      <SiteFeaturesCard />
    </div>
  );
}

function SettingsFormView({ site, readOnly }: { site: Site; readOnly: boolean }) {
  const update = useUpdateSiteSettings();
  const units = useUnits();
  const incomeAccounts = useFinanceAccounts('income');
  const form = useForm<SettingsForm, unknown, SettingsValues>({
    resolver: zodResolver(settingsSchema),
    defaultValues: formDefaults(site),
  });
  const { errors, isDirty } = form.formState;

  // Kayit (veya 409 sonrasi yenilenen kayit) gelince form o surume esitlenir.
  useEffect(() => {
    form.reset(formDefaults(site));
  }, [site, form]);

  const [enabled, rateText, amountText, key, dueDay] = form.watch(['planEnabled', 'lateFeeRate', 'planAmount', 'planKey', 'dueDayOfMonth']);
  const rate = parsePercentToBasisPoints(rateText);
  const amount = parseTRYToKurus(amountText);
  const activeUnits = units.data?.summary.activeUnitCount;
  const perUnit = useMemo(
    () => (enabled && amount && key === 'equal' && activeUnits ? Math.floor(amount / activeUnits) : null),
    [enabled, amount, key, activeUnits],
  );

  const conflict = update.error instanceof ApiError && update.error.status === 409;

  const submit = form.handleSubmit(async (v) => {
    try {
      await update.mutateAsync(toUpdateInput(v, site.version, site.settings.monthlyDuesPlan));
    } catch (err) {
      applyApiFieldError(err, form.setError, FIELDS, SETTINGS_FIELD_MAP);
    }
  });

  return (
    <form noValidate onSubmit={submit} className="flex flex-col gap-6">
      {update.isError && !Object.values(errors).some((e) => e?.type === 'server') && (
        <Alert tone="danger">
          {conflict ? 'Ayarlar bu arada başka biri tarafından değiştirildi. Güncel hali yüklendi; kontrol edip tekrar kaydedin.' : errorMessage(update.error)}
        </Alert>
      )}
      {update.isSuccess && !isDirty && <Alert tone="success">Ayarlar kaydedildi.</Alert>}
      {readOnly && <Alert>Salt okunur görünüm: ayarları yalnızca apartman yöneticisi değiştirebilir.</Alert>}

      <fieldset disabled={readOnly || update.isPending} className="flex flex-col gap-6">
        <Card className="flex flex-col gap-4">
          <CardTitle>Vade ve gecikme tazminatı</CardTitle>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Son ödeme günü (her ay)" error={errors.dueDayOfMonth?.message} hint="1–28 arası.">
              <Input inputMode="numeric" autoComplete="off" {...form.register('dueDayOfMonth')} />
            </FormField>
            <FormField
              label="Aylık gecikme tazminatı (%)"
              error={errors.lateFeeRate?.message}
              hint="Gecikilen her gün için aylık oran ÷ 30 (kıstelyevm). Varsayılan %5."
            >
              <Input inputMode="decimal" autoComplete="off" {...form.register('lateFeeRate')} />
            </FormField>
          </div>
          {rate !== null && rate !== STATUTORY_LATE_FEE_BP && (
            <Alert>
              Kat Mülkiyeti Kanunu m.20 aylık %5 öngörür. %5’ten farklı bir oran uygulamadan önce yönetim planınızı ve hukuki
              danışmanınızı kontrol edin.
            </Alert>
          )}
          <p className="text-small text-muted">
            İşleyen tazminat ekranlarda anlık gösterilir; her ayın 1’inde önceki ayın tutarı sakinin carisine tek kayıt olarak yazılır.
            Kısmi ödemeler önce en eski aidatı kapatır.
          </p>
        </Card>

        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <CardTitle>Otomatik aylık aidat</CardTitle>
            <label className="inline-flex items-center gap-2 text-body">
              <input type="checkbox" className="size-4 accent-accent" {...form.register('planEnabled')} />
              Açık
            </label>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Aylık toplam tutar (₺)" error={errors.planAmount?.message}>
              <Input inputMode="decimal" autoComplete="off" placeholder="Örn. 15.000,00" {...form.register('planAmount')} />
            </FormField>
            <FormField
              label="Dağıtım anahtarı"
              error={errors.planKey?.message}
              hint={site.settings.landShareEnabled ? undefined : 'Arsa payı anahtarı bu apartmanda kapalı.'}
            >
              <Select {...form.register('planKey')}>
                {(['equal', 'area', 'land_share'] as const).map((k) => (
                  <option key={k} value={k} disabled={k === 'land_share' && !site.settings.landShareEnabled}>
                    {KEY_LABELS[k]}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField
            label="Gelir hesabı"
            error={errors.planIncomeAccountId?.message}
            hint={site.settings.monthlyDuesPlan?.budgetId ? `Plan ${site.settings.monthlyDuesPlan.budgetId} bütçesinden uygulandı.` : undefined}
          >
            <Select {...form.register('planIncomeAccountId')}>
              {(incomeAccounts.data ?? [])
                .filter((a) => a.accountId !== 'income-late-fee')
                .map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name}
                  </option>
                ))}
              {!incomeAccounts.data && <option value={form.getValues('planIncomeAccountId')}>Aidat Gelirleri</option>}
            </Select>
          </FormField>
          <FormField label="Borçlandırılan taraf" error={errors.planParty?.message}>
            <Select {...form.register('planParty')}>
              {(['occupant', 'owner'] as const).map((p) => (
                <option key={p} value={p}>
                  {PARTY_LABELS[p]}
                </option>
              ))}
            </Select>
          </FormField>

          {enabled && amount ? (
            <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-2 text-small">
              <CalendarClock className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden="true" />
              <span>
                Her ayın 1’inde saat 03:00’te {formatTRY(amount)} aktif dairelere {KEY_LABELS[key].toLocaleLowerCase('tr')} dağıtılır
                {perUnit !== null ? ` (daire başı yaklaşık ${formatTRY(perUnit)})` : ''}; son ödeme ayın {dueDay || '…'}’i.
              </span>
            </p>
          ) : (
            <p className="text-small text-muted">Kapalıyken aidatı Finans ekranından elle tahakkuk edersiniz.</p>
          )}
        </Card>
      </fieldset>

      {!readOnly && (
        <div className="flex justify-end gap-2">
          <Button variant="ghost" disabled={!isDirty || update.isPending} onClick={() => form.reset(formDefaults(site))}>
            Vazgeç
          </Button>
          <Button type="submit" loading={update.isPending} disabled={!isDirty}>
            <Save className="size-4" aria-hidden="true" />
            Kaydet
          </Button>
        </div>
      )}
    </form>
  );
}
