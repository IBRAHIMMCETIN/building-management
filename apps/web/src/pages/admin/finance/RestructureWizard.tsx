import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreatePlan, usePlanOpenItems, usePlanPreview } from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import type { PlanInput, PlanRule } from '@/lib/api/restructure';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { DEFAULT_RULE, MAX_INSTALLMENTS, defaultFirstDueDate, planDraftErrors, reasonError, ruleErrors, ruleText, splitEven } from '@/lib/restructure/model';

export type RestructurePreset = { unitId?: string; accountId?: string };
type Props = { open: boolean; onClose: () => void; preset?: RestructurePreset | null };

const STEPS = [
  { id: 'account', label: 'Cari' },
  { id: 'items', label: 'Kalemler' },
  { id: 'terms', label: 'Taksitler' },
  { id: 'review', label: 'Önizleme' },
] as const;
type Step = (typeof STEPS)[number]['id'];

const istanbulToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

/**
 * Finans 2.2 - Borc yapilandirma sihirbazi: cari -> acik kalemler (+ dondurulacak tazminat) ->
 * taksit sayisi / ilk vade / muacceliyet esikleri -> API onizlemesi (kurus kayipsiz tablo) -> onay.
 */
export function RestructureWizard({ open, onClose, preset }: Props) {
  const accounts = useFinanceAccounts('receivable');
  const create = useCreatePlan();
  const [key, renewKey] = useIdempotencyKey();
  const [step, setStep] = useState<Step>('account');
  const [accountId, setAccountId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [includeLateFees, setIncludeLateFees] = useState(true);
  const [installments, setInstallments] = useState(6);
  const [firstDueDate, setFirstDueDate] = useState('');
  const [rule, setRule] = useState<PlanRule>(DEFAULT_RULE);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setAccountId(preset?.accountId ?? '');
    setStep(preset?.accountId ? 'items' : 'account');
    setSelected([]);
    setIncludeLateFees(true);
    setInstallments(6);
    setFirstDueDate(defaultFirstDueDate(istanbulToday()));
    setRule(DEFAULT_RULE);
    setReason('');
    setTouched(false);
    create.reset();
    renewKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  const options = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => a.unitId && a.balance > 0 && (!preset?.unitId || a.unitId === preset.unitId))
        .sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true })),
    [accounts.data, preset?.unitId],
  );
  const open_ = usePlanOpenItems(open ? accountId : '');
  const data = open_.data;
  const today = data?.date ?? istanbulToday();
  const items = (data?.items ?? []).filter((i) => !i.planId);
  const draftErrors = planDraftErrors({ selected, installments, firstDueDate, today, rule });
  const rErrors = ruleErrors(rule);
  const input: PlanInput | null =
    step === 'review' && Object.keys(draftErrors).length === 0 ? { accountId, chargeIds: selected, installments, firstDueDate, includeLateFees, rule } : null;
  const preview = usePlanPreview(input);
  const selectedTotal = items.filter((i) => selected.includes(i.chargeId)).reduce((s, i) => s + i.remaining, 0);
  const estimatedTotal = selectedTotal + (includeLateFees ? (data?.accruedLateFee ?? 0) : 0);
  const estimate = splitEven(estimatedTotal, installments)[0] ?? 0;
  const setRuleField = (k: keyof PlanRule, v: number | boolean) => setRule((r) => ({ ...r, [k]: v }));
  const idx = STEPS.findIndex((s) => s.id === step);

  const submit = async () => {
    setTouched(true);
    if (!input || reasonError(reason)) return;
    try {
      await create.mutateAsync({ ...input, idempotencyKey: key, reason: reason.trim() });
      onClose();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Borç yapılandırma" className="max-w-2xl">
      <div className="flex flex-col gap-4">
        <ol className="flex flex-wrap gap-2 text-xs" aria-label="Adımlar">
          {STEPS.map((s, i) => (
            <li key={s.id} aria-current={s.id === step ? 'step' : undefined}>
              <Badge tone={s.id === step ? 'accent' : i < idx ? 'success' : 'neutral'}>
                {i + 1}. {s.label}
              </Badge>
            </li>
          ))}
        </ol>

        {step === 'account' && (
          <div className="flex flex-col gap-3">
            {accounts.isError && <Alert tone="danger">{errorMessage(accounts.error)}</Alert>}
            {accounts.isSuccess && options.length === 0 && <Alert>Borcu olan cari bulunamadı.</Alert>}
            <FormField label="Yapılandırılacak cari">
              <Select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Cari">
                <option value="">Seçin</option>
                {options.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name} · borç {formatTRY(a.balance)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        )}

        {step === 'items' && (
          <div className="flex flex-col gap-3">
            {open_.isPending && <Spinner />}
            {open_.isError && <Alert tone="danger">{errorMessage(open_.error)}</Alert>}
            {data?.activePlanId && <Alert tone="danger">Bu caride zaten aktif bir yapılandırma planı var. Önce o planı kapatın veya iptal edin.</Alert>}
            {data && !data.activePlanId && items.length === 0 && <Alert>Bu caride açık borç kalemi yok.</Alert>}
            {data && !data.activePlanId && items.length > 0 && (
              <>
                <div className="flex items-center justify-between gap-2 text-small">
                  <span className="font-medium">Açık kalemler</span>
                  <Button variant="ghost" size="xs" onClick={() => setSelected(selected.length === items.length ? [] : items.map((i) => i.chargeId))}>
                    {selected.length === items.length ? 'Seçimi kaldır' : 'Tümünü seç'}
                  </Button>
                </div>
                <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Açık kalemler">
                  {items.map((i) => (
                    <li key={i.chargeId}>
                      <label className="flex items-center justify-between gap-3 px-3 py-2 text-small">
                        <span className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            value={i.chargeId}
                            checked={selected.includes(i.chargeId)}
                            onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, i.chargeId] : cur.filter((x) => x !== i.chargeId)))}
                          />
                          <span>
                            {i.description}
                            <span className="block text-xs text-muted">
                              Vade {formatDate(i.dueDate)}
                              {i.overdue ? ' · gecikmede' : ''}
                              {i.lateFee ? ' · gecikme tazminatı' : ''}
                            </span>
                          </span>
                        </span>
                        <span className="tabular-nums">{formatTRY(i.remaining)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
                <div className="rounded-lg border border-border bg-surface-muted/40 p-3 text-small">
                  <p>
                    Bugüne kadar işlemiş gecikme tazminatı: <strong className="tabular-nums">{formatTRY(data.accruedLateFee)}</strong>. Yapılandırmayla
                    kesinleşir ve dondurulur; seçilen kalemlere bundan sonra tazminat işlemez.
                  </p>
                  <label className="mt-2 flex items-center gap-2">
                    <input type="checkbox" checked={includeLateFees} onChange={(e) => setIncludeLateFees(e.target.checked)} />
                    Dondurulan tazminatı taksitlere dahil et (taksitlere yalnızca anapara payı üzerinden tazminat işler)
                  </label>
                </div>
                <p className="text-small text-muted">Seçilen: {formatTRY(selectedTotal)}</p>
              </>
            )}
          </div>
        )}

        {step === 'terms' && (
          <div className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label={`Taksit sayısı (1-${MAX_INSTALLMENTS})`} error={draftErrors.installments}>
                <Input type="number" min={1} max={MAX_INSTALLMENTS} value={String(installments)} onChange={(e) => setInstallments(Number(e.target.value))} aria-label="Taksit sayısı" />
              </FormField>
              <FormField label="İlk taksit vadesi" error={draftErrors.firstDueDate} hint="Sonraki taksitler her ay aynı gün">
                <Input type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} aria-label="İlk taksit vadesi" />
              </FormField>
            </div>
            {installments >= 1 && estimatedTotal > 0 && (
              <p className="text-small text-muted">
                Yaklaşık aylık taksit: {formatTRY(estimate)} (kesin tablo önizlemede, kuruş kaybı olmadan).
              </p>
            )}
            <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <legend className="px-1 text-small font-medium">Muacceliyet (temerrüt) koşulu</legend>
              <div className="grid gap-3 sm:grid-cols-3">
                <FormField label="Ardışık geciken taksit" error={rErrors.consecutive}>
                  <Input type="number" min={1} value={String(rule.consecutive)} onChange={(e) => setRuleField('consecutive', Number(e.target.value))} aria-label="Ardışık geciken taksit" />
                </FormField>
                <FormField label="Toplam geciken taksit" error={rErrors.total}>
                  <Input type="number" min={1} value={String(rule.total)} onChange={(e) => setRuleField('total', Number(e.target.value))} aria-label="Toplam geciken taksit" />
                </FormField>
                <FormField label="Ek süre (gün)" error={rErrors.graceDays}>
                  <Input type="number" min={0} value={String(rule.graceDays)} onChange={(e) => setRuleField('graceDays', Number(e.target.value))} aria-label="Ek süre" />
                </FormField>
              </div>
              <label className="flex items-start gap-2 text-small">
                <input type="checkbox" className="mt-1" checked={rule.autoAccelerate} onChange={(e) => setRuleField('autoAccelerate', e.target.checked)} />
                Temerrütte plan otomatik muaccel olsun (kapalıysa sakine bildirim gider, muaccel kılma yönetici onayıyla yapılır)
              </label>
              <p className="text-xs text-muted">{ruleText(rule)}.</p>
            </fieldset>
          </div>
        )}

        {step === 'review' && (
          <div className="flex flex-col gap-3">
            {preview.isFetching && !preview.data && <Spinner />}
            {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
            {preview.data && (
              <>
                <dl className="grid grid-cols-3 gap-2 text-small" aria-label="Plan özeti">
                  <div className="rounded-md bg-surface-muted p-2">
                    <dt className="text-muted">Plan toplamı</dt>
                    <dd className="font-semibold tabular-nums">{formatTRY(preview.data.total)}</dd>
                  </div>
                  <div className="rounded-md bg-surface-muted p-2">
                    <dt className="text-muted">Dondurulan tazminat</dt>
                    <dd className="font-semibold tabular-nums">{formatTRY(preview.data.frozenLateFee)}</dd>
                  </div>
                  <div className="rounded-md bg-surface-muted p-2">
                    <dt className="text-muted">Tazminat tabanı</dt>
                    <dd className="font-semibold tabular-nums">{formatTRY(preview.data.feeBaseTotal)}</dd>
                  </div>
                </dl>
                <table className="w-full text-small" aria-label="Taksit tablosu">
                  <thead>
                    <tr className="text-left text-muted">
                      <th className="py-1">No</th>
                      <th>Vade</th>
                      <th className="text-right">Tutar</th>
                      <th className="text-right">Tazminat tabanı</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.installments.map((i) => (
                      <tr key={i.no} className="border-t border-border">
                        <td className="py-1">{i.no}</td>
                        <td>{formatDate(i.dueDate)}</td>
                        <td className="text-right tabular-nums">{formatTRY(i.amount)}</td>
                        <td className="text-right tabular-nums">{formatTRY(i.feeBase)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <FormField label="Gerekçe" error={touched ? reasonError(reason) : undefined}>
                  <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Sakin 6 taksit talep etti, yönetim kurulu onayladı" />
                </FormField>
              </>
            )}
            {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          </div>
        )}

        <div className="flex flex-wrap justify-between gap-2">
          <Button variant="ghost" onClick={idx === 0 || (idx === 1 && preset?.accountId) ? onClose : () => setStep(STEPS[idx - 1]!.id)}>
            {idx === 0 || (idx === 1 && preset?.accountId) ? 'Vazgeç' : 'Geri'}
          </Button>
          {step === 'account' && (
            <Button disabled={!accountId} onClick={() => setStep('items')}>
              Devam
            </Button>
          )}
          {step === 'items' && (
            <Button disabled={!data || !!data.activePlanId || selected.length === 0} onClick={() => setStep('terms')}>
              Devam
            </Button>
          )}
          {step === 'terms' && (
            <Button disabled={Object.keys(draftErrors).length > 0} onClick={() => setStep('review')}>
              Önizle
            </Button>
          )}
          {step === 'review' && (
            <Button loading={create.isPending} disabled={!preview.data || preview.isFetching} onClick={() => void submit()}>
              Planı oluştur
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
