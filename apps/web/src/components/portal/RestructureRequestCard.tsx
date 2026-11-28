import {
  type MyPlanRequest,
  PARTY_LABELS,
  PLAN_REQUEST_BLOCK_TEXT,
  PLAN_REQUEST_NOTE_MAX,
  PLAN_REQUEST_STATUS_LABELS,
  PLAN_REQUEST_STATUS_TONES,
  installmentChoices,
  monthlyAmount,
} from '@bm/shared/api/planRequests';
import { CalendarPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, FormField, Input, Select } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreatePlanRequest, useMyPlanRequests, usePlanRequestOptions, useWithdrawPlanRequest } from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

/** Talep satirinin alt bilgisi: karar ozeti veya ret gerekcesi. */
export function requestDetail(r: MyPlanRequest): string {
  const d = r.decision;
  if (r.status === 'approved' && d) {
    const changed = d.mode === 'changed' ? ' (yönetim değiştirerek onayladı)' : '';
    return `${d.installments ?? r.installments} taksit${d.firstDueDate ? `, ilk taksit ${formatDate(d.firstDueDate)}` : ''}${changed}`;
  }
  if (r.status === 'rejected' && d) return `Gerekçe: ${d.reason}`;
  return `${r.installments} taksit istendi · yaklaşık ${formatTRY(r.estimate.total)}`;
}

/**
 * Finans 2.2 sonrasi - sakin yapilandirma (taksit) talebi: vadesi gecmis borcu olan cari icin
 * yonetimin sinirlari icinde taksit sayisi secilir; yonetim olduğu gibi / degistirerek onaylar veya
 * reddeder. Talep edilebilecek cari ve talep yoksa kart gosterilmez.
 */
export function RestructureRequestCard() {
  const options = usePlanRequestOptions();
  const requests = useMyPlanRequests();
  const create = useCreatePlanRequest();
  const withdraw = useWithdrawPlanRequest();
  const [key, renewKey] = useIdempotencyKey();
  const [accountId, setAccountId] = useState('');
  const [installments, setInstallments] = useState(0);
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  const o = options.data;
  const eligible = (o?.accounts ?? []).filter((a) => a.eligible);
  const account = eligible.find((a) => a.accountId === accountId) ?? eligible[0];
  const choices = account ? installmentChoices(account, o?.minInstallments) : [];
  useEffect(() => {
    if (!account) return;
    setAccountId((cur) => cur || account.accountId);
    setInstallments((cur) => (choices.includes(cur) ? cur : (choices[Math.min(1, choices.length - 1)] ?? 0)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.accountId, account?.maxInstallments]);

  const list = requests.data ?? [];
  // Talep acilamayan ama aciklamasi olan cari (or. bekleyen talep, aktif plan).
  const notices = (o?.accounts ?? []).filter((a) => !a.eligible && a.reason && a.reason !== 'no_overdue' && !(a.reason === 'pending_request' && a.pendingRequest === 'mine'));
  if (!o || options.isError || (eligible.length === 0 && list.length === 0 && notices.length === 0)) return null;

  const valid = !!account && choices.includes(installments);
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <CalendarPlus className="size-5 text-muted" aria-hidden="true" />
        Taksit (yapılandırma) talebi
      </CardTitle>
      {account && (
        <>
          <p className="text-small text-muted">
            Gecikmiş borcunuzu taksitle ödemek istiyorsanız talep oluşturun. Yönetim talebinizi olduğu gibi veya değiştirerek onaylar; vade farkı
            uygulanmaz.
          </p>
          {eligible.length > 1 && (
            <FormField label="Hangi borç için?">
              <Select value={account.accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Hangi borç için?">
                {eligible.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {PARTY_LABELS[a.liableParty]} · gecikmiş {formatTRY(a.overdue)}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div className="rounded-md bg-surface-muted p-3">
              <dt className="text-small text-muted">Gecikmiş borç</dt>
              <dd className="font-semibold tabular-nums">{formatTRY(account.overdue)}</dd>
            </div>
            {o.settings.includeLateFees && account.accruedLateFee > 0 && (
              <div className="rounded-md bg-surface-muted p-3">
                <dt className="text-small text-muted">İşleyen tazminat</dt>
                <dd className="font-semibold text-warning tabular-nums">{formatTRY(account.accruedLateFee)}</dd>
              </div>
            )}
            <div className="col-span-2 rounded-md bg-surface-muted p-3 sm:col-span-1">
              <dt className="text-small text-muted">Taksitlenecek (yaklaşık)</dt>
              <dd className="font-semibold tabular-nums">{formatTRY(account.total)}</dd>
            </div>
          </dl>
          <FormField label="Taksit sayısı" hint={`En az ${o.minInstallments}, en fazla ${account.maxInstallments} taksit; bir taksit en az ${formatTRY(o.settings.minInstallmentAmount)}.`}>
            <Select value={String(installments)} onChange={(e) => setInstallments(Number(e.target.value))} aria-label="Taksit sayısı">
              {choices.map((n) => (
                <option key={n} value={n}>
                  {n} taksit · aylık yaklaşık {formatTRY(monthlyAmount(account.total, n))}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Not (isteğe bağlı)">
            <Input value={note} maxLength={PLAN_REQUEST_NOTE_MAX} onChange={(e) => setNote(e.target.value)} aria-label="Not" />
          </FormField>
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <div className="flex justify-end">
            <Button
              loading={create.isPending}
              disabled={!valid}
              onClick={async () => {
                if (!valid || !account) return;
                try {
                  await create.mutateAsync({
                    idempotencyKey: key,
                    liableParty: account.liableParty,
                    installments,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  setSent(true);
                  setNote('');
                  setAccountId('');
                  renewKey();
                } catch {
                  // yukarida gosterilir
                }
              }}
            >
              Talep gönder
            </Button>
          </div>
        </>
      )}
      {sent && !create.isError && <Alert tone="success">Talebiniz yönetime iletildi. Sonucu burada ve e-posta ile göreceksiniz.</Alert>}
      {notices.map((a) => (
        <p key={a.accountId} className="text-small text-muted">
          {eligible.length > 0 || notices.length > 1 ? `${PARTY_LABELS[a.liableParty]}: ` : ''}
          {PLAN_REQUEST_BLOCK_TEXT[a.reason as keyof typeof PLAN_REQUEST_BLOCK_TEXT]}
        </p>
      ))}
      {withdraw.isError && <Alert tone="danger">{errorMessage(withdraw.error)}</Alert>}
      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border text-small" aria-label="Taksit taleplerim">
          {list.map((r) => (
            <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {requestDetail(r)}
                <span className="block text-xs text-muted">{formatDateTime(r.createdAt)}</span>
              </span>
              <span className="flex items-center gap-2">
                {r.status === 'pending' && (
                  <Button size="xs" variant="ghost" loading={withdraw.isPending && withdraw.variables === r.requestId} onClick={() => withdraw.mutate(r.requestId)}>
                    Geri çek
                  </Button>
                )}
                <Badge tone={PLAN_REQUEST_STATUS_TONES[r.status]}>{PLAN_REQUEST_STATUS_LABELS[r.status]}</Badge>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
