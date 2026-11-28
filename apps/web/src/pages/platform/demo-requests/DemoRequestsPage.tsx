import { DEMO_ERASE_REASON_MIN, DEMO_UNIT_RANGE_LABELS, type DemoEraseStatus, type DemoRequest } from '@bm/shared/api/demoRequests';
import { Inbox, Mail, Phone, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, FormField, Select, Skeleton, Textarea } from '@/components/ui';
import { useDemoRequests, useEraseDemoRequest } from '@/hooks/usePlatform';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';

const ERASE_OPTIONS: readonly { value: DemoEraseStatus; label: string }[] = [
  { value: 'deleted', label: 'KVKK silme talebi' },
  { value: 'spam', label: 'Spam / istenmeyen kayıt' },
];

/**
 * Satir ici kaldirma formu (FeatureRequestsCard'daki ret formu gibi): tur + gerekce. Kisisel alanlar
 * sunucuda kaldirilir, kayit listeden duser; islem platform denetim zincirine yazilir.
 */
function EraseForm({ request, onDone }: { request: DemoRequest; onDone: () => void }) {
  const erase = useEraseDemoRequest();
  const [status, setStatus] = useState<DemoEraseStatus>('deleted');
  const [reason, setReason] = useState('');
  const valid = reason.trim().length >= DEMO_ERASE_REASON_MIN;

  return (
    <form
      className="flex flex-col gap-3 border-t border-border pt-3"
      aria-label={`${request.organization} talebini kaldır`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        erase.mutate({ requestId: request.requestId, status, reason: reason.trim() }, { onSuccess: onDone });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Tür">
          <Select value={status} onChange={(e) => setStatus(e.target.value as DemoEraseStatus)}>
            {ERASE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Gerekçe" hint={`En az ${DEMO_ERASE_REASON_MIN} karakter; denetim günlüğüne yazılır, kişisel veri yazmayın.`}>
            <Textarea rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        </div>
      </div>
      <p className="text-small text-muted">Ad, e-posta, telefon, site adı, mesaj ve IP kalıcı olarak silinir; bu işlem geri alınamaz.</p>
      {erase.isError && <Alert tone="danger">{errorMessage(erase.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" variant="danger" disabled={!valid} loading={erase.isPending}>
          Kişisel verileri sil
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Vazgeç
        </Button>
      </div>
    </form>
  );
}

/**
 * Platform: tanitim sayfasindaki formdan gelen demo talepleri (en yeni once, 25'er). Kayitlar 2 yil
 * sonra otomatik silinir; KVKK silme talebi veya spam icin satirdan hemen kaldirilir. Talep sahibine
 * e-posta henuz otomatik gitmez; donus buradaki bilgilerle elle yapilir.
 */
export function DemoRequestsPage() {
  const list = useDemoRequests();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const [erasing, setErasing] = useState<string>();

  let body;
  if (list.isPending) {
    body = (
      <div role="status" aria-label="Demo talepleri yükleniyor" className="flex flex-col gap-2">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    );
  } else if (list.isError) {
    body = (
      <Card className="flex flex-col items-start gap-3">
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
        <Button variant="secondary" onClick={() => void list.refetch()}>
          Tekrar dene
        </Button>
      </Card>
    );
  } else if (items.length === 0) {
    body = (
      <Card className="flex flex-col items-center gap-2 py-12 text-center">
        <Inbox className="size-8 text-muted" aria-hidden="true" />
        <p className="font-medium">Henüz demo talebi yok</p>
        <p className="max-w-content text-small text-muted">Tanıtım sayfasındaki formdan gelen talepler burada listelenir.</p>
      </Card>
    );
  } else {
    body = (
      <ul className="flex flex-col gap-2" aria-label="Demo talepleri">
        {items.map((r) => (
          <li key={r.requestId} className="flex flex-col gap-3 rounded-xl border border-border bg-surface/60 p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{r.organization}</p>
                  <Badge>{DEMO_UNIT_RANGE_LABELS[r.unitRange]}</Badge>
                  {r.suspect && (
                    <Badge tone="warning" title="Günlük olağan talep hacmi aşıldığında geldi; bot olabilir.">
                      Şüpheli
                    </Badge>
                  )}
                </div>
                <p className="text-small text-muted">
                  {r.fullName} · {formatDateTime(r.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 text-small">
                <a href={`mailto:${r.email}`} className="inline-flex items-center gap-1.5 text-accent underline-offset-4 hover:underline">
                  <Mail className="size-4" aria-hidden="true" />
                  {r.email}
                </a>
                {r.phone && (
                  <a href={`tel:${r.phone.replace(/[^\d+]/g, '')}`} className="inline-flex items-center gap-1.5 text-accent underline-offset-4 hover:underline">
                    <Phone className="size-4" aria-hidden="true" />
                    {r.phone}
                  </a>
                )}
                {erasing !== r.requestId && (
                  <Button size="sm" variant="subtle" onClick={() => setErasing(r.requestId)}>
                    <Trash2 className="size-4" aria-hidden="true" />
                    Kaldır
                  </Button>
                )}
              </div>
            </div>
            {r.message && <p className="text-small whitespace-pre-line text-text-secondary">{r.message}</p>}
            <p className="text-small text-muted">
              KVKK onayı: aydınlatma metni {r.kvkkVersion}
              {r.ipMasked ? ` · IP ${r.ipMasked}` : ''}
            </p>
            {erasing === r.requestId && <EraseForm request={r} onDone={() => setErasing(undefined)} />}
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <Inbox className="size-5" aria-hidden="true" />
          Demo talepleri
        </h1>
        <p className="text-small text-muted">
          Tanıtım sayfasındaki formdan gelen talepler, en yeni önce. Talep sahibine otomatik e-posta gitmez; dönüşü buradaki bilgilerle yapın.
          Kayıtlar 2 yıl sonra kendiliğinden silinir; KVKK silme talebinde veya spamde “Kaldır” ile hemen silin.
        </p>
      </div>
      {body}
      {list.hasNextPage && (
        <Button variant="secondary" className="self-center" onClick={() => void list.fetchNextPage()} loading={list.isFetchingNextPage}>
          Daha fazla yükle
        </Button>
      )}
    </div>
  );
}
