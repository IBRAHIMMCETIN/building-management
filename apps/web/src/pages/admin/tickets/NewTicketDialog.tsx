import { useState } from 'react';
import { PhotoPicker, uploadPhotos } from '@/components/tickets/PhotoPicker';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreateTicket, useTicketPermissions } from '@/hooks/useTickets';
import { useBlocks } from '@/hooks/useUnits';
import { errorMessage } from '@/lib/api/errors';
import { ticketsApi } from '@/lib/api/tickets';
import { CATEGORY_LABELS, PRIORITY_LABELS, TICKET_CATEGORIES, TICKET_PRIORITIES, type TicketCategory, type TicketPriority } from '@/lib/tickets/model';
import { useTicketLabels } from './shared';

/** Yonetim / gorevli / guvenlik talep acma: daire ici (yonetim, gorevli) veya ortak alan. */
export function NewTicketDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const p = useTicketPermissions();
  const labels = useTicketLabels();
  const blocks = useBlocks();
  const create = useCreateTicket();
  const [key, renew] = useIdempotencyKey();
  const canUnit = p.canManage || p.isStaff;
  const [kind, setKind] = useState<'unit' | 'common'>('common');
  const [unitId, setUnitId] = useState('');
  const [area, setArea] = useState('');
  const [blockId, setBlockId] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TicketCategory>('other');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTitle('');
    setDescription('');
    setArea('');
    setUnitId('');
    setFiles([]);
    setError(null);
    renew();
  };
  const valid = title.trim().length >= 3 && description.trim().length > 0 && (kind === 'unit' ? !!unitId : area.trim().length >= 2);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const photos = await uploadPhotos(files, (f) => ticketsApi.uploadPhoto(f));
      const r = await create.mutateAsync({
        idempotencyKey: key,
        title: title.trim(),
        description: description.trim(),
        category,
        priority,
        location: kind === 'unit' ? { kind, unitId } : { kind, area: area.trim(), ...(blockId ? { blockId } : {}) },
        ...(photos.length ? { photos } : {}),
      });
      reset();
      onClose();
      onCreated(r.ticket.ticketId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Yeni arıza / talep" variant="wide">
      <div className="grid gap-4 sm:grid-cols-2">
        {canUnit && (
          <fieldset className="flex gap-4 text-small sm:col-span-2">
            <legend className="sr-only">Konum türü</legend>
            <label className="flex items-center gap-2">
              <input type="radio" name="loc-kind" checked={kind === 'common'} onChange={() => setKind('common')} className="accent-accent" />
              Ortak alan
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="loc-kind" checked={kind === 'unit'} onChange={() => setKind('unit')} className="accent-accent" />
              Daire içi
            </label>
          </fieldset>
        )}
        {kind === 'unit' ? (
          <div className="sm:col-span-2">
            <FormField label="Daire">
              <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                <option value="">Seçin</option>
                {labels.units.map((u) => (
                  <option key={u.unitId} value={u.unitId}>
                    Daire {u.number}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>
        ) : (
          <>
            <FormField label="Alan" hint="Örn. Lobi, otopark girişi, çatı">
              <Input value={area} onChange={(e) => setArea(e.target.value)} maxLength={80} />
            </FormField>
            <FormField label="Blok (isteğe bağlı)">
              <Select value={blockId} onChange={(e) => setBlockId(e.target.value)}>
                <option value="">—</option>
                {(blocks.data ?? []).map((b) => (
                  <option key={b.blockId} value={b.blockId}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}
        <FormField label="Kategori">
          <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
            {TICKET_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Öncelik">
          <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
            {TICKET_PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {PRIORITY_LABELS[x]}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Başlık">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          <FormField label="Açıklama">
            <Textarea rows={4} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={4000} />
          </FormField>
        </div>
        <div className="sm:col-span-2">
          <PhotoPicker files={files} onChange={setFiles} disabled={busy} />
        </div>
      </div>
      {error && (
        <div className="mt-4">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Vazgeç
        </Button>
        <Button loading={busy} disabled={!valid} onClick={() => void submit()}>
          Talebi oluştur
        </Button>
      </div>
    </Dialog>
  );
}
