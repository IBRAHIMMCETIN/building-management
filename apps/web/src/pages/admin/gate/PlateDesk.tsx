import { Car, Search, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Badge, Button, Card, Input, Skeleton } from '@/components/ui';
import { usePlateLookup } from '@/hooks/useGate';
import { errorMessage } from '@/lib/api/errors';
import { normalizePlate } from '@/lib/gate/plate';
import { ManualEntryDialog } from './GateLogPanel';

/**
 * Plaka sorgusu: tam plaka veya son en az 3 karakter. Sonucta yalnizca bagimsiz bolum, kayit
 * durumu ve arac notu vardir; kisi adi / telefon / borc gosterilmez.
 */
export function PlateDesk() {
  const [text, setText] = useState('');
  const [query, setQuery] = useState<string>();
  const [manualPlate, setManualPlate] = useState<string>();
  const lookup = usePlateLookup(query);
  const q = normalizePlate(text);

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.length >= 3) setQuery(q);
          }}
        >
          <label htmlFor="plate-q" className="text-small font-medium">
            Plaka (tamamı veya son 3+ karakter)
          </label>
          <div className="flex gap-2">
            <Input
              id="plate-q"
              type="search"
              value={text}
              onChange={(e) => setText(e.target.value.toUpperCase())}
              placeholder="34 ABC 123"
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              maxLength={14}
              className="h-14 font-mono text-heading tracking-wider"
            />
            <Button type="submit" className="h-14 px-6 text-body" disabled={q.length < 3} loading={lookup.isFetching}>
              <Search className="size-5" aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">Sorgula</span>
            </Button>
          </div>
        </form>
      </Card>

      {query &&
        (lookup.isPending ? (
          <Skeleton className="h-24" />
        ) : lookup.isError ? (
          <Alert tone="danger">{errorMessage(lookup.error)}</Alert>
        ) : lookup.data.items.length === 0 ? (
          <Card className="flex flex-col gap-3 border-2 border-warning/50" aria-live="polite">
            <p className="text-heading font-bold text-warning">Kayıtlı değil</p>
            <p className="text-body">
              <span className="font-mono font-semibold">{lookup.data.queryDisplay}</span> sitede kayıtlı bir araç değil.
            </p>
            <Button variant="secondary" className="h-12 text-body" onClick={() => setManualPlate(lookup.data.query)}>
              <UserPlus className="size-5" aria-hidden="true" />
              Ziyaretçi olarak giriş kaydet
            </Button>
          </Card>
        ) : (
          <ul className="flex flex-col gap-2" aria-live="polite">
            {lookup.data.items.map((r) => (
              <li key={r.plate} className={`flex items-center gap-3 rounded-xl border-2 bg-surface p-4 shadow-xs ${r.active ? 'border-success/40' : 'border-border'}`}>
                <Car className={r.active ? 'size-8 shrink-0 text-success' : 'size-8 shrink-0 text-muted'} aria-hidden="true" />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="font-mono text-heading font-bold">{r.plateDisplay}</span>
                  <span className="text-body font-medium">{r.unitLabel}</span>
                  {r.note && <span className="text-small text-muted">{r.note}</span>}
                </span>
                <Badge tone={r.active ? 'success' : 'neutral'}>{r.active ? 'Kayıtlı · aktif' : 'Kayıtlı · pasif'}</Badge>
              </li>
            ))}
          </ul>
        ))}
      <ManualEntryDialog open={manualPlate !== undefined} plate={manualPlate} onClose={() => setManualPlate(undefined)} />
    </div>
  );
}
