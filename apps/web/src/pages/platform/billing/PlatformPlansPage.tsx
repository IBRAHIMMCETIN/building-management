import { Archive, Layers, Pencil, Plus, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, FormField, Skeleton, Textarea } from '@/components/ui';
import { useBillingAction, usePlans } from '@/hooks/useSubscriptions';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { PLAN_FEATURES, type Plan } from '@/lib/api/subscriptions';
import { noteError } from '@/lib/payments/review';
import { FEATURE_LABELS, PLAN_STATUS_LABELS, PLAN_STATUS_TONES, includedFeatures, priceSummary, vatText } from '@/lib/subscriptions/model';
import { PlanEditorDialog } from './PlanEditorDialog';

type Filter = 'all' | 'active' | 'archived';
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'archived', label: 'Arşiv' },
];

/** Arsivleme / yeniden etkinlestirme: gerekce denetim kaydina yazilir. */
function StatusDialog({ plan, onClose }: { plan: Plan | null; onClose: () => void }) {
  const action = useBillingAction();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | undefined>();
  const archiving = plan?.status === 'active';

  useEffect(() => {
    setText('');
    setError(undefined);
    action.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [plan]);

  const submit = async () => {
    if (!plan) return;
    const e = noteError(text);
    if (e) {
      setError(e);
      return;
    }
    try {
      await action.mutateAsync({ kind: 'planStatus', code: plan.code, input: { version: plan.version, status: archiving ? 'archived' : 'active', reason: text.trim() } });
      onClose();
    } catch {
      // hata asagida
    }
  };

  return (
    <Dialog open={plan !== null} onClose={onClose} title={archiving ? 'Planı arşivle' : 'Planı yeniden etkinleştir'}>
      {plan && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{plan.name}</strong> ·{' '}
            {archiving
              ? 'Arşivlenen plan yeni aboneliklere atanamaz; mevcut abonelikler etkilenmez. Plan silinmez.'
              : 'Plan yeniden yeni aboneliklere atanabilir.'}
          </p>
          <FormField label="Gerekçe" error={error} hint="Denetim kaydına yazılır (5-500 karakter).">
            <Textarea
              rows={3}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setError(undefined);
              }}
            />
          </FormField>
          {action.isError && (
            <Alert tone="danger">
              {errorMessage(action.error)}
              {action.error instanceof ApiError && action.error.status === 409 && ' Liste yenilendi; planı yeniden açın.'}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant={archiving ? 'danger' : 'primary'} loading={action.isPending} onClick={() => void submit()}>
              {archiving ? 'Arşivle' : 'Etkinleştir'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function PlanRow({ plan, onEdit, onStatus }: { plan: Plan; onEdit: (p: Plan) => void; onStatus: (p: Plan) => void }) {
  const features = includedFeatures(plan.features);
  const limits = [
    plan.limits.maxUnits === null ? 'sınırsız bölüm' : `en fazla ${plan.limits.maxUnits} bölüm`,
    plan.limits.maxStaffUsers === null ? 'sınırsız ekip' : `en fazla ${plan.limits.maxStaffUsers} ekip kullanıcısı`,
  ];
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{plan.name}</p>
          <Badge tone={PLAN_STATUS_TONES[plan.status]}>{PLAN_STATUS_LABELS[plan.status]}</Badge>
          {plan.placeholder && <Badge tone="warning">Örnek fiyat</Badge>}
          <span className="font-semibold tabular-nums">{priceSummary(plan.pricing)}</span>
        </div>
        <p className="text-small text-muted">
          <span className="font-mono text-xs">{plan.code}</span> · sürüm {plan.planVersion} · KDV {vatText(plan.pricing.vatRateBps)} hariç ·{' '}
          {plan.trialDays > 0 ? `${plan.trialDays} gün deneme` : 'deneme yok'} · {limits.join(' · ')}
        </p>
        <p className="text-small text-muted">
          {features.length === PLAN_FEATURES.length ? 'Tüm modüller' : features.length === 0 ? 'Ek modül yok' : features.map((f) => FEATURE_LABELS[f]).join(', ')}
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        <Button size="xs" variant="subtle" onClick={() => onEdit(plan)}>
          <Pencil className="size-3.5" aria-hidden="true" />
          Düzenle
        </Button>
        <Button size="xs" variant="ghost" onClick={() => onStatus(plan)}>
          {plan.status === 'active' ? <Archive className="size-3.5" aria-hidden="true" /> : <RotateCcw className="size-3.5" aria-hidden="true" />}
          {plan.status === 'active' ? 'Arşivle' : 'Etkinleştir'}
        </Button>
      </div>
    </li>
  );
}

/**
 * Platform yoneticisi: abonelik plan katalogu. Planlar silinmez (arsivlenir); her duzenleme yeni
 * bir surumdur. Ornek planlarin fiyatlari is karari degildir (README "Abonelik").
 */
export function PlatformPlansPage() {
  const list = usePlans();
  const seed = useBillingAction();
  const [filter, setFilter] = useState<Filter>('all');
  const [editing, setEditing] = useState<{ plan: Plan | null } | null>(null);
  const [statusFor, setStatusFor] = useState<Plan | null>(null);
  const items = useMemo(() => (list.data?.items ?? []).filter((p) => filter === 'all' || p.status === filter), [list.data, filter]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="inline-flex items-center gap-2 text-title font-bold">
            <Layers className="size-5" aria-hidden="true" />
            Abonelik planları
          </h1>
          <p className="text-small text-muted">
            Apartmanlara atanan planlar: fiyat (KDV hariç), dahil modüller ve sınırlar. Planlar silinmez, arşivlenir; düzenleme yeni sürüm oluşturur.
          </p>
        </div>
        <Button onClick={() => setEditing({ plan: null })}>
          <Plus className="size-4" aria-hidden="true" />
          Yeni plan
        </Button>
      </div>

      {list.isPending ? (
        <div role="status" aria-label="Planlar yükleniyor">
          <Skeleton className="h-32 w-full" />
        </div>
      ) : list.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      ) : (
        <Card className="flex flex-col gap-4">
          {list.data.items.some((p) => p.placeholder) && (
            <Alert>“Örnek fiyat” işaretli planların fiyatları yer tutucudur; satış öncesinde gerçek fiyatlarla düzenleyin.</Alert>
          )}
          <FilterChips<Filter> label="Plan durumu" value={filter} onChange={setFilter} options={FILTERS} />
          {items.length === 0 ? (
            list.data.items.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-4 text-center">
                <p className="text-small text-muted">Henüz plan yok. Örnek planları yükleyip fiyatlarını düzenleyebilir veya yeni plan oluşturabilirsiniz.</p>
                <Button variant="secondary" loading={seed.isPending} onClick={() => seed.mutate({ kind: 'seed' })}>
                  <Sparkles className="size-4" aria-hidden="true" />
                  Örnek planları yükle
                </Button>
                {seed.isError && <Alert tone="danger">{errorMessage(seed.error)}</Alert>}
              </div>
            ) : (
              <p className="py-4 text-center text-small text-muted">Bu filtreye uyan plan yok.</p>
            )
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Abonelik planları">
              {items.map((p) => (
                <PlanRow key={p.code} plan={p} onEdit={(plan) => setEditing({ plan })} onStatus={setStatusFor} />
              ))}
            </ul>
          )}
        </Card>
      )}
      <PlanEditorDialog open={editing !== null} plan={editing?.plan ?? null} onClose={() => setEditing(null)} />
      <StatusDialog plan={statusFor} onClose={() => setStatusFor(null)} />
    </div>
  );
}
