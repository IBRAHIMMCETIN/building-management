import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useBillingAction } from '@/hooks/useSubscriptions';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { PLAN_FEATURES, PRICING_MODELS, type Plan, type PricingModel } from '@/lib/api/subscriptions';
import { noteError } from '@/lib/payments/review';
import { FEATURE_LABELS, MODEL_LABELS, type PlanDraft, type PlanDraftErrors, draftFromPlan, emptyPlanDraft, planInputFromDraft } from '@/lib/subscriptions/model';

/**
 * Platform: plan olusturma / duzenleme. Duzenleme yeni, degismez bir plan surumu acar; mevcut
 * abonelikler kendi anlik goruntusunu korur (yeni fiyat yeni aboneliklere ve plan degisikligine).
 * Tutarlar KDV haric TL olarak girilir, kurusa kayan nokta olmadan cevrilir.
 */
export function PlanEditorDialog({ open, plan, onClose }: { open: boolean; plan: Plan | null; onClose: () => void }) {
  const action = useBillingAction();
  const [key, renewKey] = useIdempotencyKey();
  const [draft, setDraft] = useState<PlanDraft>(emptyPlanDraft);
  const [errors, setErrors] = useState<PlanDraftErrors>({});
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | undefined>();
  const editing = plan !== null;

  useEffect(() => {
    if (!open) return;
    setDraft(plan ? draftFromPlan(plan) : emptyPlanDraft());
    setErrors({});
    setReason('');
    setReasonError(undefined);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open, plan]);

  const set = <K extends keyof PlanDraft>(k: K, v: PlanDraft[K]) => {
    setDraft((d) => ({ ...d, [k]: v }));
    setErrors((e) => ({ ...e, [k]: undefined }));
  };

  const submit = async () => {
    const { input, errors: found } = planInputFromDraft(draft);
    const why = editing ? noteError(reason) : undefined;
    setErrors(found);
    setReasonError(why);
    if (!input || why) return;
    const { code, ...content } = input;
    try {
      if (plan) await action.mutateAsync({ kind: 'updatePlan', code: plan.code, input: { ...content, version: plan.version, reason: reason.trim() } });
      else await action.mutateAsync({ kind: 'createPlan', input: { ...content, code, idempotencyKey: key } });
      renewKey();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.field === 'code') setErrors((e) => ({ ...e, code: err.message }));
    }
  };

  const money = (k: 'monthly' | 'annual' | 'perUnitMonthly' | 'perUnitAnnual', label: string) => (
    <FormField label={label} error={errors[k]}>
      <Input inputMode="decimal" autoComplete="off" placeholder="0,00" value={draft[k]} onChange={(e) => set(k, e.target.value)} />
    </FormField>
  );

  const conflict = action.error instanceof ApiError && action.error.status === 409;

  return (
    <Dialog open={open} onClose={onClose} title={plan ? `Planı düzenle · ${plan.name}` : 'Yeni plan'} variant="wide">
      <form
        className="flex flex-col gap-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {plan && (
          <p className="text-small text-muted">
            Kaydetmek <strong className="text-text">sürüm {plan.planVersion + 1}</strong> oluşturur. Mevcut abonelikler kendi sürümünü korur; yeni fiyat yeni
            aboneliklerde ve plan değişikliğinde geçerli olur.
          </p>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Kod" error={errors.code} hint={editing ? 'Kod değiştirilemez.' : 'Küçük harf, rakam, - ve _ (ör. standart).'}>
            <Input autoComplete="off" spellCheck={false} disabled={editing} value={draft.code} onChange={(e) => set('code', e.target.value)} />
          </FormField>
          <FormField label="Ad" error={errors.name}>
            <Input autoComplete="off" value={draft.name} onChange={(e) => set('name', e.target.value)} />
          </FormField>
        </div>
        <FormField label="Açıklama" hint="İsteğe bağlı; yöneticiye gösterilmez.">
          <Textarea rows={2} maxLength={300} value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Fiyat modeli">
            <Select value={draft.model} onChange={(e) => set('model', e.target.value as PricingModel)}>
              {PRICING_MODELS.map((m) => (
                <option key={m} value={m}>
                  {MODEL_LABELS[m]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="KDV oranı (%)" error={errors.vatPercent}>
            <Input inputMode="decimal" autoComplete="off" value={draft.vatPercent} onChange={(e) => set('vatPercent', e.target.value)} />
          </FormField>
        </div>

        {draft.model !== 'tiered' && (
          <div className="grid gap-4 sm:grid-cols-2">
            {money('monthly', draft.model === 'per_unit' ? 'Aylık sabit bedel (₺, KDV hariç)' : 'Aylık bedel (₺, KDV hariç)')}
            {money('annual', draft.model === 'per_unit' ? 'Yıllık sabit bedel (₺, KDV hariç)' : 'Yıllık bedel (₺, KDV hariç)')}
            {draft.model === 'per_unit' && money('perUnitMonthly', 'Bölüm başı aylık (₺)')}
            {draft.model === 'per_unit' && money('perUnitAnnual', 'Bölüm başı yıllık (₺)')}
          </div>
        )}

        {draft.model === 'tiered' && (
          <fieldset className="flex flex-col gap-3">
            <legend className="text-small font-medium text-text">Kademeler (₺, KDV hariç)</legend>
            <ul className="flex flex-col gap-2" aria-label="Kademeler">
              {draft.tiers.map((t, i) => {
                const update = (patch: Partial<typeof t>) => set('tiers', draft.tiers.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <li key={i} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                    <FormField label={`${i + 1}. kademe: en fazla bölüm`} hint={i === draft.tiers.length - 1 ? 'Boş: sınırsız.' : undefined}>
                      <Input inputMode="numeric" autoComplete="off" value={t.maxUnits} onChange={(e) => update({ maxUnits: e.target.value })} />
                    </FormField>
                    <FormField label="Aylık">
                      <Input inputMode="decimal" autoComplete="off" value={t.monthly} onChange={(e) => update({ monthly: e.target.value })} />
                    </FormField>
                    <FormField label="Yıllık">
                      <Input inputMode="decimal" autoComplete="off" value={t.annual} onChange={(e) => update({ annual: e.target.value })} />
                    </FormField>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`${i + 1}. kademeyi sil`}
                      disabled={draft.tiers.length === 1}
                      onClick={() => set('tiers', draft.tiers.filter((_, j) => j !== i))}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                    </Button>
                  </li>
                );
              })}
            </ul>
            {errors.tiers && <p className="text-small text-danger">{errors.tiers}</p>}
            <div>
              <Button
                variant="secondary"
                size="sm"
                disabled={draft.tiers.length >= 10}
                onClick={() => set('tiers', [...draft.tiers, { maxUnits: '', monthly: '', annual: '' }])}
              >
                <Plus className="size-4" aria-hidden="true" />
                Kademe ekle
              </Button>
            </div>
          </fieldset>
        )}

        <fieldset className="flex flex-col gap-2">
          <legend className="text-small font-medium text-text">Plana dahil modüller</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {PLAN_FEATURES.map((f) => (
              <label key={f} className="inline-flex items-center gap-2 text-small">
                <input
                  type="checkbox"
                  className="size-4 accent-accent"
                  name={f}
                  checked={draft.features[f]}
                  onChange={(e) => set('features', { ...draft.features, [f]: e.target.checked })}
                />
                {FEATURE_LABELS[f]}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="En fazla bölüm" error={errors.maxUnits} hint="Boş: sınırsız.">
            <Input inputMode="numeric" autoComplete="off" value={draft.maxUnits} onChange={(e) => set('maxUnits', e.target.value)} />
          </FormField>
          <FormField label="En fazla ekip kullanıcısı" error={errors.maxStaffUsers} hint="Boş: sınırsız.">
            <Input inputMode="numeric" autoComplete="off" value={draft.maxStaffUsers} onChange={(e) => set('maxStaffUsers', e.target.value)} />
          </FormField>
          <FormField label="Deneme süresi (gün)" error={errors.trialDays} hint="0: deneme yok.">
            <Input inputMode="numeric" autoComplete="off" value={draft.trialDays} onChange={(e) => set('trialDays', e.target.value)} />
          </FormField>
        </div>

        {editing && (
          <FormField label="Gerekçe" error={reasonError} hint="Denetim kaydına yazılır (5-500 karakter).">
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setReasonError(undefined);
              }}
            />
          </FormField>
        )}

        {action.isError && !(action.error instanceof ApiError && action.error.status === 400 && action.error.field === 'code') && (
          <Alert tone="danger">
            {errorMessage(action.error)}
            {conflict && editing && ' Liste yenilendi; planı yeniden açın.'}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={action.isPending}>
            {editing ? 'Yeni sürüm olarak kaydet' : 'Planı oluştur'}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
