import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FormField, Input, Textarea } from '@/components/ui';
import { useFinalizeAssembly, useSaveMinutes } from '@/hooks/useAssemblies';
import type { Assembly } from '@/lib/api/assemblies';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { minutesInput, namesText } from './schemas';

type Props = { assembly: Assembly; editable: boolean };

/**
 * Toplanti tutanagi: divan (toplanti baskani, yazman, oy toplayici; adlar yonetici tarafindan girilir)
 * ve gundem maddesi basina gorusme notlari; kesinlestirme. Kesinlesen tutanak degismez, sakin
 * portalinda kararlarla birlikte gorunur.
 */
export function MinutesCard({ assembly: a, editable }: Props) {
  const save = useSaveMinutes(a.assemblyId);
  const finalize = useFinalizeAssembly(a.assemblyId);
  const m = a.minutes;
  const [chair, setChair] = useState(m?.chair ?? '');
  const [clerks, setClerks] = useState(namesText(m?.clerks));
  const [counters, setCounters] = useState(namesText(m?.voteCounters));
  const [notes, setNotes] = useState<Record<string, string>>(m?.notes ?? {});
  const [general, setGeneral] = useState(m?.generalNotes ?? '');
  const [confirming, setConfirming] = useState(false);
  const held = a.status === 'held';

  if (!editable) {
    return (
      <Card className="flex flex-col gap-3">
        <CardTitle>Tutanak</CardTitle>
        {held && a.heldAt && <Alert tone="success">Tutanak {formatDateTime(a.heldAt)} tarihinde kesinleşti; kararlar sakin portalında kat maliklerine gösteriliyor.</Alert>}
        <dl className="grid gap-2 text-small sm:grid-cols-3">
          <div>
            <dt className="text-xs text-muted">Toplantı başkanı</dt>
            <dd>{m?.chair ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Yazman</dt>
            <dd>{m?.clerks.length ? m.clerks.join(', ') : '—'}</dd>
          </div>
          <div>
            <dt className="text-xs text-muted">Oy toplayıcı</dt>
            <dd>{m?.voteCounters.length ? m.voteCounters.join(', ') : '—'}</dd>
          </div>
        </dl>
        {m?.generalNotes && <p className="text-small whitespace-pre-line break-words text-text-secondary">{m.generalNotes}</p>}
      </Card>
    );
  }

  const input = minutesInput({ version: a.version, chair, clerks, counters, notes, general });
  return (
    <>
      <Card className="flex flex-col gap-3">
        <CardTitle>Tutanak</CardTitle>
        <p className="text-small text-muted">
          Divan adları ve görüşme notları tutanak PDF&apos;ine yazılır; denetim günlüğüne yalnızca girildiği bilgisi geçer. Kararlar ayrıca noterce onaylı karar defterine yazılır ve toplantıda
          bulunanlarca imzalanır (KMK m.32).
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Toplantı başkanı">
            <Input autoComplete="off" maxLength={150} value={chair} onChange={(e) => setChair(e.target.value)} />
          </FormField>
          <FormField label="Yazman" hint="Birden fazlaysa virgülle ayırın (en fazla 3).">
            <Input autoComplete="off" maxLength={460} value={clerks} onChange={(e) => setClerks(e.target.value)} />
          </FormField>
          <FormField label="Oy toplayıcı (isteğe bağlı)" hint="Virgülle ayırın (en fazla 3).">
            <Input autoComplete="off" maxLength={460} value={counters} onChange={(e) => setCounters(e.target.value)} />
          </FormField>
        </div>
        {a.agenda.map((item, i) => (
          <FormField key={item.itemId} label={`${i + 1}. ${item.title} - görüşme notu`}>
            <Textarea maxLength={4000} value={notes[item.itemId] ?? ''} onChange={(e) => setNotes({ ...notes, [item.itemId]: e.target.value })} />
          </FormField>
        ))}
        <FormField label="Diğer görüşmeler ve notlar">
          <Textarea maxLength={4000} value={general} onChange={(e) => setGeneral(e.target.value)} />
        </FormField>
        {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
        {save.isSuccess && !save.isPending && <Alert tone="success">Tutanak kaydedildi.</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" loading={save.isPending} disabled={!input} onClick={() => input && save.mutate(input)}>
            Tutanağı kaydet
          </Button>
          {!confirming && (
            <Button size="sm" onClick={() => setConfirming(true)}>
              Tutanağı kesinleştir
            </Button>
          )}
        </div>
        {!input && <p className="text-xs text-danger">Adlar 2-150 karakter olmalı; yazman ve oy toplayıcı en fazla 3 kişi.</p>}
      </Card>
      {confirming && (
        <Card className="flex flex-col gap-3">
          <p className="text-small">
            Kesinleştirdikten sonra katılım, yeter sayı, tutanak ve yeni karar girilemez; kayıtlı kararlar yalnızca gerekçeli düzeltmeyle değişir. Kararlar ve tutanak kat maliklerine sakin
            portalında gösterilir. Kaydedilmemiş değişiklikleri önce kaydedin.
          </p>
          {finalize.isError && <Alert tone="danger">{errorMessage(finalize.error)}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" disabled={finalize.isPending} onClick={() => setConfirming(false)}>
              Vazgeç
            </Button>
            <Button loading={finalize.isPending} onClick={() => finalize.mutate(a.version, { onSuccess: () => setConfirming(false) })}>
              Kesinleştir
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}
