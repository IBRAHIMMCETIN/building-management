import { Archive, Megaphone, Pencil, Plus, Send } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FilterChips, Skeleton } from '@/components/ui';
import { useAnnouncementPermissions, useAnnouncements, useApproveAnnouncement, useArchiveAnnouncement } from '@/hooks/useAnnouncements';
import { useBlocks } from '@/hooks/useUnits';
import {
  type Announcement,
  type AnnouncementDisplayStatus,
  DISPLAY_STATUS_LABELS,
  displayStatus,
} from '@/lib/api/announcements';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { AnnouncementDialog } from './AnnouncementDialog';

type Filter = 'all' | 'draft' | 'live' | 'archived';
const FILTERS: readonly { value: Filter; label: string }[] = [
  { value: 'all', label: 'Tümü' },
  { value: 'draft', label: 'Taslak' },
  { value: 'live', label: 'Yayında / planlı' },
  { value: 'archived', label: 'Arşiv' },
];

const matches = (f: Filter, a: Announcement) =>
  f === 'all' || (f === 'live' ? a.status === 'published' : a.status === f);

const TONES: Record<AnnouncementDisplayStatus, 'neutral' | 'success' | 'accent' | 'warning'> = {
  draft: 'warning',
  scheduled: 'accent',
  published: 'success',
  expired: 'neutral',
  archived: 'neutral',
};

type Confirm = { kind: 'approve' | 'archive'; item: Announcement } | null;
type Editor = { item?: Announcement } | null;

export function AnnouncementsPage() {
  const { canRead, canWrite } = useAnnouncementPermissions();
  const list = useAnnouncements('all');
  const blocks = useBlocks();
  const [filter, setFilter] = useState<Filter>('all');
  const [editor, setEditor] = useState<Editor>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);

  const blockNames = useMemo(() => new Map((blocks.data ?? []).map((b) => [b.blockId, b.name])), [blocks.data]);
  const activeBlocks = useMemo(() => (blocks.data ?? []).filter((b) => b.status === 'active'), [blocks.data]);
  const items = list.data ?? [];
  const visible = items.filter((a) => matches(filter, a));

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Duyurular</h1>
        <Alert>Bu rol duyuruları görüntüleyemez.</Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Duyurular</h1>
          <p className="text-small text-muted">Taslak hazırlayın, yayınlayın veya ileri tarihe planlayın.</p>
        </div>
        {canWrite && (
          <Button onClick={() => setEditor({})}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni duyuru
          </Button>
        )}
      </div>

      <FilterChips<Filter>
        label="Duruma göre filtrele"
        value={filter}
        onChange={setFilter}
        options={FILTERS.map((f) => ({ ...f, count: list.data ? items.filter((a) => matches(f.value, a)).length : undefined }))}
      />

      {list.isPending ? (
        <div role="status" aria-label="Duyurular yükleniyor" className="flex flex-col gap-3">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-col gap-3">
              <Skeleton className="h-5 w-1/2" />
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-12" />
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
      ) : visible.length === 0 ? (
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Megaphone className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">{items.length === 0 ? 'Henüz duyuru yok' : 'Bu filtrede duyuru yok'}</p>
          {items.length === 0 && canWrite && (
            <Button variant="secondary" onClick={() => setEditor({})}>
              İlk duyuruyu oluşturun
            </Button>
          )}
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((a) => (
            <li key={a.announcementId}>
              <AnnouncementCard
                item={a}
                target={a.blockIds?.length ? a.blockIds.map((id) => blockNames.get(id) ?? 'Bilinmeyen blok').join(', ') : 'Tüm apartman'}
                canWrite={canWrite}
                onEdit={() => setEditor({ item: a })}
                onApprove={() => setConfirm({ kind: 'approve', item: a })}
                onArchive={() => setConfirm({ kind: 'archive', item: a })}
              />
            </li>
          ))}
        </ul>
      )}

      {canWrite && (
        <>
          <AnnouncementDialog open={editor !== null} onClose={() => setEditor(null)} announcement={editor?.item} blocks={activeBlocks} />
          <ConfirmDialog confirm={confirm} onClose={() => setConfirm(null)} />
        </>
      )}
    </div>
  );
}

type CardProps = {
  item: Announcement;
  target: string;
  canWrite: boolean;
  onEdit: () => void;
  onApprove: () => void;
  onArchive: () => void;
};

function AnnouncementCard({ item, target, canWrite, onEdit, onApprove, onArchive }: CardProps) {
  const status = displayStatus(item);
  const future = Date.parse(item.publishAt) > Date.now();
  const when =
    item.status === 'draft'
      ? future
        ? `Planlanan yayın: ${formatDateTime(item.publishAt)}`
        : `Oluşturuldu: ${formatDateTime(item.createdAt)}`
      : item.status === 'archived' && item.archivedAt
        ? `Arşivlendi: ${formatDateTime(item.archivedAt)}`
        : `${future ? 'Yayınlanacak' : 'Yayınlandı'}: ${formatDateTime(item.publishAt)}`;

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h2 className="min-w-0 text-heading font-semibold break-words">{item.title}</h2>
        <Badge tone={TONES[status]}>{DISPLAY_STATUS_LABELS[status]}</Badge>
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-small text-muted">
        <span>{target}</span>
        <span>{when}</span>
        {item.expiresAt && <span>Bitiş: {formatDateTime(item.expiresAt)}</span>}
      </p>
      <p className="line-clamp-4 text-body whitespace-pre-line break-words">{item.body}</p>

      {canWrite && item.status !== 'archived' && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          {item.status === 'draft' && (
            <Button size="sm" variant="ghost" onClick={onEdit}>
              <Pencil className="size-4" aria-hidden="true" />
              Düzenle
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onArchive}>
            <Archive className="size-4" aria-hidden="true" />
            {item.status === 'published' ? 'Yayından kaldır' : 'Arşivle'}
          </Button>
          {item.status === 'draft' && (
            <Button size="sm" onClick={onApprove}>
              <Send className="size-4" aria-hidden="true" />
              {future ? 'Onayla ve planla' : 'Yayınla'}
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

function ConfirmDialog({ confirm, onClose }: { confirm: Confirm; onClose: () => void }) {
  const approve = useApproveAnnouncement();
  const archive = useArchiveAnnouncement();
  const mutation = confirm?.kind === 'approve' ? approve : archive;
  // Kapanirken icerik bos kalmasin diye son secim tutulur.
  const [last, setLast] = useState<NonNullable<Confirm> | null>(null);
  useEffect(() => {
    if (!confirm) return;
    setLast(confirm);
    approve.reset();
    archive.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca yeni secimde
  }, [confirm]);
  const current = confirm ?? last;
  if (!current) return null;

  const isApprove = current.kind === 'approve';
  const future = Date.parse(current.item.publishAt) > Date.now();
  const conflict = mutation.error instanceof ApiError && mutation.error.status === 409;

  const run = async () => {
    try {
      await mutation.mutateAsync({ id: current.item.announcementId, version: current.item.version });
      onClose();
    } catch {
      // Hata diyalogda gosterilir; liste onSettled ile yenilenir.
    }
  };

  return (
    <Dialog
      open={confirm !== null}
      onClose={() => !mutation.isPending && onClose()}
      title={isApprove ? (future ? 'Duyuruyu planla' : 'Duyuruyu yayınla') : current.item.status === 'published' ? 'Yayından kaldır' : 'Taslağı arşivle'}
    >
      <div className="flex flex-col gap-4">
        <p className="font-medium break-words">“{current.item.title}”</p>
        <p className="text-small text-muted">
          {isApprove
            ? future
              ? `Duyuru ${formatDateTime(current.item.publishAt)} tarihinde sakinlere görünecek. Onaydan sonra değiştirilemez.`
              : 'Duyuru hemen sakinlere görünecek. Yayınlandıktan sonra değiştirilemez.'
            : current.item.status === 'published'
              ? 'Sakinler bu duyuruyu artık görmeyecek. Kayıt arşivde kalır, silinmez.'
              : 'Taslak arşive taşınır ve artık düzenlenemez.'}
        </p>
        {mutation.isError && (
          <Alert tone="danger">
            {conflict ? 'Duyuru bu arada başka biri tarafından değiştirildi. Liste yenilendi; kontrol edip tekrar deneyin.' : errorMessage(mutation.error)}
          </Alert>
        )}
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose} disabled={mutation.isPending}>
            Vazgeç
          </Button>
          {!conflict && (
            <Button variant={isApprove ? 'primary' : 'danger'} loading={mutation.isPending} onClick={() => void run()}>
              {isApprove ? (future ? 'Onayla ve planla' : 'Yayınla') : current.item.status === 'published' ? 'Yayından kaldır' : 'Arşivle'}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}
