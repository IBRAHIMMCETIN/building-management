import { Package, Plus, QrCode } from 'lucide-react';
import { useState } from 'react';
import { LogRow, VerdictBadge, timeOf } from '@/components/gate/GateUi';
import { VehicleList } from '@/components/gate/VehicleList';
import { Alert, Button, Card, CardTitle, FilterChips, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useGateLog, useMyCouriers, useMyGate, useMyGateActions, useMyPasses, useMyVehicles } from '@/hooks/useGate';
import type { Courier, MyPass } from '@/lib/api/gate';
import { errorMessage } from '@/lib/api/errors';
import { normalizePlate, plateError, validityText } from '@/lib/gate/plate';
import { NewPassDialog } from './NewPassDialog';
import { PassShareDialog } from './PassShareDialog';

type Tab = 'guests' | 'vehicles' | 'history';
type Unit = { unitId: string; label: string };

/**
 * Sakin "Ziyaretçi": kapidaki kuryeye onay (kayitta e-posta bildirimi; sayfa acikken ayrica 15 sn'de
 * bir yenilenir), misafir gecisi
 * (QR + kisa kod paylasimi), araclarim ve dairemin kapi kayitlari. Yalnizca dairede oturan sakinler
 * (kiraci veya oturan malik) kullanir.
 */
export function MyGatePage() {
  const overview = useMyGate();
  const [tab, setTab] = useState<Tab>('guests');

  // Yukleme / hata durumlari da sayfanin genisligiyle (masaustunde ortalanmis max-w-2xl).
  if (overview.isPending) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Skeleton className="h-48" />
      </div>
    );
  }
  if (overview.isError) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Alert tone="danger">{errorMessage(overview.error)}</Alert>
      </div>
    );
  }
  const { units, limits } = overview.data;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
      <h1 className="text-title font-bold">Ziyaretçi</h1>
      {units.length === 0 ? (
        <Alert>Misafir geçişi, kurye onayı ve araç kaydı yalnızca dairede oturan sakinler içindir. Bir hata olduğunu düşünüyorsanız yönetimle iletişime geçin.</Alert>
      ) : (
        <>
          <WaitingCouriers />
          <FilterChips
            label="Ziyaretçi bölümü"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'guests', label: 'Misafirler' },
              { value: 'vehicles', label: 'Araçlarım' },
              { value: 'history', label: 'Kapı kayıtları' },
            ]}
          />
          {tab === 'guests' && <Guests units={units} limits={limits} />}
          {tab === 'vehicles' && <MyVehicles units={units} max={limits.maxVehiclesPerUnit} />}
          {tab === 'history' && <History units={units} />}
        </>
      )}
    </div>
  );
}

function WaitingCouriers() {
  const couriers = useMyCouriers();
  const waiting = (couriers.data ?? []).filter((c) => c.canRespond);
  if (!waiting.length) return null;
  return (
    <section aria-label="Onay bekleyen kuryeler" aria-live="polite" className="flex flex-col gap-2">
      {waiting.map((c) => (
        <CourierPrompt key={c.courierId} c={c} />
      ))}
    </section>
  );
}

function CourierPrompt({ c }: { c: Courier }) {
  const a = useMyGateActions();
  const respond = (decision: 'approve' | 'decline') => a.respondCourier.mutate({ id: c.courierId, version: c.version, decision });
  return (
    <Card className="flex flex-col gap-3 border-2 border-warning/50">
      <CardTitle className="flex items-center gap-2">
        <Package className="size-5 text-warning" aria-hidden="true" />
        Kapıda kurye var
      </CardTitle>
      <p className="text-body">
        <span className="font-semibold">{c.company ?? 'Kurye'}</span> · {c.unitLabel} · {timeOf(c.createdAt)}
        {c.note && <span className="block text-small text-text-secondary">Görevlinin notu: {c.note}</span>}
      </p>
      <p className="text-small text-muted">Yanıt için son saat: {timeOf(c.respondBy)}. Yanıt verilmezse kurye içeri alınmaz.</p>
      {a.respondCourier.error && <Alert tone="danger">{errorMessage(a.respondCourier.error)}</Alert>}
      <div className="grid grid-cols-2 gap-2">
        <Button className="h-12 text-body" loading={a.respondCourier.isPending && a.respondCourier.variables?.decision === 'approve'} onClick={() => respond('approve')}>
          İçeri alınsın
        </Button>
        <Button variant="secondary" className="h-12 text-body" loading={a.respondCourier.isPending && a.respondCourier.variables?.decision === 'decline'} onClick={() => respond('decline')}>
          Reddet
        </Button>
      </div>
    </Card>
  );
}

function Guests({ units, limits }: { units: Unit[]; limits: { maxPassDays: number; maxPassLeadDays: number } }) {
  const passes = useMyPasses();
  const a = useMyGateActions();
  const [creating, setCreating] = useState(false);
  const [shown, setShown] = useState<MyPass>();
  /** `revoke:<id>` veya `rotate:<id>`: ikinci dokunusla onaylanan islem. */
  const [confirm, setConfirm] = useState<string>();
  const items = passes.data ?? [];
  const rotate = (p: MyPass) => a.rotatePass.mutate({ id: p.passId, version: p.version }, { onSuccess: (r) => setShown(r.pass), onSettled: () => setConfirm(undefined) });

  return (
    <div className="flex flex-col gap-3">
      <Button className="h-12 text-body" onClick={() => setCreating(true)}>
        <Plus className="size-5" aria-hidden="true" />
        Misafir geçişi oluştur
      </Button>
      {a.revokePass.error && <Alert tone="danger">{errorMessage(a.revokePass.error)}</Alert>}
      {a.rotatePass.error && <Alert tone="danger">{errorMessage(a.rotatePass.error)}</Alert>}
      {passes.isPending ? (
        <Skeleton className="h-32" />
      ) : passes.isError ? (
        <Alert tone="danger">{errorMessage(passes.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-small text-muted">Henüz misafir geçişi yok. Misafiriniz gelmeden önce geçiş oluşturup QR'ı paylaşın.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <li key={p.passId} className="flex flex-col gap-2 rounded-xl border border-border bg-surface p-3 shadow-xs">
              <div className="flex items-start justify-between gap-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-medium">{p.guestName}</span>
                  <span className="text-small text-text-secondary">
                    {validityText(p.validFrom, p.validUntil)} · {p.entryMode === 'single' ? 'Tek giriş' : 'Çoklu giriş'}
                    {units.length > 1 && ` · ${p.unitLabel}`}
                  </span>
                  {p.inside && <span className="text-small text-accent">Şu an sitede</span>}
                </span>
                <VerdictBadge verdict={p.verdict} />
              </div>
              {confirm === `rotate:${p.passId}` && <p className="text-small text-text-secondary">Yeni QR ve kod oluşturulur; daha önce paylaştığınız QR ve kod çalışmaz. Yenisini misafirinize gönderin.</p>}
              {(p.canRotate || p.canRevoke) && (
                <div className="flex flex-wrap justify-end gap-2">
                  {confirm === `revoke:${p.passId}` || confirm === `rotate:${p.passId}` ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setConfirm(undefined)}>
                        Vazgeç
                      </Button>
                      {confirm === `revoke:${p.passId}` ? (
                        <Button size="sm" variant="danger" loading={a.revokePass.isPending} onClick={() => a.revokePass.mutate({ id: p.passId, version: p.version }, { onSettled: () => setConfirm(undefined) })}>
                          Evet, iptal et
                        </Button>
                      ) : (
                        <Button size="sm" loading={a.rotatePass.isPending} onClick={() => rotate(p)}>
                          Evet, yeni QR oluştur
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      {p.canRevoke && (
                        <Button size="sm" variant="subtle" onClick={() => setConfirm(`revoke:${p.passId}`)}>
                          İptal et
                        </Button>
                      )}
                      {p.canRotate && (
                        <Button size="sm" variant="secondary" onClick={() => setConfirm(`rotate:${p.passId}`)}>
                          <QrCode className="size-4" aria-hidden="true" />
                          Yeni QR oluştur
                        </Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <NewPassDialog open={creating} onClose={() => setCreating(false)} units={units} limits={limits} onCreated={setShown} />
      <PassShareDialog pass={shown} onClose={() => setShown(undefined)} />
    </div>
  );
}

function MyVehicles({ units, max }: { units: Unit[]; max: number }) {
  const vehicles = useMyVehicles();
  const a = useMyGateActions();
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const [plate, setPlate] = useState('');
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [pendingId, setPendingId] = useState<string>();
  const [toggleError, setToggleError] = useState<string>();
  const items = vehicles.data?.items ?? [];
  const plateMsg = touched ? plateError(plate) : undefined;

  const add = () => {
    setTouched(true);
    if (plateError(plate)) return;
    a.createVehicle.mutate(
      { unitId: unitId || units[0]?.unitId || '', plate: normalizePlate(plate), ...(note.trim() ? { note: note.trim() } : {}) },
      {
        onSuccess: () => {
          setPlate('');
          setNote('');
          setTouched(false);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card className="flex flex-col gap-3">
        <CardTitle>Araç ekle</CardTitle>
        <p className="text-small text-muted">Güvenlik plakayı sorguladığında yalnızca dairenizi ve aracın notunu görür. Bir daireye en fazla {max} aktif araç kaydedilir.</p>
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
        <FormField label="Plaka" error={plateMsg} hint="Örnek: 34 ABC 123">
          <Input value={plate} onChange={(e) => setPlate(e.target.value.toUpperCase())} onBlur={() => plate && setTouched(true)} maxLength={14} autoCapitalize="characters" className="h-12 font-mono text-body" />
        </FormField>
        <FormField label="Not (isteğe bağlı)" hint="Renk / marka, örnek: beyaz Fiat Egea">
          <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={80} className="h-12 text-body" />
        </FormField>
        {a.createVehicle.error && <Alert tone="danger">{errorMessage(a.createVehicle.error)}</Alert>}
        <Button className="h-12 text-body" loading={a.createVehicle.isPending} onClick={add}>
          Aracı kaydet
        </Button>
      </Card>
      {toggleError && <Alert tone="danger">{toggleError}</Alert>}
      {vehicles.isPending ? (
        <Skeleton className="h-24" />
      ) : vehicles.isError ? (
        <Alert tone="danger">{errorMessage(vehicles.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-small text-muted">Kayıtlı aracınız yok.</p>
      ) : (
        <VehicleList
          items={items}
          showUnit={units.length > 1}
          pendingId={pendingId}
          onToggle={(v) => {
            setPendingId(v.vehicleId);
            setToggleError(undefined);
            a.updateVehicle.mutate(
              { id: v.vehicleId, input: { version: v.version, status: v.status === 'active' ? 'inactive' : 'active' } },
              { onError: (err) => setToggleError(errorMessage(err)), onSettled: () => setPendingId(undefined) },
            );
          }}
        />
      )}
    </div>
  );
}

function History({ units }: { units: Unit[] }) {
  const [unitId, setUnitId] = useState(units[0]?.unitId ?? '');
  const log = useGateLog({ unitId }, { portal: true });
  const items = log.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="flex flex-col gap-3">
      {units.length > 1 && (
        <FormField label="Daire">
          <Select value={unitId} onChange={(e) => setUnitId(e.target.value)}>
            {units.map((u) => (
              <option key={u.unitId} value={u.unitId}>
                {u.label}
              </option>
            ))}
          </Select>
        </FormField>
      )}
      <p className="text-small text-muted">Dairenize gelen misafir, kurye ve ziyaretçilerin son 7 günlük giriş / çıkış kayıtları.</p>
      {log.isPending ? (
        <Skeleton className="h-32" />
      ) : log.isError ? (
        <Alert tone="danger">{errorMessage(log.error)}</Alert>
      ) : items.length === 0 ? (
        <p className="py-8 text-center text-small text-muted">Son 7 günde kapı kaydı yok.</p>
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
    </div>
  );
}
