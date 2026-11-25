import { CalendarCheck2, FileText, Lock, LockOpen, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { useClosePeriod, usePeriodChecklist, usePeriodStatus, useReopenPeriod } from '@/hooks/useFinancePeriods';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { errorMessage } from '@/lib/api/errors';
import { type ChecklistItem, type FiscalPeriodView, financePeriodsApi, formatPeriod } from '@/lib/api/financePeriods';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

const previousMonth = () => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
  const [y, m] = today.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

/**
 * Finans 2.4 - Mali donem kapanisi. Kapanan ayin defteri kilitlenir (kapali doneme tahakkuk,
 * tahsilat veya ters kayit yazilamaz); kapanis aninda aylik mizan goruntusu saklanir. Engeller
 * giderilmeden kapanmaz; uyarilar tek tek onaylanir. Yalnizca son kapanan ay gerekceyle acilir.
 */
export function PeriodClosingPanel({ canWrite }: { canWrite: boolean }) {
  const status = usePeriodStatus();
  const [reopening, setReopening] = useState<FiscalPeriodView | null>(null);
  const docs = useOpenDocument();

  if (status.isPending) return <Skeleton className="h-48 w-full" />;
  if (status.isError) return <Alert tone="danger">{errorMessage(status.error)}</Alert>;
  const s = status.data;
  const closed = [...s.periods].filter((p) => p.status === 'closed').sort((a, b) => b.period.localeCompare(a.period));

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-8 gap-y-3">
        <div className="flex items-center gap-2">
          <CalendarCheck2 className="size-5 text-muted" aria-hidden="true" />
          <h2 className="font-semibold">Dönem kapanışı</h2>
        </div>
        <div>
          <p className="text-xs text-muted">Kilit</p>
          <p className="flex items-center gap-1.5 font-medium">
            {s.lockedThrough ? (
              <>
                <Lock className="size-4 text-muted" aria-hidden="true" />
                {formatDate(s.lockedThrough)} dahil öncesi kapalı
              </>
            ) : (
              <>
                <LockOpen className="size-4 text-muted" aria-hidden="true" />
                Henüz kapanış yapılmadı
              </>
            )}
          </p>
        </div>
        {s.lastClosedPeriod && (
          <div>
            <p className="text-xs text-muted">Son kapanan ay</p>
            <p className="font-medium">{formatPeriod(s.lastClosedPeriod)}</p>
          </div>
        )}
      </Card>

      {s.closing && <Alert tone="info">{formatPeriod(s.closing)} kapanışı yarıda kaldı. Aynı ayı yeniden kapatarak tamamlayabilirsiniz.</Alert>}

      {canWrite && (
        <CloseCard
          key={`${s.lockVersion}-${s.nextClosable ?? ''}`}
          firstClose={s.firstClose}
          nextClosable={s.closing ?? s.nextClosable}
          lockVersion={s.lockVersion}
        />
      )}

      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-small">
          <caption className="px-4 pt-3 text-left font-semibold">Kapanan dönemler</caption>
          <thead className="border-b border-border text-xs text-muted">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Dönem</th>
              <th scope="col" className="px-4 py-2 font-medium">Kapanış</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">İşlem</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">Borç = Alacak</th>
              <th scope="col" className="px-4 py-2 font-medium">Onaylanan uyarılar</th>
              <th scope="col" className="px-4 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {closed.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-4 text-muted">
                  Henüz kapanan dönem yok.
                </td>
              </tr>
            )}
            {closed.map((p) => (
              <tr key={p.period}>
                <td className="px-4 py-2 font-medium">
                  {formatPeriod(p.period)}
                  {p.revision > 1 && (
                    <Badge tone="warning" className="ml-2">
                      {p.revision}. kapanış
                    </Badge>
                  )}
                </td>
                <td className="px-4 py-2 text-muted">{formatDateTime(p.closedAt)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{p.totals?.transactions ?? '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{p.totals?.debit !== undefined ? formatTRY(p.totals.debit) : '—'}</td>
                <td className="px-4 py-2 text-xs text-muted">{p.acknowledgedWarnings.length ? p.acknowledgedWarnings.map((w) => w.message).join(' · ') : '—'}</td>
                <td className="px-4 py-2 text-right whitespace-nowrap">
                  <Button
                    size="xs"
                    variant="subtle"
                    loading={docs.pendingId === p.period}
                    onClick={() => docs.open(p.period, () => financePeriodsApi.reportPdf('trial-balance', { from: p.period, to: p.period }))}
                  >
                    <FileText className="size-3.5" aria-hidden="true" />
                    Mizan PDF
                  </Button>
                  {canWrite && p.period === s.lastClosedPeriod && !s.closing && (
                    <Button size="xs" variant="subtle" onClick={() => setReopening(p)}>
                      <RotateCcw className="size-3.5" aria-hidden="true" />
                      Yeniden aç
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {canWrite && <ReopenDialog period={reopening} onClose={() => setReopening(null)} />}
    </div>
  );
}

function CloseCard({ firstClose, nextClosable, lockVersion }: { firstClose: boolean; nextClosable?: string; lockVersion: number }) {
  const [period, setPeriod] = useState(nextClosable ?? previousMonth());
  const [ack, setAck] = useState<string[]>([]);
  const checklist = usePeriodChecklist(period || undefined);
  const close = useClosePeriod();
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => setAck([]), [period]);

  if (!nextClosable && !firstClose) {
    return <Alert tone="info">Kapatılabilecek tamamlanmış ay yok. Bir sonraki kapanış, içinde bulunulan ay bittiğinde yapılabilir.</Alert>;
  }
  const c = checklist.data;
  const allAcked = !!c && c.warnings.every((w) => ack.includes(w.code));

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-4">
        {firstClose ? (
          <FormField label="Kapatılacak ay" hint="İlk kapanışta tamamlanmış herhangi bir ayı seçebilirsiniz; sonrakiler sırayla kapanır.">
            <Input type="month" value={period} max={previousMonth()} onChange={(e) => setPeriod(e.target.value)} />
          </FormField>
        ) : (
          <div>
            <p className="text-xs text-muted">Sıradaki kapanış</p>
            <p className="text-lg font-semibold">{formatPeriod(period)}</p>
          </div>
        )}
        {c?.preview?.totals?.transactions !== undefined && (
          <p className="text-small text-muted">
            Bu ay {c.preview.totals.transactions} işlem · borç/alacak {formatTRY(c.preview.totals.debit ?? 0)}
          </p>
        )}
      </div>

      {checklist.isPending && period && <Skeleton className="h-16 w-full" />}
      {checklist.isError && <Alert tone="danger">{errorMessage(checklist.error)}</Alert>}
      {c && (
        <>
          {c.sequenceError && <Alert tone="danger">{c.sequenceError}</Alert>}
          {c.blockers.length > 0 && <ChecklistList title="Kapanışı engelleyenler" items={c.blockers} tone="danger" />}
          {c.warnings.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-small font-medium">Onay gerektiren uyarılar</legend>
              {c.warnings.map((w) => (
                <label key={w.code} className="flex items-start gap-2 text-small">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={ack.includes(w.code)}
                    onChange={(e) => setAck((a) => (e.target.checked ? [...a, w.code] : a.filter((x) => x !== w.code)))}
                  />
                  <span>
                    {w.message}
                    {w.amount !== undefined && <span className="text-muted"> · {formatTRY(w.amount)}</span>}
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          {c.canClose && c.blockers.length === 0 && c.warnings.length === 0 && <Alert tone="success">Kontroller temiz; dönem kapatılabilir.</Alert>}
        </>
      )}

      {close.isError && <Alert tone="danger">{errorMessage(close.error)}</Alert>}
      {done && <Alert tone="success">{formatPeriod(done)} kapatıldı. Bu ay ve öncesine artık kayıt yazılamaz.</Alert>}
      <div>
        <Button
          disabled={!c?.canClose || !allAcked}
          loading={close.isPending}
          onClick={() =>
            close.mutate(
              { period, expectedLockVersion: c?.lockVersion ?? lockVersion, acknowledgeWarnings: ack },
              { onSuccess: () => setDone(period) },
            )
          }
        >
          <Lock className="size-4" aria-hidden="true" />
          {formatPeriod(period)} dönemini kapat
        </Button>
      </div>
    </Card>
  );
}

function ChecklistList({ title, items, tone }: { title: string; items: ChecklistItem[]; tone: 'danger' }) {
  return (
    <Alert tone={tone}>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 list-disc pl-5">
        {items.map((i) => (
          <li key={i.code}>{i.message}</li>
        ))}
      </ul>
    </Alert>
  );
}

function ReopenDialog({ period, onClose }: { period: FiscalPeriodView | null; onClose: () => void }) {
  const reopen = useReopenPeriod();
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (period) {
      setReason('');
      reopen.reset();
    }
  }, [period]);
  const tooShort = reason.trim().length < 10;
  return (
    <Dialog open={!!period} onClose={onClose} title={period ? `${formatPeriod(period.period)} dönemini yeniden aç` : 'Dönemi yeniden aç'}>
      <div className="flex flex-col gap-4">
        <p className="text-small text-muted">
          Kilit bir önceki duruma döner ve bu aya yeniden kayıt yazılabilir. İşlem denetim kaydına gerekçesiyle birlikte yazılır; tekrar
          kapatıldığında dönem yeni bir revizyonla saklanır.
        </p>
        <FormField label="Gerekçe" hint="En az 10 karakter">
          <Textarea rows={3} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        {reopen.isError && <Alert tone="danger">{errorMessage(reopen.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            variant="danger"
            disabled={tooShort}
            loading={reopen.isPending}
            onClick={() => period && reopen.mutate({ period: period.period, reason: reason.trim() }, { onSuccess: onClose })}
          >
            Yeniden aç
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
