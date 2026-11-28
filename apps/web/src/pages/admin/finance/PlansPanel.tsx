import { CalendarClock, Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { useAccountLabels } from '@/hooks/useAccountLabels';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useApproveOffsetRequest, useOffsetRequests, usePlanAction, usePlans, useRejectOffsetRequest } from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import type { InstallmentPlan, OffsetRequest, PlanAction, PlanDisplayStatus } from '@/lib/api/restructure';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { ACCELERATION_MODE_LABELS, PLAN_STATUS_LABELS, PLAN_STATUS_TONES, installmentSummary, reasonError, ruleText } from '@/lib/restructure/model';
import { PlanRequestsSection } from './PlanRequestsSection';

type NameOf = (accountId: string) => string;

const ACTIONS: Record<PlanAction, { label: string; hint: string; variant: 'primary' | 'danger' | 'secondary' }> = {
  accelerate: { label: 'Muaccel kıl', hint: 'Kalan taksitlerin tamamı bugün vadeli tek borca dönüşür.', variant: 'danger' },
  'pull-forward': { label: 'Erken kapama', hint: 'Kalan taksitler bugüne çekilir (ceza yok); borçlu tamamını öder.', variant: 'secondary' },
  cancel: { label: 'Planı iptal et', hint: 'Yapılandırma ters kayıtla geri alınır; eski kalemler ve ödemeler geri döner, dondurulan tazminat kalır.', variant: 'danger' },
};

function ActionForm({ plan, action, onDone }: { plan: InstallmentPlan; action: PlanAction; onDone: () => void }) {
  const run = usePlanAction();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const error = reasonError(reason);
  const a = ACTIONS[action];
  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border pt-3">
      <p className="text-small text-muted">{a.hint}</p>
      {run.isError && <Alert tone="danger">{errorMessage(run.error)}</Alert>}
      <FormField label="Gerekçe" error={touched ? error : undefined}>
        <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={run.isPending}>
          Vazgeç
        </Button>
        <Button
          variant={a.variant}
          size="sm"
          loading={run.isPending}
          onClick={async () => {
            setTouched(true);
            if (error) return;
            try {
              await run.mutateAsync({ planId: plan.planId, action, reason: reason.trim() });
              onDone();
            } catch {
              // yukarida gosterilir
            }
          }}
        >
          {a.label}
        </Button>
      </div>
    </div>
  );
}

export function PlanCard({ plan, canWrite, nameOf }: { plan: InstallmentPlan; canWrite: boolean; nameOf: NameOf }) {
  const [expanded, setExpanded] = useState(false);
  const [action, setAction] = useState<PlanAction | null>(null);
  const s = plan.state;
  const status = s.displayStatus;
  const summary = installmentSummary(s.installments);
  const inDefault = status === 'active' && (s.inDefault || !!plan.default);
  const actions: PlanAction[] = status === 'active' ? ['accelerate', 'pull-forward', 'cancel'] : status === 'accelerated' ? ['cancel'] : [];

  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">{nameOf(plan.accountId)}</p>
            <p className="text-small text-muted">
              {formatDate(plan.date)} · {plan.installments.length} taksit · toplam {formatTRY(plan.total)}
            </p>
          </div>
          <Badge tone={PLAN_STATUS_TONES[status]}>{PLAN_STATUS_LABELS[status]}</Badge>
        </div>
        <dl className="mt-2 grid grid-cols-3 gap-2 text-small">
          <div>
            <dt className="text-muted">Ödenen</dt>
            <dd className="tabular-nums">{formatTRY(s.paid)}</dd>
          </div>
          <div>
            <dt className="text-muted">Kalan</dt>
            <dd className="font-semibold tabular-nums">{formatTRY(s.remaining)}</dd>
          </div>
          <div>
            <dt className="text-muted">Sıradaki</dt>
            <dd className="tabular-nums">{summary.next ? `${summary.next.no}. taksit · ${formatDate(summary.next.dueDate)}` : '—'}</dd>
          </div>
        </dl>
        {inDefault && (
          <div className="mt-2">
            <Alert tone="danger">
              Temerrüt: {s.overdueNos.length > 0 ? `${s.overdueNos.join(', ')}. taksit(ler) ek süreye rağmen ödenmedi.` : 'geciken taksitler var.'}
              {plan.default ? ` Tespit: ${formatDate(plan.default.detectedAt)}.` : ''} Muaccel kılma yönetici onayı bekliyor.
            </Alert>
          </div>
        )}
        {s.accelerated && (
          <p className="mt-2 text-small">
            {plan.acceleration ? ACCELERATION_MODE_LABELS[plan.acceleration.mode] : 'Muaccel'}: {formatTRY(s.accelerated.amount)}, vade{' '}
            {formatDate(s.accelerated.dueDate)} · kalan {formatTRY(s.accelerated.remaining)}
          </p>
        )}
        {plan.cancellation && (
          <p className="mt-1 text-small text-muted">
            İptal: {plan.cancellation.reason} · {formatDateTime(plan.cancellation.at)}
          </p>
        )}
        <p className="mt-1 text-xs text-muted">
          {ruleText(plan.rule)}. Gerekçe: {plan.reason}
        </p>

        <div className="mt-2 flex flex-wrap justify-between gap-2">
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
            Taksit çizelgesi
          </Button>
          {canWrite && !action && actions.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {actions.map((a) => (
                <Button key={a} variant={a === 'accelerate' && inDefault ? 'danger' : 'ghost'} size="sm" onClick={() => setAction(a)}>
                  {ACTIONS[a].label}
                </Button>
              ))}
            </div>
          )}
        </div>
        {expanded && (
          <table className="mt-2 w-full text-small" aria-label="Taksit çizelgesi">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1">No</th>
                <th>Vade</th>
                <th className="text-right">Tutar</th>
                <th className="text-right">Ödenen</th>
                <th className="text-right">Kalan</th>
              </tr>
            </thead>
            <tbody>
              {s.installments.map((i) => (
                <tr key={i.no} className="border-t border-border">
                  <td className="py-1">{i.no}</td>
                  <td>
                    {formatDate(i.dueDate)}
                    {i.overdue && i.remaining > 0 && <Badge tone="danger" className="ml-2">Gecikmede</Badge>}
                    {i.settledByAcceleration && <Badge className="ml-2">Muaccel</Badge>}
                  </td>
                  <td className="text-right tabular-nums">{formatTRY(i.amount)}</td>
                  <td className="text-right tabular-nums">{formatTRY(i.paid)}</td>
                  <td className="text-right tabular-nums">{formatTRY(i.remaining)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {action && <ActionForm plan={plan} action={action} onDone={() => setAction(null)} />}
      </Card>
    </li>
  );
}

function RequestRow({ r, canWrite, nameOf }: { r: OffsetRequest; canWrite: boolean; nameOf: NameOf }) {
  const approve = useApproveOffsetRequest();
  const reject = useRejectOffsetRequest();
  const [mode, setMode] = useState<'approve' | 'reject' | null>(null);
  const [amountText, setAmountText] = useState(kurusToInput(r.amount));
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const amount = parseTRYToKurus(amountText);
  const amountError = amount === null ? 'Geçerli bir tutar girin' : amount > r.amount ? 'Talep tutarını aşamaz' : undefined;
  const error = approve.error ?? reject.error;

  return (
    <li className="flex flex-col gap-2 px-3 py-3 text-small">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {nameOf(r.sourceAccountId)} → {nameOf(r.targetAccountId)}
          </p>
          <p className="text-muted">
            {formatTRY(r.amount)} · {formatDateTime(r.createdAt)}
            {r.note ? ` · “${r.note}”` : ''}
          </p>
        </div>
        {canWrite && !mode && (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setMode('approve')}>
              <Check className="size-4" aria-hidden="true" />
              Onayla
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('reject')}>
              <X className="size-4" aria-hidden="true" />
              Reddet
            </Button>
          </div>
        )}
      </div>
      {error && <Alert tone="danger">{errorMessage(error)}</Alert>}
      {mode === 'approve' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <FormField label="Onaylanan tutar (₺)" error={amountError}>
            <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} aria-label="Onaylanan tutar" />
          </FormField>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            Cariler farklı kişilere aitse: kaynak carinin sahibinden muvafakat alındı.
          </label>
          {consent && (
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Muvafakat açıklaması" aria-label="Muvafakat açıklaması" />
          )}
          <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Gerekçe (isteğe bağlı)" aria-label="Onay gerekçesi" />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              loading={approve.isPending}
              disabled={!!amountError || (consent && note.trim().length < 5)}
              onClick={async () => {
                try {
                  await approve.mutateAsync({
                    requestId: r.requestId,
                    input: {
                      ...(amount !== null && amount !== r.amount ? { amount } : {}),
                      ...(consent ? { consent: { thirdParty: true as const, note: note.trim() } } : {}),
                      ...(reason.trim() ? { reason: reason.trim() } : {}),
                    },
                  });
                  setMode(null);
                } catch {
                  // yukarida gosterilir
                }
              }}
            >
              Mahsubu onayla
            </Button>
          </div>
        </div>
      )}
      {mode === 'reject' && (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <FormField label="Ret gerekçesi" error={reason && reasonError(reason) ? reasonError(reason) : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMode(null)}>
              Vazgeç
            </Button>
            <Button
              size="sm"
              variant="danger"
              loading={reject.isPending}
              disabled={!!reasonError(reason)}
              onClick={async () => {
                try {
                  await reject.mutateAsync({ requestId: r.requestId, reason: reason.trim() });
                  setMode(null);
                } catch {
                  // yukarida gosterilir
                }
              }}
            >
              Talebi reddet
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}

const FILTERS: { id: PlanDisplayStatus | 'all'; label: string }[] = [
  { id: 'all', label: 'Tümü' },
  { id: 'active', label: PLAN_STATUS_LABELS.active },
  { id: 'accelerated', label: PLAN_STATUS_LABELS.accelerated },
  { id: 'completed', label: PLAN_STATUS_LABELS.completed },
  { id: 'cancelled', label: PLAN_STATUS_LABELS.cancelled },
];

/** Finans 2.2 - "Taksit planlari" sekmesi: sakin taksit talepleri, bekleyen sakin mahsup talepleri + planlar. */
export function PlansPanel({ canWrite }: { canWrite: boolean }) {
  const [filter, setFilter] = useState<PlanDisplayStatus | 'all'>('all');
  const plans = usePlans(filter === 'all' ? {} : { status: filter });
  const requests = useOffsetRequests('pending');
  const accounts = useFinanceAccounts('receivable');
  const labels = useAccountLabels();
  // UX-01: plan kart basligi ve talep satirlarinda ham kimlik yerine "Blok · Daire Kişi/Taraf".
  const names = useMemo(() => new Map((accounts.data ?? []).map((a) => [a.accountId, labels.label(a)])), [accounts.data, labels]);
  const nameOf: NameOf = (id) => names.get(id) ?? labels.labelOf(id);
  const pending = requests.data ?? [];
  const items = plans.data ?? [];
  const defaults = items.filter((p) => p.state.displayStatus === 'active' && (p.state.inDefault || p.default)).length;

  return (
    <div className="flex flex-col gap-4">
      <PlanRequestsSection canWrite={canWrite} nameOf={nameOf} />
      {pending.length > 0 && (
        <Card className="p-0">
          <p className="border-b border-border px-3 py-2 text-small font-semibold">Bekleyen sakin mahsup talepleri ({pending.length})</p>
          <ul className="divide-y divide-border" aria-label="Bekleyen mahsup talepleri">
            {pending.map((r) => (
              <RequestRow key={r.requestId} r={r} canWrite={canWrite} nameOf={nameOf} />
            ))}
          </ul>
        </Card>
      )}
      {requests.isError && <Alert tone="danger">{errorMessage(requests.error)}</Alert>}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1" role="group" aria-label="Plan durumu">
          {FILTERS.map((f) => (
            <Button key={f.id} size="xs" variant={filter === f.id ? 'secondary' : 'ghost'} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label}
            </Button>
          ))}
        </div>
        {defaults > 0 && (
          <Badge tone="danger">
            <CalendarClock className="size-3" aria-hidden="true" />
            {defaults} planda temerrüt
          </Badge>
        )}
      </div>

      {plans.isPending && (
        <div role="status" aria-label="Planlar yükleniyor" className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {plans.isError && <Alert tone="danger">{errorMessage(plans.error)}</Alert>}
      {plans.isSuccess && items.length === 0 && (
        <p className="py-6 text-center text-small text-muted">Bu filtrede taksit planı yok. “Borç yapılandır” ile açık borçları taksitlendirebilirsiniz.</p>
      )}
      {items.length > 0 && (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <PlanCard key={p.planId} plan={p} canWrite={canWrite} nameOf={nameOf} />
          ))}
        </ul>
      )}
    </div>
  );
}
