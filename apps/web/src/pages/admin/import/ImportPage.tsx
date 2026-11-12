import { History } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Skeleton } from '@/components/ui';
import { useImportPermissions, useImports } from '@/hooks/useImports';
import { errorMessage } from '@/lib/api/errors';
import type { ImportJob } from '@/lib/api/imports';
import { formatDate, formatDateTime } from '@/lib/dates';
import { ImportDetailDialog } from './ImportDetailDialog';
import { ImportWizard } from './ImportWizard';
import { STATUS_LABEL } from './status';

export function ImportPage() {
  const { canRead, canWrite } = useImportPermissions();
  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Toplu Aktarım</h1>
        <Alert>Bu rol toplu aktarımları görüntüleyemez.</Alert>
      </div>
    );
  }
  return (
    <div className="flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="text-title font-bold">Toplu Aktarım</h1>
        <p className="text-small text-muted">Excel/CSV ile daire, malik/kiracı ve devir bakiyelerini tek seferde yükleyin.</p>
      </div>
      {canWrite ? <ImportWizard /> : <Alert>Salt okunur görünüm: aktarımı yalnızca apartman yöneticisi yapabilir.</Alert>}
      <ImportHistory />
    </div>
  );
}

function countText(job: ImportJob) {
  const c = job.counts;
  if (!c) return `${job.totals.units} daire · ${job.totals.people} kişi · ${job.totals.balances} bakiye`;
  return `${c.unit.created} daire · ${c.person.created} kişi · ${c.balance.created} bakiye`;
}

function ImportHistory() {
  const imports = useImports();
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle className="flex items-center gap-2">
        <History className="size-4 text-muted" aria-hidden="true" />
        Geçmiş aktarımlar
      </CardTitle>
      {imports.isPending ? (
        <div role="status" aria-label="Aktarımlar yükleniyor" className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : imports.isError ? (
        <div className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(imports.error)}</Alert>
          <Button variant="secondary" onClick={() => void imports.refetch()}>
            Tekrar dene
          </Button>
        </div>
      ) : imports.data.length === 0 ? (
        <p className="text-small text-muted">Henüz aktarım yapılmadı.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-small">
            <thead className="bg-surface-muted text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Tarih</th>
                <th className="px-3 py-2 text-left">Dosya</th>
                <th className="px-3 py-2 text-left">Devir</th>
                <th className="px-3 py-2 text-left">Kayıtlar</th>
                <th className="px-3 py-2 text-left">Durum</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {imports.data.map((job) => (
                <tr key={job.importId} className="border-t border-border hover:bg-surface-muted/50">
                  <td className="px-3 py-2 whitespace-nowrap">{formatDateTime(job.createdAt)}</td>
                  <td className="max-w-56 truncate px-3 py-2" title={job.fileName}>
                    {job.fileName}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{formatDate(job.asOfDate)}</td>
                  <td className="px-3 py-2 text-muted">{countText(job)}</td>
                  <td className="px-3 py-2">
                    <Badge tone={STATUS_LABEL[job.status].tone}>{STATUS_LABEL[job.status].label}</Badge>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" size="xs" onClick={() => setSelected(job.importId)}>
                      Ayrıntı
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ImportDetailDialog importId={selected} onClose={() => setSelected(null)} />
    </Card>
  );
}
