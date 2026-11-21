import { ArrowLeftRight, RotateCcw, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FilterChips, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { usePlatformPayouts, usePlatformSettlements, useReleaseSettlement, useResendPayout } from '@/hooks/usePayments';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { Payout, Settlement } from '@/lib/api/payments';
import { formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { normalizeIban } from '@/lib/payments/manager';
import {
  type PayoutGroup,
  PAYOUT_GROUP_OPTIONS,
  canResend,
  payoutQueryFor,
  payoutStatusLabel,
  payoutStatusTone,
  providerLabel,
  settlementView,
} from '@/lib/payments/platform';
import { noteError } from '@/lib/payments/review';

type GroupFilter = PayoutGroup | 'attention';

const DAY_OPTIONS = [7, 30, 90, 400] as const;

// ---------------------------------------------------------------------------
// Aktarimi bekleyen / basarisiz odemeler (onay asamasi) + "Simdi tetikle"
// ---------------------------------------------------------------------------

function ReleaseDialog({ target, onClose }: { target: Settlement | null; onClose: () => void }) {
  const release = useReleaseSettlement();
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setNote('');
    setError(undefined);
    release.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [target?.intentId]);

  const submit = async () => {
    if (!target) return;
    const e = noteError(note);
    if (e) {
      setError(e);
      return;
    }
    try {
      await release.mutateAsync({ apartmentId: target.apartmentId, intentId: target.intentId, input: { note: note.trim(), expectedVersion: target.version } });
      onClose();
    } catch {
      // hata asagida
    }
  };

  return (
    <Dialog open={target !== null} onClose={onClose} title="Aktarımı şimdi tetikle">
      {target && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{target.apartmentName ?? target.apartmentId}</strong> · daire {target.unitId} ·{' '}
            {formatTRY(target.transferAmount)} apartman hesabına aktarılacak. Bekleme süresi atlanır ve onay sağlayıcıya hemen gönderilir; kayıtlı
            IBAN kullanılır.
          </p>
          <FormField label="Gerekçe" error={error} hint="Denetim kaydına yazılır (5-500 karakter).">
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setError(undefined);
              }}
            />
          </FormField>
          {release.isError && (
            <Alert tone="danger">
              {errorMessage(release.error)}
              {release.error instanceof ApiError && release.error.status === 409 && ' Liste yenilendi; kaydı yeniden açın.'}
            </Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button loading={release.isPending} onClick={() => void submit()}>
              <Send className="size-4" aria-hidden="true" />
              Şimdi tetikle
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SettlementsCard() {
  const list = usePlatformSettlements(30);
  const [open, setOpen] = useState<Settlement | null>(null);
  const dialog = <ReleaseDialog target={open} onClose={() => setOpen(null)} />;

  if (list.isPending) return <Skeleton className="h-24 w-full" />;
  if (list.isError) return <Alert tone="danger">Bekleyen aktarımlar yüklenemedi: {errorMessage(list.error)}</Alert>;

  const items = list.data.items;
  const failed = items.filter((i) => settlementView(i).tone === 'danger').length;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Onay bekleyen aktarımlar (son 30 gün)</CardTitle>
        <span className="text-small text-muted">
          {items.length - failed} bekliyor · {failed} başarısız
        </span>
      </div>
      <p className="text-small text-muted">
        Deftere yazılmış ödemelerin apartman payı, bekleme süresi dolunca zamanlanmış görevle sağlayıcıya onaylanır. Başarısız olanlar (ör. IBAN yok)
        düzeltildikten sonra burada elle tetiklenebilir.
      </p>
      {items.length === 0 ? (
        <p className="py-3 text-center text-small text-muted">Bekleyen ya da başarısız aktarım yok.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Onay bekleyen aktarımlar">
          {items.map((s) => {
            const v = settlementView(s);
            return (
              <li
                key={`${s.apartmentId}:${s.intentId}`}
                className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{s.apartmentName ?? s.apartmentId}</p>
                    <Badge tone={v.tone}>{v.label}</Badge>
                    <Badge>{providerLabel(s.provider)}</Badge>
                    <span className="font-semibold tabular-nums">{formatTRY(s.transferAmount)}</span>
                  </div>
                  <p className="text-small text-muted">
                    Daire {s.unitId} · tahsilat {formatTRY(s.amount)}
                    {s.paidAt && ` · ${formatDateTime(s.paidAt)}`}
                  </p>
                  <p className={v.tone === 'danger' ? 'text-small text-danger' : 'text-small text-muted'}>{v.detail}</p>
                </div>
                <Button size="sm" variant={v.tone === 'danger' ? 'primary' : 'secondary'} onClick={() => setOpen(s)}>
                  Şimdi tetikle
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {dialog}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Bankaya gonderilmis aktarimlar + geri donen / basarisiz icin yeniden gonderim
// ---------------------------------------------------------------------------

function ResendDialog({ target, onClose }: { target: Payout | null; onClose: () => void }) {
  const resend = useResendPayout();
  const [note, setNote] = useState('');
  const [changeIban, setChangeIban] = useState(false);
  const [iban, setIban] = useState('');
  const [holder, setHolder] = useState('');
  const [errors, setErrors] = useState<{ note?: string; iban?: string; holder?: string }>({});

  useEffect(() => {
    setNote('');
    setChangeIban(false);
    setIban('');
    setHolder('');
    setErrors({});
    resend.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [target?.transferId]);

  const submit = async () => {
    if (!target) return;
    const next: typeof errors = { note: noteError(note) };
    const normalized = changeIban ? normalizeIban(iban) : null;
    if (changeIban) {
      if (!normalized) next.iban = 'Geçerli bir TR IBAN girin.';
      const h = holder.trim().length;
      if (h < 2 || h > 140) next.holder = 'Hesap sahibi adı 2-140 karakter olmalı.';
    }
    if (next.note || next.iban || next.holder) {
      setErrors(next);
      return;
    }
    try {
      await resend.mutateAsync({
        apartmentId: target.apartmentId,
        transferId: target.transferId,
        input: {
          note: note.trim(),
          expectedVersion: target.version,
          ...(changeIban && normalized ? { iban: normalized, accountHolderName: holder.trim() } : {}),
        },
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 400 && err.field === 'iban') setErrors({ iban: err.message });
      if (err instanceof ApiError && err.status === 400 && err.field === 'accountHolderName') setErrors({ holder: err.message });
    }
  };

  return (
    <Dialog open={target !== null} onClose={onClose} title="Aktarımı yeniden gönder">
      {target && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{target.apartmentName ?? target.apartmentId}</strong> · {formatTRY(target.amount)} · gönderilen IBAN{' '}
            <span className="font-mono">{target.ibanMasked}</span>
            {target.returned && ` · geri dönüş ${target.returned.returnedOn ?? formatDateTime(target.returned.detectedAt)}`}
          </p>
          {target.resend?.error && <Alert tone="danger">Son deneme: {target.resend.error.message}</Alert>}
          <label className="flex items-center gap-2 text-small">
            <input type="checkbox" checked={changeIban} onChange={(e) => setChangeIban(e.target.checked)} />
            Düzeltilmiş IBAN ile gönder (apartman hesabına da kaydedilir)
          </label>
          {changeIban && (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="IBAN (tam)" error={errors.iban}>
                <Input autoComplete="off" spellCheck={false} placeholder="TR00 0000 …" value={iban} onChange={(e) => setIban(e.target.value)} />
              </FormField>
              <FormField label="Hesap sahibi adı" error={errors.holder}>
                <Input autoComplete="off" value={holder} onChange={(e) => setHolder(e.target.value)} />
              </FormField>
            </div>
          )}
          {!changeIban && <p className="text-small text-muted">Apartmanın kayıtlı (şifreli) IBAN’ı kullanılır.</p>}
          <FormField label="Gerekçe" error={errors.note} hint="Denetim kaydına yazılır (5-500 karakter).">
            <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
          </FormField>
          {resend.isError && !(resend.error instanceof ApiError && resend.error.status === 400 && resend.error.field) && (
            <Alert tone="danger">{errorMessage(resend.error)}</Alert>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button loading={resend.isPending} onClick={() => void submit()}>
              <RotateCcw className="size-4" aria-hidden="true" />
              Yeniden gönder
            </Button>
          </div>
          <p className="text-small text-muted">Talep kuyruğa alınır; zamanlanmış görev birkaç dakika içinde sağlayıcıya iletir.</p>
        </div>
      )}
    </Dialog>
  );
}

function PayoutRow({ p, onResend }: { p: Payout; onResend: () => void }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium">{p.apartmentName ?? p.apartmentId}</p>
          <Badge tone={payoutStatusTone(p.status)}>{payoutStatusLabel(p.status)}</Badge>
          <Badge>{providerLabel(p.provider)}</Badge>
          <span className="font-semibold tabular-nums">{formatTRY(p.amount)}</span>
        </div>
        <p className="text-small text-muted">
          <span className="font-mono">{p.resend?.ibanMasked ?? p.ibanMasked}</span> · gönderim {formatDateTime(p.sentAt)} · {p.transferId}
          {p.settledAt && ` · tamamlandı ${formatDateTime(p.settledAt)}`}
        </p>
        {p.returned && (
          <p className="text-small text-danger">
            Geri döndü: {formatTRY(p.returned.amount)} · ref {p.returned.refNo}
            {p.returned.returnedOn && ` · ${p.returned.returnedOn}`}
          </p>
        )}
        {p.resend && (
          <p className="text-small text-muted">
            Yeniden gönderim {p.resend.resendId} · {p.resend.attempts} deneme · “{p.resend.note}”
            {p.resend.error && <span className="text-danger"> · {p.resend.error.message}</span>}
          </p>
        )}
      </div>
      {canResend(p.status) && (
        <Button size="sm" onClick={onResend}>
          Yeniden gönder
        </Button>
      )}
    </li>
  );
}

function PayoutsCard() {
  const [group, setGroup] = useState<GroupFilter>('attention');
  const [days, setDays] = useState<number>(30);
  const query = payoutQueryFor(group);
  const list = usePlatformPayouts(query.status, days);
  const [open, setOpen] = useState<Payout | null>(null);

  const items = useMemo(() => {
    const all = list.data?.items ?? [];
    return query.filter ? all.filter((p) => query.filter?.includes(p.status)) : all;
  }, [list.data, query.filter]);

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Bankaya gönderilen aktarımlar</CardTitle>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <FilterChips<GroupFilter> label="Aktarım durumu" value={group} onChange={setGroup} options={PAYOUT_GROUP_OPTIONS} />
        <label className="flex items-center gap-2 text-small sm:w-48">
          <span className="shrink-0 text-muted">Dönem</span>
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_OPTIONS.map((d) => (
              <option key={d} value={d}>
                Son {d} gün
              </option>
            ))}
          </Select>
        </label>
      </div>
      {list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : list.isError ? (
        <div className="flex flex-col items-start gap-2">
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" size="sm" onClick={() => void list.refetch()}>
            Tekrar dene
          </Button>
        </div>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-small text-muted">Bu filtreye uyan aktarım yok.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="Aktarımlar">
          {items.map((p) => (
            <PayoutRow key={`${p.apartmentId}:${p.transferId}`} p={p} onResend={() => setOpen(p)} />
          ))}
        </ul>
      )}
      <ResendDialog target={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

/** Platform yoneticisi: PayTR pazaryeri aktarimlari (onay, banka transferi, geri donen odemeler). */
export function PlatformPayoutsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <ArrowLeftRight className="size-5" aria-hidden="true" />
          Aktarımlar
        </h1>
        <p className="text-small text-muted">
          Sakin ödemelerinden apartman payının apartman IBAN’ına aktarımı. IBAN’lar maskeli gösterilir; tam IBAN yalnızca şifreli saklanır.
        </p>
      </div>
      <SettlementsCard />
      <PayoutsCard />
    </div>
  );
}
