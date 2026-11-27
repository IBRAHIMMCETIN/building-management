import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Dialog, FilterChips, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import { useDeskActions, useGateLog, useGatePermissions } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { errorMessage } from '@/lib/api/errors';
import { istanbulToday } from '@/lib/maintenance/schedule';
import { formatPlate, normalizePlate } from '@/lib/gate/plate';
import { LogRow } from '@/components/gate/GateUi';
import { UnitPicker } from './shared';

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

type Kind = '' | 'guest' | 'courier' | 'manual';

/**
 * Kapi gunlugu. Yonetim: tarih araligi + tur filtresi (varsayilan son 7 gun). Gorevli: dun ve bugun
 * (API de bunu zorlar). Kayitlar silinmez; "daha fazla yukle" ile geriye gidilir.
 */
export function GateLogPanel() {
  const { canManage } = useGatePermissions();
  const today = istanbulToday();
  const [from, setFrom] = useState(addDays(today, canManage ? -6 : -1));
  const [to, setTo] = useState(today);
  const [kind, setKind] = useState<Kind>('');
  const [manual, setManual] = useState(false);
  const log = useGateLog({ from, to, ...(kind ? { kind } : {}) });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        {canManage ? (
          <div className="flex flex-wrap items-end gap-3">
            <FormField label="Başlangıç">
              <Input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            </FormField>
            <FormField label="Bitiş">
              <Input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
            </FormField>
          </div>
        ) : (
          <p className="text-small text-muted">Dün ve bugünün kayıtları</p>
        )}
        <Button className="h-12 text-body" onClick={() => setManual(true)}>
          <Plus className="size-5" aria-hidden="true" />
          Elle giriş / çıkış
        </Button>
      </div>
      <FilterChips
        label="Kayıt türü"
        value={kind}
        onChange={setKind}
        options={[
          { value: '', label: 'Tümü' },
          { value: 'guest', label: 'Misafir' },
          { value: 'courier', label: 'Kurye' },
          { value: 'manual', label: 'Elle kayıt' },
        ]}
      />
      {log.isPending ? (
        <Skeleton className="h-40" />
      ) : log.isError ? (
        <Alert tone="danger">{errorMessage(log.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">Bu aralıkta kapı kaydı yok.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((e) => (
            <LogRow key={e.logId} e={e} />
          ))}
        </ul>
      )}
      {log.hasNextPage && (
        <Button variant="secondary" loading={log.isFetchingNextPage} onClick={() => void log.fetchNextPage()}>
          Daha fazla yükle
        </Button>
      )}
      <ManualEntryDialog open={manual} onClose={() => setManual(false)} />
    </div>
  );
}

/** QR'siz ziyaretci, servis araci vb. icin elle giris / cikis kaydi (gunluge yazilir). */
export function ManualEntryDialog({ open, onClose, plate: initialPlate }: { open: boolean; onClose: () => void; plate?: string }) {
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [direction, setDirection] = useState<'entry' | 'exit'>('entry');
  const [visitorName, setVisitorName] = useState('');
  const [unitId, setUnitId] = useState('');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [seeded, setSeeded] = useState<string | undefined>();
  // Plaka sorgusundan gelince plaka alani dolu acilir.
  if (open && initialPlate && seeded !== initialPlate) {
    setSeeded(initialPlate);
    setPlate(formatPlate(initialPlate));
  }

  const close = () => {
    setVisitorName('');
    setUnitId('');
    setPlate('');
    setNote('');
    setError(null);
    setSeeded(undefined);
    onClose();
  };
  const valid = visitorName.trim().length >= 2;
  const submit = () => {
    setError(null);
    const p = normalizePlate(plate);
    a.manualEntry.mutate(
      { idempotencyKey: key, direction, visitorName: visitorName.trim(), ...(unitId ? { unitId } : {}), ...(p ? { plate: p } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          renew();
          close();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  };

  return (
    <Dialog open={open} onClose={close} title="Elle kapı kaydı">
      <div className="flex flex-col gap-4">
        <FilterChips
          label="Yön"
          value={direction}
          onChange={setDirection}
          options={[
            { value: 'entry', label: 'Giriş' },
            { value: 'exit', label: 'Çıkış' },
          ]}
        />
        <FormField label="Ziyaretçi adı / açıklama" hint="Örnek: Elektrikçi Hasan, su servisi">
          <Input value={visitorName} onChange={(e) => setVisitorName(e.target.value)} maxLength={80} className="h-12 text-body" />
        </FormField>
        <div className="flex flex-col gap-1.5">
          <span className="text-small font-medium">Gittiği bağımsız bölüm (isteğe bağlı)</span>
          <UnitPicker value={unitId} onChange={setUnitId} optional />
        </div>
        <FormField label="Plaka (isteğe bağlı)">
          <Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} maxLength={14} autoCapitalize="characters" className="h-12 font-mono text-body" />
        </FormField>
        <FormField label="Not (isteğe bağlı)">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
        </FormField>
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={close}>
            Vazgeç
          </Button>
          <Button className="h-12 text-body" disabled={!valid} loading={a.manualEntry.isPending} onClick={submit}>
            Kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
