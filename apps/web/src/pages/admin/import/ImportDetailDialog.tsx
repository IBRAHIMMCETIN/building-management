import { Download, MailCheck, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Dialog, Skeleton } from '@/components/ui';
import { useCompleteImport, useImportDetail, useImportPermissions, useRollbackImport, useSendImportInvitations } from '@/hooks/useImports';
import { errorMessage } from '@/lib/api/errors';
import type { ImportDetail } from '@/lib/api/imports';
import { formatDate, formatDateTime } from '@/lib/dates';
import { downloadReport } from '@/lib/import/excel';
import type { ReportLine } from '@/lib/import/sheetModel';
import { STATUS_LABEL } from './status';

const KIND_TO_SHEET = { unit: 'units', person: 'people', balance: 'balances', funds: 'funds' } as const;
const KIND_LABEL = { unit: 'Daire', person: 'Kişi', balance: 'Açılış bakiyesi', funds: 'Kasa/Banka' } as const;

function errorLines(d: ImportDetail): ReportLine[] {
  return d.errors.map((e) => ({ sheet: KIND_TO_SHEET[e.kind], row: e.row, label: e.label, message: e.message ?? 'Hata' }));
}

/** Aktarim ayrintisi: sayilar, hatalar, davet gonderimi, tamamla ve geri al. */
export function ImportDetailDialog({ importId, onClose }: { importId: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!importId} onClose={onClose} title="Aktarım ayrıntısı" className="max-w-2xl">
      {importId && <DetailBody key={importId} importId={importId} />}
    </Dialog>
  );
}

function DetailBody({ importId }: { importId: string }) {
  const { canWrite } = useImportPermissions();
  const detail = useImportDetail(importId);
  const invite = useSendImportInvitations();
  const rollback = useRollbackImport();
  const complete = useCompleteImport();
  const [confirmRollback, setConfirmRollback] = useState(false);
  const [reportBusy, setReportBusy] = useState(false);

  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-2 px-5 pb-5" role="status" aria-label="Yükleniyor">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  if (detail.isError) {
    return (
      <div className="px-5 pb-5">
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      </div>
    );
  }

  const d = detail.data;
  const busy = invite.isPending || rollback.isPending || complete.isPending;
  const rows: [string, keyof ImportDetail['counts']][] = [
    ['Daireler', 'unit'],
    ['Kişiler', 'person'],
    ['Açılış bakiyeleri', 'balance'],
    ['Kasa/Banka', 'funds'],
  ];

  return (
    <div className="flex flex-col gap-4 px-5 pb-5">
      <div className="flex flex-wrap items-center gap-2 text-small text-muted">
        <Badge tone={STATUS_LABEL[d.status].tone}>{STATUS_LABEL[d.status].label}</Badge>
        <span className="truncate" title={d.fileName}>
          {d.fileName}
        </span>
        <span>· devir {formatDate(d.asOfDate)}</span>
        <span>· {formatDateTime(d.createdAt)}</span>
      </div>

      <table className="w-full text-small">
        <thead className="text-xs uppercase text-muted">
          <tr>
            <th className="py-1 text-left" />
            <th className="py-1 text-right">Eklendi</th>
            <th className="py-1 text-right">Vardı</th>
            <th className="py-1 text-right">Hata</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, k]) => (
            <tr key={k} className="border-t border-border">
              <td className="py-1.5">{label}</td>
              <td className="py-1.5 text-right tabular-nums">{d.counts[k].created}</td>
              <td className="py-1.5 text-right tabular-nums text-muted">{d.counts[k].exists}</td>
              <td className="py-1.5 text-right tabular-nums">{d.counts[k].error ? <span className="text-danger">{d.counts[k].error}</span> : 0}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {d.rollbackReport && (
        <Alert>
          Geri alma: {d.rollbackReport.reversed} kayıt ters kayıtla iptal edildi, {d.rollbackReport.membershipsEnded} üyelik sonlandırıldı,{' '}
          {d.rollbackReport.unitsDeactivated} daire pasife alındı
          {d.rollbackReport.unitsKept > 0 && `, ${d.rollbackReport.unitsKept} daire başka hareketi olduğu için korundu`}.
        </Alert>
      )}

      {d.errors.length > 0 && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-small font-medium text-danger">{d.errors.length} satır yazılamadı</p>
            <Button
              variant="ghost"
              size="xs"
              loading={reportBusy}
              onClick={async () => {
                setReportBusy(true);
                try {
                  await downloadReport(errorLines(d));
                } finally {
                  setReportBusy(false);
                }
              }}
            >
              <Download className="size-4" aria-hidden="true" />
              Rapor
            </Button>
          </div>
          <ul className="max-h-40 overflow-auto text-small">
            {d.errors.slice(0, 50).map((e, i) => (
              <li key={`${e.kind}-${e.row ?? i}-${i}`} className="border-t border-border py-1">
                <span className="text-muted">
                  {KIND_LABEL[e.kind]}
                  {e.row ? ` · satır ${e.row}` : ''} ·{' '}
                </span>
                {e.label} — <span className="text-danger">{e.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {invite.isSuccess && <Alert tone="success">{invite.data.sent} davet e-postası gönderildi.</Alert>}
      {rollback.isSuccess && <Alert tone="success">Aktarım geri alındı.</Alert>}
      {(invite.isError || rollback.isError || complete.isError) && (
        <Alert tone="danger">{errorMessage(invite.error ?? rollback.error ?? complete.error)} Tekrar denerseniz kaldığı yerden devam eder.</Alert>
      )}

      {canWrite && d.status !== 'rolled_back' && (
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          {confirmRollback ? (
            <div className="flex flex-col gap-3">
              <Alert tone="danger">
                Bu aktarımla yazılan açılış bakiyeleri ters kayıtla iptal edilecek, üyelikler sonlandırılacak ve başka hareketi olmayan daireler
                pasife alınacak. Aktarımdan sonra girilen kayıtlar etkilenmez.
              </Alert>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="danger"
                  loading={rollback.isPending}
                  onClick={() =>
                    rollback.mutate(
                      { importId: d.importId },
                      { onSettled: () => void detail.refetch(), onSuccess: () => setConfirmRollback(false) },
                    )
                  }
                >
                  Evet, geri al
                </Button>
                <Button variant="ghost" disabled={rollback.isPending} onClick={() => setConfirmRollback(false)}>
                  Vazgeç
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {d.pendingInvitations > 0 && (
                <Button
                  loading={invite.isPending}
                  disabled={busy}
                  onClick={() => invite.mutate(d.importId, { onSettled: () => void detail.refetch() })}
                >
                  <MailCheck className="size-4" aria-hidden="true" />
                  Davetleri gönder ({d.pendingInvitations})
                </Button>
              )}
              {d.status === 'in_progress' && (
                <Button
                  variant="secondary"
                  loading={complete.isPending}
                  disabled={busy}
                  onClick={() => complete.mutate(d.importId, { onSettled: () => void detail.refetch() })}
                >
                  Tamamlandı olarak işaretle
                </Button>
              )}
              <Button variant="subtle" disabled={busy} onClick={() => setConfirmRollback(true)}>
                <Undo2 className="size-4" aria-hidden="true" />
                Geri al
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
