import { BadgeCheck, FileDown } from 'lucide-react';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { useMySubscription } from '@/hooks/useSubscriptions';
import { errorMessage } from '@/lib/api/errors';
import { PLAN_FEATURES, subscriptionsApi } from '@/lib/api/subscriptions';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import {
  FEATURE_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONES,
  PERIOD_LABELS,
  STATUS_LABELS,
  STATUS_TONES,
  priceSummary,
  usageText,
} from '@/lib/subscriptions/model';

/**
 * Ayarlar > Abonelik (yonetici, yonetim firmasi, denetci; salt okunur). Plan ve durum, deneme /
 * donem tarihleri, kullanim ve sinirlar, faturalar (PDF). Plani ve durumu platform ekibi degistirir;
 * abonelik oncesi (legacy) sitelerde tum moduller acik ve sinirsizdir.
 */
export function SubscriptionCard() {
  const q = useMySubscription();
  const docs = useOpenDocument();
  const v = q.data;

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle className="flex items-center gap-2">
        <BadgeCheck className="size-5 text-muted" aria-hidden="true" />
        Abonelik
      </CardTitle>
      {q.isPending && <Skeleton className="h-24" />}
      {q.isError && <Alert tone="danger">{errorMessage(q.error)}</Alert>}
      {v?.legacy && (
        <p className="text-small text-muted">
          Bu site abonelik öncesinde açıldı: tüm modüller açık, bölüm ve ekip sınırı yok. Abonelik başlatıldığında plan ve faturalar burada görünür.
        </p>
      )}
      {v && !v.legacy && v.plan && (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">{v.plan.name}</p>
            <Badge tone={STATUS_TONES[v.status]}>{STATUS_LABELS[v.status]}</Badge>
            {v.billingPeriod && <Badge>{PERIOD_LABELS[v.billingPeriod]}</Badge>}
          </div>
          <p className="text-small text-muted">
            Ücret: <span className="font-medium text-text">{priceSummary(v.plan.pricing, v.billingPeriod)}</span> (KDV hariç).{' '}
            {v.status === 'trial' && v.trialEndsAt && (
              <>
                Deneme bitişi: <span className="font-medium text-text">{formatDate(v.trialEndsAt)}</span>
                {v.daysLeft !== undefined ? ` (${v.daysLeft} gün)` : ''}.{' '}
              </>
            )}
            {v.currentPeriodStart && v.currentPeriodEnd && (
              <>
                Dönem: <span className="font-medium text-text">{formatDate(v.currentPeriodStart)} – {formatDate(v.currentPeriodEnd)}</span>.{' '}
              </>
            )}
            {v.status === 'past_due' && v.suspendOn && (
              <>
                Ödeme alınmazsa <span className="font-medium text-text">{formatDate(v.suspendOn)}</span> tarihinde salt okunur olur.{' '}
              </>
            )}
            {v.status === 'suspended' && v.suspendedAt && (
              <>
                Askı tarihi: <span className="font-medium text-text">{formatDate(v.suspendedAt)}</span>; hesap salt okunur.{' '}
              </>
            )}
          </p>
          <ul className="flex flex-col divide-y divide-border" aria-label="Kullanım ve sınırlar">
            <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <p className="text-small font-medium">Bağımsız bölüm</p>
              <p className="text-small tabular-nums">{usageText(v.usage.units, v.limits.maxUnits)}</p>
            </li>
            <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <p className="text-small font-medium">Ekip kullanıcısı</p>
              <p className="text-small tabular-nums">{usageText(v.usage.staffUsers, v.limits.maxStaffUsers)}</p>
            </li>
            <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
              <p className="text-small font-medium">Modüller</p>
              <div className="flex flex-wrap gap-1.5 sm:justify-end">
                {PLAN_FEATURES.map((f) => (
                  <Badge key={f} tone={v.features[f] ? 'success' : 'warning'}>
                    {FEATURE_LABELS[f]}
                    {v.features[f] ? '' : ' (aboneliğinizde yok)'}
                  </Badge>
                ))}
              </div>
            </li>
          </ul>
          <div className="flex flex-col gap-2">
            <h3 className="text-small font-medium">Faturalar</h3>
            {v.invoices.length === 0 ? (
              <p className="text-small text-muted">Henüz fatura kesilmedi.</p>
            ) : (
              <ul className="flex flex-col divide-y divide-border" aria-label="Abonelik faturaları">
                {v.invoices.map((inv) => (
                  <li key={inv.invoiceId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-small font-medium">
                        {inv.invoiceNumber}
                        <Badge tone={INVOICE_STATUS_TONES[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
                      </p>
                      <p className="text-small text-muted">
                        {formatDate(inv.periodStart)} – {formatDate(inv.periodEnd)} · {formatTRY(inv.totalKurus)} (KDV dahil) ·{' '}
                        {inv.status === 'paid' && inv.paidOn ? `ödendi ${formatDate(inv.paidOn)}` : `son ödeme ${formatDate(inv.dueDate)}`}
                      </p>
                    </div>
                    <Button
                      variant="subtle"
                      size="xs"
                      loading={docs.pendingId === inv.invoiceId}
                      onClick={() => void docs.open(inv.invoiceId, () => subscriptionsApi.myInvoicePdf(inv.invoiceId))}
                    >
                      <FileDown className="size-3.5" aria-hidden="true" />
                      PDF
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            {docs.error && <Alert tone="danger">{docs.error}</Alert>}
          </div>
          <p className="text-small text-muted">Plan değişikliği ve ödeme için platform ekibiyle iletişime geçin. Ödeme havale / EFT ile alınır.</p>
        </>
      )}
    </Card>
  );
}
