import { MailX, Search, ShieldOff } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FilterChips, FormField, Input, Skeleton, Spinner, Textarea } from '@/components/ui';
import { useClearSuppression, useEmailSuppressions, useLookupSuppression } from '@/hooks/useEmailSuppressions';
import { type EmailSuppression, clearReasonError, suppressionReasonText, suppressionTone } from '@/lib/api/emailSuppressions';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';

type StatusFilter = 'active' | 'all';
const STATUS_OPTIONS: { value: StatusFilter; label: string }[] = [
  { value: 'active', label: 'Etkin engeller' },
  { value: 'all', label: 'Tümü (kaldırılanlar dahil)' },
];

function ClearDialog({ target, onClose, onCleared }: { target: EmailSuppression | null; onClose: () => void; onCleared: (s: EmailSuppression) => void }) {
  const clear = useClearSuppression();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setReason('');
    setError(undefined);
    clear.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [target?.emailHash]);

  const submit = async () => {
    if (!target) return;
    const e = clearReasonError(reason);
    if (e) {
      setError(e);
      return;
    }
    try {
      onCleared(await clear.mutateAsync({ emailHash: target.emailHash, reason: reason.trim() }));
      onClose();
    } catch {
      // hata asagida
    }
  };

  return (
    <Dialog open={target !== null} onClose={onClose} title="E-posta engelini kaldır">
      {target && (
        <div className="flex flex-col gap-4">
          <p className="text-small text-muted">
            <strong className="text-text">{target.emailMasked}</strong> · {suppressionReasonText(target)} · {formatDateTime(target.at)}. Engel kaldırılınca bu adrese
            bildirim e-postaları yeniden gönderilir; adres yeniden geri dönerse engel kendiliğinden geri gelir.
          </p>
          <FormField label="Gerekçe" error={error} hint="Denetim kaydına yazılır (5-300 karakter).">
            <Textarea
              rows={3}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(undefined);
              }}
            />
          </FormField>
          {clear.isError && <Alert tone="danger">{errorMessage(clear.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Vazgeç
            </Button>
            <Button loading={clear.isPending} onClick={() => void submit()}>
              <ShieldOff className="size-4" aria-hidden="true" />
              Engeli kaldır
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function SuppressionRow({ s, onClear }: { s: EmailSuppression; onClear: () => void }) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono font-medium">{s.emailMasked}</p>
          <Badge tone={suppressionTone(s)}>{s.active ? suppressionReasonText(s) : 'Kaldırıldı'}</Badge>
        </div>
        <p className="text-small text-muted">
          SES olayı {formatDateTime(s.at)}
          {s.bounceSubType && ` · ${s.bounceSubType}`}
          {s.expiresAt && ` · ${formatDateTime(s.expiresAt)} tarihinde kendiliğinden kalkar`}
        </p>
        {s.status === 'cleared' && s.clearedAt && (
          <p className="text-small text-muted">
            Kaldırıldı {formatDateTime(s.clearedAt)}
            {s.clearReason && ` · “${s.clearReason}”`}
          </p>
        )}
      </div>
      {s.active && (
        <Button size="sm" variant="secondary" onClick={onClear}>
          Engeli kaldır
        </Button>
      )}
    </li>
  );
}

function LookupCard({ onClear, cleared }: { onClear: (s: EmailSuppression) => void; cleared?: EmailSuppression }) {
  const [email, setEmail] = useState('');
  const lookup = useLookupSuppression();
  // Bu ekranda kaldirilan kayit arama sonucunda da guncel gorunur.
  const found = lookup.data?.suppression && cleared?.emailHash === lookup.data.suppression.emailHash ? cleared : lookup.data?.suppression;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (value) lookup.mutate(value);
  };

  return (
    <>
      <Card>
        <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={submit} aria-label="E-posta engeli ara">
          <div className="flex-1">
            <FormField label="E-posta">
              <Input type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ornek@site.com" />
            </FormField>
          </div>
          <Button type="submit" loading={lookup.isPending}>
            <Search className="size-4" aria-hidden="true" />
            Ara
          </Button>
        </form>
      </Card>
      {lookup.isPending && <Spinner label="Aranıyor…" />}
      {lookup.isError && <Alert tone="danger">{errorMessage(lookup.error)}</Alert>}
      {lookup.data && !lookup.data.suppression && <Alert tone="info">Bu adres için e-posta engeli yok.</Alert>}
      {found && (
        <ul className="flex flex-col gap-2" aria-label="Arama sonucu">
          <SuppressionRow s={found} onClear={() => onClear(found)} />
        </ul>
      )}
    </>
  );
}

function ListCard({ onClear }: { onClear: (s: EmailSuppression) => void }) {
  const [status, setStatus] = useState<StatusFilter>('active');
  const list = useEmailSuppressions(status);
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Engellenen adresler</CardTitle>
      <FilterChips<StatusFilter> label="Engel durumu" value={status} onChange={setStatus} options={STATUS_OPTIONS} />
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
        <p className="py-4 text-center text-small text-muted">Engellenen e-posta adresi yok.</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-label="E-posta engelleri">
          {items.map((s) => (
            <SuppressionRow key={s.emailHash} s={s} onClear={() => onClear(s)} />
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <Button variant="secondary" className="self-center" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          Daha fazla yükle
        </Button>
      )}
    </Card>
  );
}

/**
 * Platform: SES geri donus / sikayet nedeniyle e-posta gonderilmeyen adresler. Adresler maskeli
 * gosterilir (tamami saklanmaz); e-postayla arama istek govdesindedir. Kaldirma gerekceli ve
 * platform denetim zincirine yazilir.
 */
export function PlatformEmailSuppressionsPage() {
  const [target, setTarget] = useState<EmailSuppression | null>(null);
  const [cleared, setCleared] = useState<EmailSuppression | undefined>();
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="inline-flex items-center gap-2 text-title font-bold">
          <MailX className="size-5" aria-hidden="true" />
          E-posta Engelleri
        </h1>
        <p className="text-small text-muted">
          Kalıcı geri dönen veya şikâyet edilen adreslere bildirim e-postası gönderilmez; geçici geri dönüşler 7 gün sonra kendiliğinden kalkar. Adresler
          maskeli gösterilir; tam adresle aramak için e-postayı girin.
        </p>
      </div>
      <LookupCard onClear={setTarget} {...(cleared ? { cleared } : {})} />
      <ListCard onClear={setTarget} />
      <ClearDialog target={target} onClose={() => setTarget(null)} onCleared={setCleared} />
    </div>
  );
}
