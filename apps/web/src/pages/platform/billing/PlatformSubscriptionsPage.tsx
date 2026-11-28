import { BadgeCheck, CirclePlay, RefreshCw, Replace, SlidersHorizontal } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useBillingAction, useBillingSettings, usePlans, usePlatformSubscriptions } from '@/hooks/useSubscriptions';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { BILLING_PERIODS, type BillingPeriod, type SubscriptionAction, type SubscriptionListItem, type SubscriptionListStatus } from '@/lib/api/subscriptions';
import { formatDate } from '@/lib/dates';
import { noteError } from '@/lib/payments/review';
import { ACTION_LABELS, PERIOD_LABELS, STATUS_LABELS, STATUS_TONES, actionsFor, priceSummary } from '@/lib/subscriptions/model';

type Filter = 'all' | SubscriptionListStatus;
const FILTER_ORDER: readonly Filter[] = ['all', 'legacy', 'trial', 'active', 'past_due', 'suspended', 'cancelled'];

type Action =
  | { kind: 'start'; item: SubscriptionListItem }
  | { kind: 'status'; item: SubscriptionListItem }
  | { kind: 'plan'; item: SubscriptionListItem };

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());

function ActionDialog({ action, onClose }: { action: Action | null; onClose: () => void }) {
  const mutate = useBillingAction();
  const plans = usePlans();
  const [key, renewKey] = useIdempotencyKey();
  const item = action?.item;
  const sub = item?.subscription;
  const allowed = useMemo(() => (item ? actionsFor(item.status) : []), [item]);
  const activePlans = (plans.data?.items ?? []).filter((p) => p.status === 'active');

  const [planCode, setPlanCode] = useState('');
  const [period, setPeriod] = useState<BillingPeriod>('monthly');
  const [trialDays, setTrialDays] = useState('');
  const [op, setOp] = useState<SubscriptionAction>('extend_trial');
  const [trialEnd, setTrialEnd] = useState('');
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<{ reason?: string; trialDays?: string; trialEnd?: string; plan?: string }>({});

  useEffect(() => {
    setPlanCode(sub?.plan.code ?? '');
    setPeriod(sub?.billingPeriod ?? 'monthly');
    setTrialDays('');
    setOp(allowed[0] ?? 'extend_trial');
    setTrialEnd(sub?.trialEndsAt ?? '');
    setReason('');
    setErrors({});
    mutate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [action]);

  const submit = async () => {
    if (!action || !item) return;
    const next: typeof errors = {};
    if (action.kind !== 'start' || reason.trim()) next.reason = noteError(reason);
    if ((action.kind === 'start' || action.kind === 'plan') && !planCode) next.plan = 'Bir plan seçin.';
    if (action.kind === 'start' && trialDays.trim() && !(/^\d+$/.test(trialDays.trim()) && Number(trialDays) <= 90)) next.trialDays = '0-90 arası gün girin.';
    if (action.kind === 'status' && op === 'extend_trial' && !(trialEnd && trialEnd >= today())) next.trialEnd = 'Bugün veya sonrası bir tarih seçin.';
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    try {
      if (action.kind === 'start') {
        await mutate.mutateAsync({
          kind: 'start',
          apartmentId: item.apartmentId,
          input: { idempotencyKey: key, planCode, billingPeriod: period, ...(trialDays.trim() ? { trialDays: Number(trialDays) } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) },
        });
        renewKey();
      } else if (action.kind === 'plan' && sub) {
        await mutate.mutateAsync({ kind: 'changePlan', apartmentId: item.apartmentId, input: { version: sub.version, planCode, reason: reason.trim() } });
      } else if (sub) {
        await mutate.mutateAsync({
          kind: 'status',
          apartmentId: item.apartmentId,
          input: { version: sub.version, action: op, reason: reason.trim(), ...(op === 'extend_trial' ? { trialEndsAt: trialEnd } : {}) },
        });
      }
      onClose();
    } catch {
      // hata asagida
    }
  };

  const title = action?.kind === 'start' ? 'Abonelik başlat' : action?.kind === 'plan' ? 'Plan değiştir' : 'Abonelik durumu';
  const planSelect = (
    <FormField label="Plan" error={errors.plan}>
      <Select value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
        <option value="">Plan seçin</option>
        {activePlans.map((p) => (
          <option key={p.code} value={p.code}>
            {p.name} · {priceSummary(p.pricing)}
          </option>
        ))}
      </Select>
    </FormField>
  );

  return (
    <Dialog open={action !== null} onClose={onClose} title={title}>
      {item && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{item.siteName}</strong> · {STATUS_LABELS[item.status]}
            {sub ? ` · ${sub.plan.name} (sürüm ${sub.plan.planVersion})` : ''}
          </p>
          {action?.kind === 'start' && (
            <>
              <Alert>
                Bu apartman şu an abonelik öncesi (sınırsız) modda. Başlatınca plan modülleri, sınırları ve deneme / fatura döngüsü uygulanır; geri dönüş için
                ücretsiz “Pilot” planı kullanılabilir.
              </Alert>
              {planSelect}
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField label="Fatura dönemi">
                  <Select value={period} onChange={(e) => setPeriod(e.target.value as BillingPeriod)}>
                    {BILLING_PERIODS.map((p) => (
                      <option key={p} value={p}>
                        {PERIOD_LABELS[p]}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Deneme süresi (gün)" error={errors.trialDays} hint="Boş: planın deneme süresi. 0: ilk dönem bugün başlar.">
                  <Input inputMode="numeric" autoComplete="off" value={trialDays} onChange={(e) => setTrialDays(e.target.value)} />
                </FormField>
              </div>
            </>
          )}
          {action?.kind === 'plan' && (
            <>
              {planSelect}
              <p className="text-small text-muted">Modüller ve sınırlar hemen değişir; yeni fiyat bir sonraki dönem faturasından itibaren uygulanır.</p>
            </>
          )}
          {action?.kind === 'status' && (
            <>
              <FormField label="İşlem">
                <Select value={op} onChange={(e) => setOp(e.target.value as SubscriptionAction)}>
                  {allowed.map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a]}
                    </option>
                  ))}
                </Select>
              </FormField>
              {op === 'extend_trial' && (
                <FormField label="Yeni deneme bitişi" error={errors.trialEnd}>
                  <Input type="date" min={today()} value={trialEnd} onChange={(e) => setTrialEnd(e.target.value)} />
                </FormField>
              )}
              {(op === 'suspend' || op === 'cancel') && (
                <Alert tone="danger">Apartman salt okunur olur: yönetim yazamaz; görüntüleme, dışa aktarma ve sakin ödemeleri açık kalır.</Alert>
              )}
            </>
          )}
          <FormField
            label={action?.kind === 'start' ? 'Not (isteğe bağlı)' : 'Gerekçe'}
            error={errors.reason}
            hint="Denetim kaydına yazılır (5-500 karakter)."
          >
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setErrors((x) => ({ ...x, reason: undefined }));
              }}
            />
          </FormField>
          {mutate.isError && (
            <Alert tone="danger">
              {errorMessage(mutate.error)}
              {mutate.error instanceof ApiError && mutate.error.status === 409 && ' Liste yenilendi; kaydı yeniden açın.'}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button
              variant={action?.kind === 'status' && (op === 'suspend' || op === 'cancel') ? 'danger' : 'primary'}
              loading={mutate.isPending}
              onClick={() => void submit()}
            >
              {action?.kind === 'start' ? 'Başlat' : action?.kind === 'plan' ? 'Planı değiştir' : 'Uygula'}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SubscriptionRow({
  item,
  enabled,
  onAction,
  onError,
}: {
  item: SubscriptionListItem;
  enabled: boolean;
  onAction: (a: Action) => void;
  onError: (m: string | null) => void;
}) {
  const sync = useBillingAction();
  const sub = item.subscription;
  const meta = [
    item.city,
    !sub
      ? 'tüm modüller site ayarına göre, sınır yok'
      : sub.status === 'trial' && sub.trialEndsAt
        ? `deneme ${formatDate(sub.trialEndsAt)} tarihinde bitiyor${item.daysLeft !== undefined ? ` (${item.daysLeft} gün)` : ''}`
        : sub.currentPeriodStart && sub.currentPeriodEnd
          ? `dönem ${formatDate(sub.currentPeriodStart)} – ${formatDate(sub.currentPeriodEnd)}`
          : '',
    sub ? `${sub.plan.name} (${PERIOD_LABELS[sub.billingPeriod].toLocaleLowerCase('tr')})` : '',
    sub ? `${sub.unitCountSnapshot} bölüm` : '',
    sub?.status === 'past_due' && sub.pastDueSince ? `gecikme ${formatDate(sub.pastDueSince)}` : '',
    sub?.suspendedAt ? `askı ${formatDate(sub.suspendedAt)}${sub.suspendedReason === 'manual' ? ' (elle)' : ''}` : '',
  ].filter(Boolean);
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{item.siteName}</p>
          <Badge tone={STATUS_TONES[item.status]}>{STATUS_LABELS[item.status]}</Badge>
          {item.siteStatus === 'inactive' && <Badge tone="warning">Pasif site</Badge>}
          {sub && <span className="font-semibold tabular-nums">{priceSummary(sub.plan.pricing, sub.billingPeriod)}</span>}
        </div>
        <p className="text-small text-muted">{meta.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap gap-2">
        {!sub ? (
          <Button size="xs" disabled={!enabled} onClick={() => onAction({ kind: 'start', item })}>
            <CirclePlay className="size-3.5" aria-hidden="true" />
            Başlat
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant="subtle"
              disabled={!enabled}
              loading={sync.isPending}
              onClick={() => {
                onError(null);
                sync.mutate({ kind: 'sync', apartmentId: item.apartmentId }, { onError: (err) => onError(errorMessage(err)) });
              }}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              Dönemi işle
            </Button>
            {sub.status !== 'cancelled' && (
              <Button size="xs" variant="ghost" disabled={!enabled} onClick={() => onAction({ kind: 'plan', item })}>
                <Replace className="size-3.5" aria-hidden="true" />
                Plan değiştir
              </Button>
            )}
            <Button size="xs" disabled={!enabled} onClick={() => onAction({ kind: 'status', item })}>
              <SlidersHorizontal className="size-3.5" aria-hidden="true" />
              Durum
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

type SettingsChange = { enabled: boolean; automation: boolean; title: string; text: string };

/** Platform ayari degisikligi: gerekce platform denetim zincirine yazilir. */
function SettingsDialog({ change, version, onClose }: { change: SettingsChange | null; version: number; onClose: () => void }) {
  const mutate = useBillingAction();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setReason('');
    setError(undefined);
    mutate.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [change]);

  const submit = async () => {
    if (!change) return;
    const e = noteError(reason);
    if (e) {
      setError(e);
      return;
    }
    try {
      await mutate.mutateAsync({ kind: 'settings', input: { version, enabled: change.enabled, automation: change.automation, reason: reason.trim() } });
      onClose();
    } catch {
      // hata asagida
    }
  };

  return (
    <Dialog open={change !== null} onClose={onClose} title={change?.title ?? ''}>
      {change && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">{change.text}</p>
          <FormField label="Gerekçe" error={error} hint="Denetim kaydına yazılır (5-500 karakter).">
            <Textarea
              rows={2}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(undefined);
              }}
            />
          </FormField>
          {mutate.isError && (
            <Alert tone="danger">
              {errorMessage(mutate.error)}
              {mutate.error instanceof ApiError && mutate.error.status === 409 && ' Ayar yenilendi; yeniden deneyin.'}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button variant={change.enabled ? 'primary' : 'danger'} loading={mutate.isPending} onClick={() => void submit()}>
              Kaydet
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** Platform ayari bolgesi: sistem ve otomatik donem isleme (ikisi de varsayilan kapali). */
function SettingsPanel({ onChange }: { onChange: (c: SettingsChange) => void }) {
  const settings = useBillingSettings();
  if (settings.isPending) return <Skeleton className="h-16 w-full" />;
  if (settings.isError) return <Alert tone="danger">{errorMessage(settings.error)}</Alert>;
  const s = settings.data;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Abonelik sistemi</CardTitle>
            {s.enabled ? <Badge tone="success">Açık</Badge> : <Badge>Kapalı</Badge>}
            {s.enabled && (s.automation ? <Badge tone="accent">Otomatik dönem işleme</Badge> : <Badge>Elle dönem işleme</Badge>)}
          </div>
          <p className="text-small text-muted">
            {s.enabled
              ? s.automation
                ? 'Her gün 06:15’te deneme bitişi, dönem faturası, gecikme ve askı kendiliğinden işlenir.'
                : 'Faturalar ve durumlar yalnızca “Dönemi işle” ile elle işlenir; günlük iş çalışmaz.'
              : 'Kapalıyken hiçbir site kısıtlanmaz (abonelik öncesi gibi çalışır) ve aşağıdaki abonelik işlemleri kapalıdır; plan kataloğu hazırlanabilir.'}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {s.enabled && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() =>
                onChange({
                  enabled: true,
                  automation: !s.automation,
                  title: s.automation ? 'Otomatik dönem işlemeyi kapat' : 'Otomatik dönem işlemeyi aç',
                  text: s.automation
                    ? 'Günlük iş fatura kesmez ve durum değiştirmez; dönemler “Dönemi işle” ile elle işlenir.'
                    : 'Günlük iş her gün deneme bitişi, dönem faturası, gecikme ve askıyı kendiliğinden işler ve yöneticilere bildirim gönderir.',
                })
              }
            >
              {s.automation ? 'Otomasyonu kapat' : 'Otomasyonu aç'}
            </Button>
          )}
          <Button
            size="xs"
            variant={s.enabled ? 'danger' : 'primary'}
            onClick={() =>
              onChange(
                s.enabled
                  ? { enabled: false, automation: false, title: 'Abonelik sistemini kapat', text: 'Tüm siteler abonelik öncesi gibi çalışır: modül, sınır ve salt okunur kısıtı kalkar. Kayıtlar silinmez.' }
                  : {
                      enabled: true,
                      automation: false,
                      title: 'Abonelik sistemini aç',
                      text: 'Aboneliği başlatılan sitelerde plan modülleri, sınırları ve salt okunur kuralı uygulanır. Otomatik dönem işleme kapalı başlar.',
                    },
              )
            }
          >
            {s.enabled ? 'Sistemi kapat' : 'Sistemi aç'}
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * Platform yoneticisi: tum apartmanlarin aboneligi. Aboneligi olmayan apartman "abonelik oncesi"
 * (legacy): tum moduller acik, sinir yok. Durum gecisleri gerekceli ve apartmanin denetim zincirine yazilir.
 */
export function PlatformSubscriptionsPage() {
  const list = usePlatformSubscriptions();
  const settings = useBillingSettings();
  const enabled = settings.data?.enabled === true;
  const [change, setChange] = useState<SettingsChange | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [action, setAction] = useState<Action | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const items = useMemo(() => (list.data?.items ?? []).filter((i) => filter === 'all' || i.status === filter), [list.data, filter]);
  const options = useMemo(
    () =>
      FILTER_ORDER.map((value) => ({
        value,
        label: value === 'all' ? 'Tümü' : STATUS_LABELS[value],
        count: value === 'all' ? list.data?.items.length : list.data?.counts[value],
      })),
    [list.data],
  );
  const attention = (list.data?.counts.past_due ?? 0) + (list.data?.counts.suspended ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <BadgeCheck className="size-5" aria-hidden="true" />
          Abonelikler
        </h1>
        <p className="text-small text-muted">
          Apartman bazında plan, deneme ve dönem. “Dönemi işle” bugünün adımını uygular: deneme bitişi, dönem faturası, gecikme ve askı (fatura numarası tek
          seriden).
        </p>
      </div>

      <SettingsPanel onChange={setChange} />

      {list.isPending ? (
        <div role="status" aria-label="Abonelikler yükleniyor">
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
          {attention > 0 && <Alert tone="danger">{attention} apartmanın ödemesi gecikmiş veya aboneliği askıda.</Alert>}
          {rowError && <Alert tone="danger">{rowError}</Alert>}
          <FilterChips<Filter> label="Abonelik durumu" value={filter} onChange={setFilter} options={options} />
          {items.length === 0 ? (
            <p className="py-4 text-center text-small text-muted">{list.data.items.length === 0 ? 'Henüz apartman yok.' : 'Bu filtreye uyan apartman yok.'}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label="Abonelikler">
              {items.map((i) => (
                <SubscriptionRow key={i.apartmentId} item={i} enabled={enabled} onAction={setAction} onError={setRowError} />
              ))}
            </ul>
          )}
        </Card>
      )}
      <ActionDialog action={action} onClose={() => setAction(null)} />
      <SettingsDialog change={change} version={settings.data?.version ?? 0} onClose={() => setChange(null)} />
    </div>
  );
}
