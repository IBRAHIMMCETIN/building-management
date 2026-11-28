import { ArrowRightLeft, CheckCircle2, CircleAlert, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Select, Skeleton, Textarea } from '@/components/ui';
import { useOwnershipPermissions, useReverseTransfer, useSetBilling, useSetRepresentative, useUnitOwnership, useUnitTransfers } from '@/hooks/useOwnership';
import { useFeature } from '@/context/SiteFeaturesContext';
import { errorMessage } from '@/lib/api/errors';
import { OWNER_BILLING_MODES, type OwnerBilling, type OwnershipTransfer, type UnitOwnership } from '@/lib/api/ownership';
import { cn } from '@/lib/cn';
import { formatDate, formatDateTime } from '@/lib/dates';
import {
  BILLING_HINTS,
  BILLING_LABELS,
  TRANSFER_KIND_LABELS,
  formatBps,
  formatShare,
  isCompleteTable,
  totalShare,
} from '@/lib/ownership/shares';
import { RegisterSharesDialog } from '../finance/RegisterSharesDialog';
import { reasonError } from './moveOut';
import { OwnershipTransferWizard } from './OwnershipTransferWizard';
import type { UnitRow } from './unitRows';

type Props = {
  row: UnitRow | null;
  names: Map<string, string>;
  people: { userId: string; fullName: string }[];
  onClose: () => void;
};

const SOURCE_LABELS = { backfill: 'İlk sicil', manual: 'Sicil düzeltmesi', transfer: 'Devir', reversal: 'Devir geri alındı' } as const;

/** Pay tablosu + toplam gostergesi + temsilci isareti. */
export function OwnersTable({ data, names }: { data: UnitOwnership; names: Map<string, string> }) {
  const owners = data.current?.owners ?? [];
  if (owners.length === 0) {
    return data.incomplete ? (
      <ul className="flex flex-col gap-1 text-small">
        {data.incomplete.owners.map((o) => (
          <li key={o.userId} className="flex justify-between">
            <span>{names.get(o.userId) ?? 'Adı kayıtlı değil'}</span>
            <span className="tabular-nums text-muted">{o.share ? formatShare(o.share) : 'pay girilmemiş'}</span>
          </li>
        ))}
      </ul>
    ) : (
      <p className="text-small text-muted">Bu bölümde kayıtlı malik yok.</p>
    );
  }
  const total = totalShare(owners.map((o) => o.share));
  const complete = isCompleteTable(owners.map((o) => o.share));
  return (
    <table className="w-full text-left text-small">
      <caption className="sr-only">Paydaşlar ve payları</caption>
      <thead className="text-xs text-muted">
        <tr>
          <th scope="col" className="py-1 font-medium">Paydaş</th>
          <th scope="col" className="py-1 text-right font-medium">Pay</th>
          <th scope="col" className="py-1 text-right font-medium">Oran</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {owners.map((o) => (
          <tr key={o.userId}>
            <td className="py-1.5">
              {names.get(o.userId) ?? 'Adı kayıtlı değil'}
              {data.representativeUserId === o.userId && owners.length > 1 && (
                <Badge tone="accent" className="ml-2">
                  temsilci
                </Badge>
              )}
            </td>
            <td className="py-1.5 text-right tabular-nums">{formatShare(o.share)}</td>
            <td className="py-1.5 text-right tabular-nums">{formatBps(o.bps)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t border-border-strong font-medium">
          <td className="py-1.5">Toplam</td>
          <td className="py-1.5 text-right tabular-nums">{formatShare(total)}</td>
          <td className={cn('py-1.5 text-right', complete ? 'text-success' : 'text-danger')}>
            <span className="inline-flex items-center gap-1">
              {complete ? <CheckCircle2 className="size-4" aria-hidden="true" /> : <CircleAlert className="size-4" aria-hidden="true" />}
              {complete ? 'Tam' : 'Eksik'}
            </span>
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

function BillingForm({ unitId, data }: { unitId: string; data: UnitOwnership }) {
  const set = useSetBilling();
  const [mode, setMode] = useState<OwnerBilling>(data.billing);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => setMode(data.billing), [data.billing]);
  const changed = mode !== data.billing;
  const submit = async () => {
    setTouched(true);
    if (reasonError(reason)) return;
    try {
      await set.mutateAsync({ unitId, mode, reason: reason.trim(), version: data.version });
      setReason('');
      setTouched(false);
    } catch {
      // Uyari asagida (or. ortak cari bakiyesi sifir degil -> 422).
    }
  };
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-small font-medium">Malik faturalama modu</legend>
      {OWNER_BILLING_MODES.map((m) => (
        <label key={m} className="flex items-start gap-2 text-small">
          <input type="radio" name="billing" className="mt-1" checked={mode === m} onChange={() => setMode(m)} />
          <span>
            <span className="font-medium">{BILLING_LABELS[m]}</span>
            <span className="block text-xs text-muted">{BILLING_HINTS[m]}</span>
          </span>
        </label>
      ))}
      {changed && (
        <>
          <FormField label="Gerekçe" error={touched ? reasonError(reason) : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Paydaşlar ayrı ödeme talep etti" />
          </FormField>
          {set.isError && <Alert tone="danger">{errorMessage(set.error)}</Alert>}
          <div className="flex justify-end">
            <Button size="sm" loading={set.isPending} onClick={() => void submit()}>
              Modu kaydet
            </Button>
          </div>
        </>
      )}
    </fieldset>
  );
}

function RepresentativeForm({ unitId, data, names }: { unitId: string; data: UnitOwnership; names: Map<string, string> }) {
  const set = useSetRepresentative();
  const owners = data.current?.owners ?? [];
  const [userId, setUserId] = useState(data.representativeUserId ?? '');
  useEffect(() => setUserId(data.representativeUserId ?? ''), [data.representativeUserId]);
  if (owners.length < 2) return null;
  return (
    <div className="flex flex-col gap-2">
      {!data.representativeUserId && <Alert>Paylı mülkiyette temsilci seçilmemiş (temsilci yok). Kat malikleri kurulunda oyu temsilci kullanır.</Alert>}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <FormField label="Paydaş temsilcisi">
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Temsilci yok</option>
              {owners.map((o) => (
                <option key={o.userId} value={o.userId}>
                  {names.get(o.userId) ?? 'Adı kayıtlı değil'}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        <Button
          size="sm"
          variant="secondary"
          disabled={userId === (data.representativeUserId ?? '')}
          loading={set.isPending}
          onClick={() => void set.mutateAsync({ unitId, userId: userId || null, version: data.version }).catch(() => undefined)}
        >
          Temsilciyi kaydet
        </Button>
      </div>
      {set.isError && <Alert tone="danger">{errorMessage(set.error)}</Alert>}
    </div>
  );
}

function TransferCard({ t, names, canReverse }: { t: OwnershipTransfer; names: Map<string, string>; canReverse: boolean }) {
  const reverse = useReverseTransfer();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const name = (u: string) => names.get(u) ?? 'Adı kayıtlı değil';
  const submit = async () => {
    setTouched(true);
    if (reasonError(reason)) return;
    try {
      await reverse.mutateAsync({ transferId: t.transferId, reason: reason.trim() });
      setOpen(false);
    } catch {
      // Uyari asagida.
    }
  };
  return (
    <li>
      <Card className="p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="text-small font-semibold">
            {formatDate(t.effectiveDate)} · {TRANSFER_KIND_LABELS[t.kind]}
          </p>
          {t.status === 'completed' ? <Badge tone="success">Tamamlandı</Badge> : <Badge>Geri alındı</Badge>}
        </div>
        <ul className="mt-1 text-small text-muted">
          {t.moves.map((m, i) => (
            <li key={i}>
              {name(m.fromUserId)} → {name(m.toUserId)}: {formatShare(m.share)}
            </li>
          ))}
        </ul>
        {t.closures.length > 0 && <p className="text-xs text-muted">{t.closures.length} cari kapatıldı.</p>}
        <p className="text-xs text-muted">
          Gerekçe: {t.reason} · {formatDateTime(t.createdAt)}
        </p>
        {t.reversal && <p className="text-xs text-muted">Geri alındı: {t.reversal.reason}</p>}
        {canReverse && !open && (
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
              <Undo2 className="size-4" aria-hidden="true" />
              Geri al
            </Button>
          </div>
        )}
        {open && (
          <div className="mt-2 flex flex-col gap-2 border-t border-border pt-2">
            {reverse.isError && <Alert tone="danger">{errorMessage(reverse.error)}</Alert>}
            <FormField label="Geri alma gerekçesi" error={touched ? reasonError(reason) : undefined}>
              <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Vazgeç
              </Button>
              <Button variant="danger" size="sm" loading={reverse.isPending} onClick={() => void submit()}>
                Devri geri al
              </Button>
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}

type ViewProps = { unitId: string; unitLabel: string; names: Map<string, string>; people: { userId: string; fullName: string }[] };

/** Daire ayrintisi - "Mulkiyet" sekmesi icerigi: paydaslar, temsilci, faturalama modu, gecmis, devirler. */
export function UnitOwnershipView({ unitId, unitLabel, names, people }: ViewProps) {
  const { canWrite } = useOwnershipPermissions();
  // Adim 1: bolunmus cari modu ve devir sihirbazi `admin.sharedOwnership` ozelligine bagli
  // (platform ekibi kurulumda acip kullanir). Pay tablosu, hisse duzeltme ve temsilci acik kalir.
  const sharedOn = useFeature('admin.sharedOwnership');
  const ownership = useUnitOwnership(unitId);
  const transfers = useUnitTransfers(unitId);
  const [mode, setMode] = useState<'view' | 'wizard'>('view');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [run, setRun] = useState(0);

  const data = ownership.data;
  const list = transfers.data ?? [];
  // Yalnizca son tamamlanmis devir geri alinabilir (sonraki sicil hareketi yoksa; API dogrular).
  const latest = list.find((t) => t.status === 'completed');
  const complete = !!data?.current && isCompleteTable(data.current.owners.map((o) => o.share));

  if (mode === 'wizard' && data?.current && sharedOn) {
    return (
      <OwnershipTransferWizard
        key={run}
        unitId={unitId}
        unitLabel={unitLabel}
        owners={data.current.owners}
        people={people}
        names={names}
        onCancel={() => setMode('view')}
        onDone={() => setMode('view')}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {ownership.isPending && (
        <div role="status" aria-label="Mülkiyet yükleniyor" className="flex flex-col gap-2">
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {ownership.isError && <Alert tone="danger">{errorMessage(ownership.error)}</Alert>}
      {data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-2">
              <Badge tone={data.billing === 'split' ? 'accent' : 'neutral'}>{BILLING_LABELS[data.billing]}</Badge>
              {data.registered ? <Badge tone="success">Sicil kayıtlı</Badge> : <Badge tone="warning">Sicil oluşturulmamış</Badge>}
            </div>
            {canWrite && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setRegisterOpen(true)}>
                  Hisseleri düzenle
                </Button>
                {sharedOn && (
                  <Button
                    size="sm"
                    disabled={!complete}
                    title={complete ? undefined : 'Önce hisseleri tamamlayın'}
                    onClick={() => {
                      setRun((n) => n + 1);
                      setMode('wizard');
                    }}
                  >
                    <ArrowRightLeft className="size-4" aria-hidden="true" />
                    Mülk / hisse devri
                  </Button>
                )}
              </div>
            )}
          </div>

          {data.warnings
            .filter((w) => w !== 'temsilci yok')
            .map((w) => (
              <Alert key={w}>{w}</Alert>
            ))}

          <Card className="p-4">
            <OwnersTable data={data} names={names} />
          </Card>

          {canWrite ? (
            <>
              <RepresentativeForm unitId={unitId} data={data} names={names} />
              {sharedOn && <BillingForm unitId={unitId} data={data} />}
            </>
          ) : (
            data.warnings.includes('temsilci yok') && <Alert>Paylı mülkiyette temsilci seçilmemiş (temsilci yok).</Alert>
          )}

          {data.history.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="text-small font-medium">Mülkiyet geçmişi</p>
              <ul className="flex flex-col gap-1 text-small">
                {data.history.map((h) => (
                  <li key={h.seq} className="flex flex-wrap justify-between gap-2 border-b border-border py-1">
                    <span>
                      {formatDate(h.validFrom)} · {SOURCE_LABELS[h.source]}
                    </span>
                    <span className="text-muted">
                      {h.owners.map((o) => `${names.get(o.userId) ?? 'Adı kayıtlı değil'} ${formatShare(o.share)}`).join(', ')}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sharedOn && list.length > 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-small font-medium">Devirler</p>
              <ul className="flex flex-col gap-2">
                {list.map((t) => (
                  <TransferCard key={t.transferId} t={t} names={names} canReverse={canWrite && t.transferId === latest?.transferId} />
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      {canWrite && <RegisterSharesDialog open={registerOpen} unitId={unitId} unitLabel={unitLabel} names={names} onClose={() => setRegisterOpen(false)} />}
    </div>
  );
}

/** Daire ayrintisi: "Mulkiyet" penceresi (Daireler ekranindan). */
export function UnitOwnershipDialog({ row, names, people, onClose }: Props) {
  const unitLabel = row ? `${row.blockName} / ${row.unit.number}` : '';
  return (
    <Dialog open={row !== null} onClose={onClose} title={`Mülkiyet · ${unitLabel}`} className="max-w-2xl">
      {row && <UnitOwnershipView key={row.unit.unitId} unitId={row.unit.unitId} unitLabel={unitLabel} names={names} people={people} />}
    </Dialog>
  );
}
