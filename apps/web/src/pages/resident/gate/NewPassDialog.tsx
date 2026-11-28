import { useState } from 'react';
import { Alert, Button, Dialog, FormField, Input, Select, Textarea } from '@/components/ui';
import { useMyGateActions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import type { MyPass } from '@/lib/api/gate';
import { errorMessage } from '@/lib/api/errors';
import { istanbulToday } from '@/lib/maintenance/schedule';
import { normalizePlate } from '@/lib/gate/plate';
import { passFormError } from '@/lib/gate/pass';

type Unit = { unitId: string; label: string };

/** Sakin: misafir gecisi (ad, tarih / tarih araligi, tek veya coklu giris, istege bagli plaka). */
export function NewPassDialog({ open, onClose, units, limits, onCreated }: { open: boolean; onClose: () => void; units: Unit[]; limits: { maxPassDays: number; maxPassLeadDays: number }; onCreated: (p: MyPass) => void }) {
  const today = istanbulToday();
  const actions = useMyGateActions();
  const [key, renew] = useIdempotencyKey();
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const [guestName, setGuestName] = useState('');
  const [validFrom, setValidFrom] = useState(today);
  const [validUntil, setValidUntil] = useState('');
  const [entryMode, setEntryMode] = useState<'single' | 'multi'>('single');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const formError = passFormError({ guestName, validFrom, validUntil, today, ...limits });

  const reset = () => {
    setGuestName('');
    setValidFrom(today);
    setValidUntil('');
    setEntryMode('single');
    setPlate('');
    setNote('');
    setError(null);
  };
  // Kapatilip yeniden acilan form yeni bir istektir: anahtar yenilenir (ayni acilistaki tekrar ayni anahtar).
  const close = () => {
    renew();
    reset();
    onClose();
  };
  const submit = () => {
    setError(null);
    const p = normalizePlate(plate);
    actions.createPass.mutate(
      {
        idempotencyKey: key,
        unitId: unitId || units[0]?.unitId || '',
        guestName: guestName.trim(),
        validFrom,
        ...(validUntil ? { validUntil } : {}),
        entryMode,
        ...(p ? { plate: p } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      },
      {
        onSuccess: (r) => {
          renew();
          reset();
          onClose();
          onCreated(r.pass);
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog open={open} onClose={close} title="Misafir geçişi oluştur">
      <div className="flex flex-col gap-4">
        {units.length > 1 && (
          <FormField label="Daire">
            <Select value={unitId} onChange={(e) => setUnitId(e.target.value)} className="h-12 text-body">
              {units.map((u) => (
                <option key={u.unitId} value={u.unitId}>
                  {u.label}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Misafirin adı" hint="Güvenlik görevlisi girişte bu adı görür">
          <Input value={guestName} onChange={(e) => setGuestName(e.target.value)} maxLength={80} autoComplete="off" className="h-12 text-body" />
        </FormField>
        <div className="grid grid-cols-2 gap-3">
          <FormField label="Geliş tarihi">
            <Input type="date" value={validFrom} min={today} onChange={(e) => e.target.value && setValidFrom(e.target.value)} className="h-12 text-body" />
          </FormField>
          <FormField label="Son gün (isteğe bağlı)">
            <Input type="date" value={validUntil} min={validFrom} onChange={(e) => setValidUntil(e.target.value)} className="h-12 text-body" />
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-small font-medium">Giriş hakkı</legend>
          <label className="flex min-h-12 items-center gap-3 rounded-lg border border-border-strong px-3">
            <input type="radio" name="entry-mode" checked={entryMode === 'single'} onChange={() => setEntryMode('single')} className="size-4 accent-accent" />
            <span>
              <span className="font-medium">Tek giriş</span>
              <span className="block text-small text-muted">Bir kez girişte kullanılır, sonra geçersiz olur.</span>
            </span>
          </label>
          <label className="flex min-h-12 items-center gap-3 rounded-lg border border-border-strong px-3">
            <input type="radio" name="entry-mode" checked={entryMode === 'multi'} onChange={() => setEntryMode('multi')} className="size-4 accent-accent" />
            <span>
              <span className="font-medium">Çoklu giriş</span>
              <span className="block text-small text-muted">Seçilen günler boyunca girip çıkabilir.</span>
            </span>
          </label>
        </fieldset>
        <FormField label="Araç plakası (isteğe bağlı)">
          <Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={14} autoCapitalize="characters" className="h-12 font-mono text-body" />
        </FormField>
        <FormField label="Güvenliğe not (isteğe bağlı)" hint="Görevli görür; telefon numarası yazmayın">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </FormField>
        {formError && guestName.trim().length > 0 && <p className="text-small text-danger">{formError}</p>}
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Vazgeç
          </Button>
          <Button className="h-12 text-body" disabled={!!formError} loading={actions.createPass.isPending} onClick={submit}>
            Geçiş oluştur
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
