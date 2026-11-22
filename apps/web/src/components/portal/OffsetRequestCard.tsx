import { ArrowLeftRight } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, FormField, Input, Select } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreateOffsetRequest, useMyOffsetRequests, useOffsetOptions } from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { OFFSET_REQUEST_STATUS_LABELS, OFFSET_REQUEST_STATUS_TONES } from '@/lib/restructure/model';

/**
 * Finans 2.2 - sakin avans mahsubu talebi: avansi olan kendi carisinden, bu dairedeki borclu
 * carisine mahsup ister; yonetim onaylar veya reddeder. Avans ve borc yoksa ve talep yoksa
 * kart gosterilmez.
 */
export function OffsetRequestCard() {
  const options = useOffsetOptions();
  const requests = useMyOffsetRequests();
  const create = useCreateOffsetRequest();
  const [key, renewKey] = useIdempotencyKey();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [amountText, setAmountText] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);

  const o = options.data;
  useEffect(() => {
    if (!o) return;
    setSource((cur) => cur || (o.sources[0]?.accountId ?? ''));
    setTarget((cur) => cur || (o.targets[0]?.accountId ?? ''));
  }, [o]);

  const list = requests.data ?? [];
  const canRequest = !!o && o.sources.length > 0 && o.targets.length > 0;
  if (options.isPending || options.isError || (!canRequest && list.length === 0)) return null;

  const advance = o?.sources.find((s) => s.accountId === source)?.advance ?? 0;
  const debt = o?.targets.find((t) => t.accountId === target)?.openDebt ?? 0;
  const max = Math.min(advance, debt);
  const amount = parseTRYToKurus(amountText);
  const amountError = amountText === '' ? undefined : amount === null ? 'Geçerli bir tutar girin' : amount > max ? `En fazla ${formatTRY(max)}` : undefined;
  const valid = !!source && !!target && source !== target && amount !== null && amount <= max;
  const nameOf = (id: string) => o?.sources.find((s) => s.accountId === id)?.name ?? o?.targets.find((t) => t.accountId === id)?.name ?? 'Cari';

  return (
    <Card className="flex flex-col gap-3">
      <CardTitle className="flex items-center gap-2">
        <ArrowLeftRight className="size-5 text-muted" aria-hidden="true" />
        Avans mahsubu talebi
      </CardTitle>
      {canRequest && (
        <>
          <p className="text-small text-muted">
            Fazla ödemeniz (avansınız) borcunuza sayılsın istiyorsanız talep oluşturun; yönetim onayladığında mahsup yapılır.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Avansın bulunduğu cari">
              <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Avansın bulunduğu cari">
                {o.sources.map((s) => (
                  <option key={s.accountId} value={s.accountId}>
                    {s.name} · avans {formatTRY(s.advance)}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Borcun bulunduğu cari">
              <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Borcun bulunduğu cari">
                {o.targets.map((t) => (
                  <option key={t.accountId} value={t.accountId}>
                    {t.name} · borç {formatTRY(t.openDebt)}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
          <FormField label="Tutar (TL)" error={amountError} hint={max > 0 ? `En fazla ${formatTRY(max)}` : undefined}>
            <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder={max > 0 ? kurusToInput(max) : '0,00'} aria-label="Tutar" />
          </FormField>
          <FormField label="Not (isteğe bağlı)">
            <Input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} aria-label="Not" />
          </FormField>
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          {sent && !create.isError && <Alert tone="success">Talebiniz yönetime iletildi.</Alert>}
          <div className="flex justify-end">
            <Button
              loading={create.isPending}
              disabled={!valid}
              onClick={async () => {
                if (!valid || amount === null) return;
                try {
                  await create.mutateAsync({
                    idempotencyKey: key,
                    sourceAccountId: source,
                    targetAccountId: target,
                    amount,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  });
                  setSent(true);
                  setAmountText('');
                  setNote('');
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
      {list.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border text-small" aria-label="Mahsup taleplerim">
          {list.map((r) => (
            <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {formatTRY(r.decision?.amount ?? r.amount)} · {nameOf(r.sourceAccountId)} → {nameOf(r.targetAccountId)}
                <span className="block text-xs text-muted">
                  {formatDateTime(r.createdAt)}
                  {r.status === 'rejected' && r.decision ? ` · ${r.decision.reason}` : ''}
                </span>
              </span>
              <Badge tone={OFFSET_REQUEST_STATUS_TONES[r.status]}>{OFFSET_REQUEST_STATUS_LABELS[r.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
