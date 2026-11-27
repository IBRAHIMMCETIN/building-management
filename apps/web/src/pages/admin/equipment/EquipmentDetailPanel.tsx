import { Archive, FileText, Pencil, Power, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { TaskStatusBadge, TicketStatusBadge } from '@/components/tickets/TicketBadges';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useAddEquipmentDocument, useArchiveEquipmentDocument, useEquipment, useEquipmentHistory, useEquipmentPermissions, useEquipmentStatus } from '@/hooks/useEquipment';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { INVOICE_ACCEPT, invoiceFileError } from '@/lib/api/documentModel';
import { type Equipment, type EquipmentHistory, equipmentApi } from '@/lib/api/equipment';
import { errorMessage } from '@/lib/api/errors';
import { formatDate } from '@/lib/dates';
import {
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABELS,
  EQUIPMENT_CATEGORY_LABELS,
  type EquipmentDocumentKind,
  type EquipmentStatus,
  INSPECTION_LABEL_TEXT,
  equipmentLocationText,
} from '@/lib/equipment/model';
import type { TaskStatus } from '@/lib/maintenance/schedule';
import { formatTRY } from '@/lib/money';
import type { TicketStatus } from '@/lib/tickets/model';
import { EquipmentStatusBadge, ExpiryBadge } from './shared';

type Props = { equipmentId: string | null; onClose: () => void; onEdit: (e: Equipment) => void; blockName: (id: string) => string | undefined };

/** Ekipman ayrintisi (sagdan panel): bilgiler, durum, belgeler, gecmis (talepler, bakimlar, masraflar). */
export function EquipmentDetailPanel({ equipmentId, onClose, onEdit, blockName }: Props) {
  const detail = useEquipment(equipmentId);
  return (
    <Dialog open={!!equipmentId} onClose={onClose} title={detail.data?.name ?? 'Ekipman'} variant="panel">
      {!equipmentId ? null : detail.isPending ? (
        <Skeleton className="h-96" />
      ) : detail.isError ? (
        <Alert tone="danger">{errorMessage(detail.error)}</Alert>
      ) : (
        <EquipmentDetail key={`${detail.data.equipmentId}-${detail.data.version}`} equipment={detail.data} onEdit={onEdit} blockName={blockName} />
      )}
    </Dialog>
  );
}

function EquipmentDetail({ equipment: e, onEdit, blockName }: { equipment: Equipment; onEdit: (e: Equipment) => void; blockName: (id: string) => string | undefined }) {
  const [statusTo, setStatusTo] = useState<EquipmentStatus | null>(null);
  const service = e.serviceCompany;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <EquipmentStatusBadge status={e.status} />
        <span className="text-xs text-muted">{EQUIPMENT_CATEGORY_LABELS[e.category]}</span>
        {e.canEdit && (
          <Button size="xs" variant="subtle" className="ml-auto" onClick={() => onEdit(e)}>
            <Pencil className="size-3.5" aria-hidden="true" />
            Düzenle
          </Button>
        )}
      </div>

      {e.expiry.length > 0 && (
        <div className="flex flex-wrap gap-1.5" aria-label="Son tarihler">
          {e.expiry.map((x) => (
            <ExpiryBadge key={x.kind} item={x} />
          ))}
        </div>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
        <dt className="text-muted">Konum</dt>
        <dd>{equipmentLocationText(e, blockName)}</dd>
        {(e.brand || e.model) && (
          <>
            <dt className="text-muted">Marka / model</dt>
            <dd>{[e.brand, e.model].filter(Boolean).join(' · ')}</dd>
          </>
        )}
        {e.serialNumber && (
          <>
            <dt className="text-muted">Seri no</dt>
            <dd className="font-mono text-xs">{e.serialNumber}</dd>
          </>
        )}
        {e.installDate && (
          <>
            <dt className="text-muted">Kurulum</dt>
            <dd>{formatDate(e.installDate)}</dd>
          </>
        )}
        <dt className="text-muted">Garanti bitişi</dt>
        <dd>{e.warrantyEndDate ? formatDate(e.warrantyEndDate) : '—'}</dd>
        <dt className="text-muted">Servis firması</dt>
        <dd>
          {service?.name ?? '—'}
          {service?.phone && (
            <a href={`tel:${service.phone.replace(/\s/g, '')}`} className="ml-2 text-accent underline-offset-2 hover:underline">
              {service.phone}
            </a>
          )}
          {service?.email && (
            <a href={`mailto:${service.email}`} className="ml-2 text-accent underline-offset-2 hover:underline">
              {service.email}
            </a>
          )}
        </dd>
        <dt className="text-muted">Servis sözleşmesi</dt>
        <dd>{e.serviceContractEndDate ? `${formatDate(e.serviceContractEndDate)} bitiş` : '—'}</dd>
        <dt className="text-muted">Periyodik kontrol</dt>
        <dd>
          {e.lastInspectionDate ? `Son ${formatDate(e.lastInspectionDate)}` : 'Son kontrol yok'}
          {e.nextInspectionDate ? ` · sonraki ${formatDate(e.nextInspectionDate)}` : ''}
          {e.inspectionLabel && <span className="block text-xs text-muted">{INSPECTION_LABEL_TEXT[e.inspectionLabel]}</span>}
        </dd>
        {e.statusNote && (
          <>
            <dt className="text-muted">Durum notu</dt>
            <dd>{e.statusNote}</dd>
          </>
        )}
      </dl>

      {e.notes && <p className="whitespace-pre-wrap rounded-lg bg-surface-muted/40 p-3 text-small">{e.notes}</p>}

      {e.canEdit && (
        <div className="flex flex-wrap gap-2" aria-label="Durum işlemleri">
          {e.status !== 'active' && (
            <Button size="sm" variant="secondary" onClick={() => setStatusTo('active')}>
              <Power className="size-4" aria-hidden="true" />
              Çalışıyor olarak işaretle
            </Button>
          )}
          {e.status === 'active' && (
            <Button size="sm" variant="secondary" onClick={() => setStatusTo('out_of_service')}>
              Devre dışı bırak
            </Button>
          )}
          {e.status !== 'retired' && (
            <Button size="sm" variant="ghost" onClick={() => setStatusTo('retired')}>
              Hizmetten çıkar
            </Button>
          )}
        </div>
      )}

      <DocumentsSection equipment={e} />
      <HistorySection equipmentId={e.equipmentId} />

      {statusTo && <StatusDialog equipment={e} to={statusTo} onClose={() => setStatusTo(null)} />}
    </div>
  );
}

const STATUS_ACTION: Record<EquipmentStatus, string> = { active: 'Çalışıyor olarak işaretle', out_of_service: 'Devre dışı bırak', retired: 'Hizmetten çıkar' };

function StatusDialog({ equipment, to, onClose }: { equipment: Equipment; to: EquipmentStatus; onClose: () => void }) {
  const status = useEquipmentStatus();
  const [note, setNote] = useState('');
  const required = to === 'retired';
  return (
    <Dialog open onClose={onClose} title={`${equipment.name}: ${STATUS_ACTION[to]}`}>
      <div className="flex flex-col gap-4">
        {to === 'retired' && <p className="text-small text-muted">Kayıt silinmez; geçmişi ve belgeleri korunur. Yeni arıza veya bakım bu ekipmana bağlanamaz.</p>}
        <FormField label={required ? 'Gerekçe' : 'Not (isteğe bağlı)'}>
          <Textarea rows={3} value={note} onChange={(ev) => setNote(ev.target.value)} maxLength={500} />
        </FormField>
        {status.isError && <Alert tone="danger">{errorMessage(status.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            variant={to === 'retired' ? 'danger' : 'primary'}
            loading={status.isPending}
            disabled={required && note.trim().length < 3}
            onClick={() => status.mutate({ id: equipment.equipmentId, version: equipment.version, status: to, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onClose })}
          >
            {STATUS_ACTION[to]}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function DocumentsSection({ equipment: e }: { equipment: Equipment }) {
  const docs = useOpenDocument();
  const archive = useArchiveEquipmentDocument(e.equipmentId);
  const [adding, setAdding] = useState(false);
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h3 className="text-small font-semibold">Belgeler</h3>
        {e.canEdit && !adding && (
          <Button size="xs" variant="subtle" className="ml-auto" onClick={() => setAdding(true)}>
            <Upload className="size-3.5" aria-hidden="true" />
            Belge ekle
          </Button>
        )}
      </div>
      {adding && <DocumentForm equipment={e} onDone={() => setAdding(false)} />}
      {e.documents.length === 0 ? (
        <p className="text-small text-muted">Henüz belge yok. Garanti belgesi, servis sözleşmesi veya periyodik kontrol raporunu ekleyebilirsiniz.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {e.documents.map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border px-3 py-2 text-small">
              <FileText className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{d.title}</span>
                <span className="block text-xs text-muted">
                  {DOCUMENT_KIND_LABELS[d.kind]} · {formatDate(d.uploadedAt)}
                  {d.validUntil ? ` · geçerlilik ${formatDate(d.validUntil)}` : ''}
                </span>
              </span>
              {d.status === 'archived' && <Badge>Arşiv</Badge>}
              <Button size="xs" variant="subtle" loading={docs.pendingId === d.documentId} onClick={() => void docs.open(d.documentId, () => equipmentApi.document(e.equipmentId, d.documentId))}>
                Aç
              </Button>
              {e.canEdit && d.status === 'active' && (
                <Button
                  size="xs"
                  variant="subtle"
                  aria-label={`${d.title} arşivle`}
                  loading={archive.isPending && archive.variables?.documentId === d.documentId}
                  onClick={() => {
                    if (window.confirm(`"${d.title}" arşivlensin mi? Belge silinmez, listede arşiv olarak kalır.`)) archive.mutate({ documentId: d.documentId, version: e.version });
                  }}
                >
                  <Archive className="size-3.5" aria-hidden="true" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
      {archive.isError && <Alert tone="danger">{errorMessage(archive.error)}</Alert>}
    </section>
  );
}

function DocumentForm({ equipment, onDone }: { equipment: Equipment; onDone: () => void }) {
  const add = useAddEquipmentDocument(equipment.equipmentId);
  const [kind, setKind] = useState<EquipmentDocumentKind>('warranty');
  const [title, setTitle] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const fileError = file ? invoiceFileError(file) : null;
  useEffect(() => add.reset(), [file]); // eslint-disable-line react-hooks/exhaustive-deps -- yeni dosyada eski hata silinir

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Belge türü">
          <Select value={kind} onChange={(ev) => setKind(ev.target.value as EquipmentDocumentKind)}>
            {DOCUMENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {DOCUMENT_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Geçerlilik sonu (isteğe bağlı)">
          <Input type="date" value={validUntil} onChange={(ev) => setValidUntil(ev.target.value)} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Başlık (isteğe bağlı)" hint="Boşsa dosya adı kullanılır.">
            <Input value={title} onChange={(ev) => setTitle(ev.target.value)} maxLength={120} />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          <FormField label="Dosya" error={fileError ?? undefined} hint="PDF veya fotoğraf, en fazla 10 MB.">
            <Input
              type="file"
              accept={INVOICE_ACCEPT}
              className="h-auto py-1.5 file:mr-3 file:rounded-md file:border-0 file:bg-surface-muted file:px-3 file:py-1 file:text-xs file:font-medium file:text-text"
              onChange={(ev) => setFile(ev.target.files?.[0] ?? null)}
            />
          </FormField>
        </div>
      </div>
      {kind === 'contract' && <p className="text-xs text-muted">Servis sözleşmesi bina görevlisine gösterilmez.</p>}
      {add.isError && <Alert tone="danger">{errorMessage(add.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onDone} disabled={add.isPending}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          loading={add.isPending}
          disabled={!file || !!fileError}
          onClick={() =>
            file &&
            add.mutate(
              { version: equipment.version, file, kind, ...(title.trim() ? { title: title.trim() } : {}), ...(validUntil ? { validUntil } : {}) },
              { onSuccess: onDone },
            )
          }
        >
          Yükle
        </Button>
      </div>
    </div>
  );
}

function HistorySection({ equipmentId }: { equipmentId: string }) {
  const { canReadCosts } = useEquipmentPermissions();
  const history = useEquipmentHistory(equipmentId);
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-small font-semibold">Geçmiş</h3>
      {history.isPending ? (
        <Skeleton className="h-32" />
      ) : history.isError ? (
        <Alert tone="danger">{errorMessage(history.error)}</Alert>
      ) : (
        <>
          <p className="text-small text-muted">
            {history.data.counts.tickets} arıza ({history.data.counts.openTickets} açık) · {history.data.counts.maintenance} bakım görevi ({history.data.counts.maintenanceDone} tamamlandı)
            {history.data.templates.length ? ` · şablon: ${history.data.templates.map((t) => t.name).join(', ')}` : ''}
          </p>
          {canReadCosts && history.data.costs && <CostTable costs={history.data.costs} />}
          {history.data.items.length === 0 ? (
            <p className="text-small text-muted">Bu ekipmana bağlı arıza veya bakım kaydı yok. Arıza talebinde veya bakım şablonunda ekipmanı seçerek bağlayabilirsiniz.</p>
          ) : (
            <ol className="flex flex-col gap-2" aria-label="Ekipman geçmişi">
              {history.data.items.map((i) => (
                <li key={`${i.kind}-${i.id}`}>
                  <Link
                    to={i.kind === 'ticket' ? `/admin/tickets?tab=list&ticket=${encodeURIComponent(i.id)}` : `/admin/tickets?tab=calendar&task=${encodeURIComponent(i.id)}`}
                    className="flex flex-col gap-1 rounded-lg border border-border bg-surface/40 px-3 py-2 text-small hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{i.kind === 'ticket' ? `${i.number ?? ''} ${i.title}`.trim() : i.title}</span>
                      {i.kind === 'ticket' ? <TicketStatusBadge status={i.status as TicketStatus} /> : <TaskStatusBadge status={i.status as TaskStatus} overdue={i.overdue} />}
                      {i.cost !== undefined && i.cost > 0 && <span className="ml-auto text-xs tabular-nums">{formatTRY(i.cost)}</span>}
                    </span>
                    <span className="text-xs text-muted">
                      {i.kind === 'ticket' ? 'Arıza' : i.upcoming ? 'Planlı bakım' : 'Bakım'} · {formatDate(i.date)}
                      {i.estimate !== undefined ? ` · görevli tahmini ${formatTRY(i.estimate)}` : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function CostTable({ costs }: { costs: NonNullable<EquipmentHistory['costs']> }) {
  if (!costs.byYear.length) return <p className="text-small text-muted">Bağlı masraf yok.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-small">
        <caption className="sr-only">Yıllara göre masraflar</caption>
        <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Yıl</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Arıza</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Bakım</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Toplam</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {costs.byYear.map((y) => (
            <tr key={y.year}>
              <th scope="row" className="px-3 py-2 font-medium">{y.year}</th>
              <td className="px-3 py-2 text-right tabular-nums">{formatTRY(y.ticket)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatTRY(y.maintenance)}</td>
              <td className="px-3 py-2 text-right font-medium tabular-nums">{formatTRY(y.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-border">
          <tr>
            <th scope="row" className="px-3 py-2 font-semibold">Toplam</th>
            <td className="px-3 py-2 text-right tabular-nums">{formatTRY(costs.ticket)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatTRY(costs.maintenance)}</td>
            <td className="px-3 py-2 text-right font-semibold tabular-nums">{formatTRY(costs.total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
