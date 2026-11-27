import { CalendarClock, ChevronRight, FileText, Landmark, ListOrdered, Mail, MapPin, Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Skeleton } from '@/components/ui';
import { useAssemblies, useAssemblyPermissions } from '@/hooks/useAssemblies';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { type Assembly, KIND_LABELS, STATUS_LABELS, STATUS_TONES, assembliesApi } from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { AssemblyDetailDialog } from './AssemblyDetailDialog';
import { AssemblyDialog } from './AssemblyDialog';

type Editor = { item?: Assembly } | null;

/** Y1-3 Genel Kurul: kat malikleri kurulu toplantilari, cagri, hazirun cetveli, katilim, kararlar, tutanak ve karar defteri. */
export function AssembliesPage() {
  const { canRead, canWrite } = useAssemblyPermissions();
  const list = useAssemblies();
  const doc = useOpenDocument();
  const [editor, setEditor] = useState<Editor>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const items = list.data ?? [];

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Genel Kurul</h1>
        <Alert>Bu rol genel kurul kayıtlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Genel Kurul</h1>
          <p className="text-small text-muted">Kat malikleri kurulu toplantısını yönetin: çağrı, hazirun cetveli, katılım, yeter sayı, kararlar ve tutanak.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" loading={doc.pendingId === 'decision-book'} onClick={() => void doc.open('decision-book', () => assembliesApi.decisionBook())}>
            <FileText className="size-4" aria-hidden="true" />
            Karar defteri (PDF)
          </Button>
          {canWrite && (
            <Button onClick={() => setEditor({})}>
              <Plus className="size-4" aria-hidden="true" />
              Yeni toplantı
            </Button>
          )}
        </div>
      </div>
      {doc.error && <Alert tone="danger">{doc.error}</Alert>}

      {list.isPending ? (
        <div role="status" aria-label="Toplantılar yükleniyor" className="flex flex-col gap-3">
          {[0, 1].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
            </Card>
          ))}
        </div>
      ) : list.isError ? (
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(list.error)}</Alert>
          <Button variant="secondary" onClick={() => void list.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      ) : items.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Landmark className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Henüz genel kurul kaydı yok</p>
          {canWrite && (
            <Button variant="secondary" onClick={() => setEditor({})}>
              İlk toplantıyı oluşturun
            </Button>
          )}
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {items.map((a) => {
            const tallied = a.agenda.filter((i) => i.tally).length;
            return (
              <li key={a.assemblyId}>
                <Card interactive className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <h2 className="text-base font-semibold text-text md:text-lg">
                      {KIND_LABELS[a.kind]}
                      {a.secondMeeting ? ' (ikinci toplantı)' : ''}
                    </h2>
                    <Badge tone={STATUS_TONES[a.status]}>{STATUS_LABELS[a.status]}</Badge>
                  </div>
                  <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="size-3.5" aria-hidden="true" />
                      {formatDateTime(a.scheduledAt)}
                    </span>
                    <span className="inline-flex min-w-0 items-center gap-1.5 break-all">
                      <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                      {a.location ?? 'Çevrim içi'}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <ListOrdered className="size-3.5" aria-hidden="true" />
                      {a.agenda.length} gündem maddesi{tallied ? ` · ${tallied} karar` : ''}
                    </span>
                    {a.calls?.length ? (
                      <span className="inline-flex items-center gap-1.5">
                        <Mail className="size-3.5" aria-hidden="true" />
                        Çağrı {formatDateTime(a.calls[0]?.calledAt ?? '')}
                      </span>
                    ) : null}
                  </p>
                  <div className="-mx-2.5 -mb-1.5 flex justify-end">
                    <Button size="xs" variant="subtle" onClick={() => setOpenId(a.assemblyId)}>
                      Aç
                      <ChevronRight className="size-3.5" aria-hidden="true" />
                    </Button>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}

      <AssemblyDetailDialog
        assemblyId={openId}
        canWrite={canWrite}
        onClose={() => setOpenId(null)}
        onEdit={(a) => {
          setOpenId(null);
          setEditor({ item: a });
        }}
      />
      {canWrite && <AssemblyDialog open={editor !== null} onClose={() => setEditor(null)} assembly={editor?.item} />}
    </div>
  );
}
