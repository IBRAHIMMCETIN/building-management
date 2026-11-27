import { LogIn, LogOut, Package, X } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, CardTitle, FilterChips, FormField, Input, Skeleton } from '@/components/ui';
import { useDeskActions, useDeskCouriers } from '@/hooks/useGate';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import type { Courier } from '@/lib/api/gate';
import { errorMessage } from '@/lib/api/errors';
import { CourierBadge, timeOf } from '@/components/gate/GateUi';
import { UnitPicker } from './shared';

const COMPANIES = ['Trendyol', 'Hepsiburada', 'Amazon', 'Getir', 'Yemeksepeti', 'Yurtiçi', 'Aras', 'MNG', 'PTT'];

/**
 * Kurye: gorevli gelen kuryeyi bolum icin kaydeder, daire sakini portaldan onaylar / reddeder
 * (liste 15 sn'de bir yenilenir). Onaylanan kurye iceri alinir ve cikisi kaydedilir.
 */
export function CourierDesk() {
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const list = useDeskCouriers(status);
  const items = list.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <NewCourierCard />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-heading font-semibold">Kuryeler</h2>
        <FilterChips
          label="Kurye listesi"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'open', label: 'Bekleyen / içeride' },
            { value: 'all', label: 'Son 50' },
          ]}
        />
      </div>
      {list.isPending ? (
        <Skeleton className="h-32" />
      ) : list.isError ? (
        <Alert tone="danger">{errorMessage(list.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-small text-muted">{status === 'open' ? 'Bekleyen kurye yok.' : 'Kurye kaydı yok.'}</p>
      ) : (
        <ul className="flex flex-col gap-2" aria-live="polite">
          {items.map((c) => (
            <CourierRow key={c.courierId} c={c} />
          ))}
        </ul>
      )}
    </div>
  );
}

function NewCourierCard() {
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [unitId, setUnitId] = useState('');
  const [company, setCompany] = useState('');
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string>();

  const submit = () => {
    setDone(undefined);
    a.createCourier.mutate(
      { idempotencyKey: key, unitId, ...(company.trim() ? { company: company.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: (r) => {
          setDone(`${r.courier.unitLabel} için kurye kaydedildi; daire sakininin onayı bekleniyor.`);
          setUnitId('');
          setCompany('');
          setNote('');
          renew();
        },
      },
    );
  };

  return (
    <Card className="flex flex-col gap-4">
      <CardTitle className="flex items-center gap-2">
        <Package className="size-5 text-accent" aria-hidden="true" />
        Kurye geldi
      </CardTitle>
      <div className="flex flex-col gap-1.5">
        <span className="text-small font-medium">Teslimat yapılacak bağımsız bölüm</span>
        <UnitPicker value={unitId} onChange={setUnitId} />
      </div>
      <div className="flex flex-col gap-2">
        <FormField label="Firma (isteğe bağlı)">
          <Input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={40} className="h-12 text-body" />
        </FormField>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Sık kullanılan firmalar">
          {COMPANIES.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={company === c}
              onClick={() => setCompany(c)}
              className="min-h-10 rounded-full border border-border-strong px-3 text-small text-text-secondary hover:bg-surface-muted aria-pressed:border-accent/30 aria-pressed:bg-accent/10 aria-pressed:text-accent"
            >
              {c}
            </button>
          ))}
        </div>
      </div>
      <FormField label="Not (isteğe bağlı)">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Örnek: büyük koli, kapıda ödeme" className="h-12 text-body" />
      </FormField>
      {done && <Alert tone="success">{done}</Alert>}
      {a.createCourier.error && <Alert tone="danger">{errorMessage(a.createCourier.error)}</Alert>}
      <Button className="h-14 text-body" disabled={!unitId} loading={a.createCourier.isPending} onClick={submit}>
        Daireye bildir
      </Button>
    </Card>
  );
}

function CourierRow({ c }: { c: Courier }) {
  const a = useDeskActions();
  const [key, renew] = useIdempotencyKey();
  const [error, setError] = useState<string>();
  const opts = { onSuccess: () => renew(), onError: (err: unknown) => setError(errorMessage(err)) };
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-1">
          <span className="text-body font-semibold">{c.unitLabel}</span>
          <span className="text-small text-text-secondary">
            {c.company ?? 'Kurye'} · {timeOf(c.createdAt)}
            {c.note && ` · ${c.note}`}
          </span>
          {c.responseNote && <span className="text-small text-muted">Sakinin notu: {c.responseNote}</span>}
          {c.enterBy && !c.approvalExpired && <span className="text-small text-muted">Onay {timeOf(c.enterBy)} saatine kadar geçerli</span>}
          {c.approvalExpired && <span className="text-small text-muted">Onayın süresi doldu; kurye hâlâ kapıdaysa yeniden kaydedin.</span>}
        </span>
        <CourierBadge courier={c} />
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {(c.canEnter || c.canExit || c.canCancel) && (
        <div className="grid grid-cols-2 gap-2">
          {c.canEnter && (
            <Button className="h-12 text-body" loading={a.courierEntry.isPending} onClick={() => a.courierEntry.mutate({ id: c.courierId, key }, opts)}>
              <LogIn className="size-5" aria-hidden="true" />
              İçeri al
            </Button>
          )}
          {c.canExit && (
            <Button className="h-12 text-body" loading={a.courierExit.isPending} onClick={() => a.courierExit.mutate({ id: c.courierId, key }, opts)}>
              <LogOut className="size-5" aria-hidden="true" />
              Çıkış kaydet
            </Button>
          )}
          {c.canCancel && (
            <Button variant="secondary" className="h-12 text-body" loading={a.cancelCourier.isPending} onClick={() => a.cancelCourier.mutate({ id: c.courierId, version: c.version }, { onError: opts.onError })}>
              <X className="size-5" aria-hidden="true" />
              Kapat
            </Button>
          )}
        </div>
      )}
    </li>
  );
}
