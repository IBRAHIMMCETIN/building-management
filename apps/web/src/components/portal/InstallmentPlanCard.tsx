import { CalendarRange } from 'lucide-react';
import { Alert, Badge, Card, CardTitle } from '@/components/ui';
import { useMyPlans } from '@/hooks/useRestructure';
import type { MyPlan } from '@/lib/api/restructure';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { PLAN_STATUS_LABELS, PLAN_STATUS_TONES, installmentSummary } from '@/lib/restructure/model';

function PlanBlock({ plan }: { plan: MyPlan }) {
  const { next, overdueCount, openCount } = installmentSummary(plan.installments);
  const open = plan.installments.filter((i) => i.remaining > 0);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-small text-muted">Yapılandırma {formatDate(plan.date)}</p>
          <p className="text-heading font-bold tabular-nums">{formatTRY(plan.remaining)}</p>
          <p className="text-small text-muted">
            kalan · toplam {formatTRY(plan.total)}, ödenen {formatTRY(plan.paid)}
          </p>
        </div>
        <Badge tone={PLAN_STATUS_TONES[plan.status]}>{PLAN_STATUS_LABELS[plan.status]}</Badge>
      </div>

      {plan.status === 'active' && plan.inDefault && (
        <Alert tone="danger">
          Geciken taksitleriniz var. Plan koşullarına göre ({plan.rule.consecutive} ardışık veya toplam {plan.rule.total} taksit, {plan.rule.graceDays}{' '}
          gün ek süre) kalan borcun tamamı muaccel hale gelebilir. Geciken taksitleri ödeyerek planınızı sürdürebilirsiniz.
        </Alert>
      )}
      {plan.status === 'active' && !plan.inDefault && overdueCount > 0 && (
        <p className="rounded-md bg-warning/10 px-3 py-2 text-small text-warning">{overdueCount} taksitin vadesi geçti.</p>
      )}
      {plan.accelerated && plan.accelerated.remaining > 0 && (
        <Alert tone="danger">
          Kalan plan borcu {formatDate(plan.accelerated.dueDate)} itibarıyla tek seferde ödenecek hale geldi: {formatTRY(plan.accelerated.remaining)}.
        </Alert>
      )}
      {plan.status === 'active' && next && (
        <p className="text-small">
          Sıradaki taksit: <strong>{next.no}.</strong> · {formatDate(next.dueDate)} · <strong className="tabular-nums">{formatTRY(next.remaining)}</strong>
        </p>
      )}
      {plan.status === 'active' && openCount > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border text-small" aria-label="Kalan taksitler">
          {open.map((i) => (
            <li key={i.no} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span>
                {i.no}. taksit · {formatDate(i.dueDate)}
                {i.overdue && (
                  <Badge tone="danger" className="ml-2">
                    Gecikmede
                  </Badge>
                )}
              </span>
              <span className="tabular-nums">{formatTRY(i.remaining)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Finans 2.2 - "Taksit Planım": sakinin carisindeki (iptal edilmemis) taksit planlari. Plan yoksa
 * kart gosterilmez. Taksitler borc listesinde acik kalem olarak da gorunur ve odenebilir.
 */
export function InstallmentPlanCard() {
  const plans = useMyPlans();
  const items = (plans.data ?? []).filter((p) => p.status !== 'completed' || p.remaining > 0);
  if (plans.isPending || plans.isError || items.length === 0) return null;
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <CalendarRange className="size-5 text-muted" aria-hidden="true" />
        Taksit Planım
      </CardTitle>
      {items.map((p) => (
        <PlanBlock key={p.planId} plan={p} />
      ))}
    </Card>
  );
}
