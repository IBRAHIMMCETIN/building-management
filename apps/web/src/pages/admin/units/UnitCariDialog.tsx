import { ArrowLeftRight, CalendarRange, History, LogOut, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Skeleton, Textarea } from '@/components/ui';
import { useReverseClosure, useUnitClosures } from '@/hooks/useClosures';
import { useFinancePermissions } from '@/hooks/useFinance';
import { usePlans } from '@/hooks/useRestructure';
import { useFeature } from '@/context/SiteFeaturesContext';
import type { CariClosure } from '@/lib/api/closures';
import { errorMessage } from '@/lib/api/errors';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { PLAN_STATUS_LABELS, PLAN_STATUS_TONES, installmentSummary } from '@/lib/restructure/model';
import { OffsetDialog } from '../finance/OffsetDialog';
import { RestructureWizard } from '../finance/RestructureWizard';
import { MoveOutWizard } from './MoveOutWizard';
import { CLOSURE_PARTY_LABELS, canOfferReverse, outcomeText, reasonError } from './moveOut';
import type { UnitRow } from './unitRows';

type Props = {
  row: UnitRow | null;
  /** Kisi adlari (userId -> ad); yetki yoksa bos. */
  names: Map<string, string>;
  /** Acilista dogrudan sihirbaz (Taşınma dugmesi) mi, gecmis mi? */
  startWithWizard: boolean;
  onClose: () => void;
  onInvite: (row: UnitRow) => void;
};

function ReverseForm({ closure, onDone, onCancel }: { closure: CariClosure; onDone: () => void; onCancel: () => void }) {
  const reverse = useReverseClosure();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const error = reasonError(reason);

  const submit = async () => {
    setTouched(true);
    if (error) return;
    try {
      await reverse.mutateAsync({ closureId: closure.closureId, reason: reason.trim() });
      onDone();
    } catch {
      // Uyari asagida gosterilir (or. ayrilan cariden tahsilat alinmis -> 422).
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
      <p className="text-small text-muted">
        Devir ve kapama hareketleri ters kayıtla iptal edilir, kilit kaldırılır ve üyelikler eski haline döner. Çıkışa kadar
        yazılan gecikme tazminatı yerinde kalır.
      </p>
      {reverse.isError && <Alert tone="danger">{errorMessage(reverse.error)}</Alert>}
      <FormField label="Geri alma gerekçesi" error={touched ? error : undefined}>
        <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Yanlış tarih girildi" />
      </FormField>
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={reverse.isPending}>
          Vazgeç
        </Button>
        <Button variant="danger" size="sm" loading={reverse.isPending} onClick={() => void submit()}>
          <Undo2 className="size-4" aria-hidden="true" />
          Kapamayı geri al
        </Button>
      </div>
    </div>
  );
}

function ClosureCard({
  c,
  all,
  names,
  canWrite,
  reversing,
  onReverse,
  onReverseEnd,
}: {
  c: CariClosure;
  all: CariClosure[];
  names: Map<string, string>;
  canWrite: boolean;
  reversing: boolean;
  onReverse: () => void;
  onReverseEnd: () => void;
}) {
  const people = c.userIds.map((u) => names.get(u) ?? 'Adı kayıtlı değil').join(', ');
  return (
    <li>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="font-semibold">
              {formatDate(c.moveOutDate)} · {CLOSURE_PARTY_LABELS[c.party]}
            </p>
            {people && <p className="text-small text-muted">Ayrılan: {people}</p>}
          </div>
          {c.status === 'completed' ? <Badge tone="success">Tamamlandı</Badge> : <Badge>Geri alındı</Badge>}
        </div>
        <p className="mt-2 text-small">{outcomeText(c, formatTRY)}</p>
        {c.ownershipTransferId && <p className="text-small text-muted">Mülk / hisse devriyle yapıldı; geri almak için Mülkiyet penceresinden devri geri alın.</p>}
        {c.lateFee > 0 && <p className="text-small text-muted">Çıkışa kadar yazılan tazminat: {formatTRY(c.lateFee)}</p>}
        <p className="mt-1 text-small text-muted">
          Gerekçe: {c.reason} · {formatDateTime(c.createdAt)}
        </p>
        {c.reversal && (
          <p className="text-small text-muted">
            Geri alındı: {c.reversal.reason} · {formatDateTime(c.reversal.at)}
          </p>
        )}
        {canWrite && !reversing && canOfferReverse(c, all) && (
          <div className="mt-2 flex justify-end">
            <Button variant="ghost" size="sm" onClick={onReverse}>
              <Undo2 className="size-4" aria-hidden="true" />
              Geri al
            </Button>
          </div>
        )}
        {reversing && <ReverseForm closure={c} onDone={onReverseEnd} onCancel={onReverseEnd} />}
      </Card>
    </li>
  );
}

/**
 * Finans 2.2: dairenin acik (aktif / muaccel, tamamlanmamis) taksit planlari ve mahsup /
 * yapilandirma kisayollari. Planli caride tasinma kapamasi yapilamaz (API 409).
 */
export function UnitPlansSection({ unitId, canWrite, onOffset, onRestructure }: { unitId: string; canWrite: boolean; onOffset: () => void; onRestructure: () => void }) {
  const plans = usePlans();
  // Adim 1: borc yapilandirma kapaliysa yalnizca avans mahsubu kisayolu kalir.
  const restructureOn = useFeature('admin.debtRestructure');
  if (!restructureOn) {
    return canWrite ? (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3">
        <p className="text-small font-medium">Avans mahsubu</p>
        <Button size="sm" variant="ghost" onClick={onOffset}>
          <ArrowLeftRight className="size-4" aria-hidden="true" />
          Avans mahsubu
        </Button>
      </div>
    ) : null;
  }
  const open = (plans.data ?? []).filter((p) => p.unitId === unitId && (p.state.displayStatus === 'active' || p.state.displayStatus === 'accelerated'));
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-small font-medium">Taksit planları</p>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={onOffset}>
              <ArrowLeftRight className="size-4" aria-hidden="true" />
              Avans mahsubu
            </Button>
            <Button size="sm" variant="ghost" onClick={onRestructure}>
              <CalendarRange className="size-4" aria-hidden="true" />
              Borç yapılandır
            </Button>
          </div>
        )}
      </div>
      {plans.isError && <Alert tone="danger">{errorMessage(plans.error)}</Alert>}
      {plans.isSuccess && open.length === 0 && <p className="text-small text-muted">Bu dairede açık taksit planı yok.</p>}
      {open.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Açık taksit planları">
          {open.map((p) => {
            const next = installmentSummary(p.state.installments).next;
            const status = p.state.displayStatus;
            return (
              <li key={p.planId} className="flex flex-wrap items-center justify-between gap-2 text-small">
                <span>
                  {formatDate(p.date)} · kalan <strong className="tabular-nums">{formatTRY(p.state.remaining)}</strong>
                  {next ? ` · sıradaki ${next.no}. taksit ${formatDate(next.dueDate)}` : ''}
                </span>
                <span className="flex gap-1">
                  {status === 'active' && (p.state.inDefault || p.default) && <Badge tone="danger">Temerrüt</Badge>}
                  <Badge tone={PLAN_STATUS_TONES[status]}>{PLAN_STATUS_LABELS[status]}</Badge>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {open.length > 0 && <p className="text-xs text-muted">Açık planı olan caride taşınma kapaması yapılamaz; önce planı kapatın veya iptal edin.</p>}
    </div>
  );
}

/** Daire cari ayrintisi: tasinma kapama gecmisi + geri alma + yeni tasinma sihirbazi. */
export function UnitCariDialog({ row, names, startWithWizard, onClose, onInvite }: Props) {
  const { canWrite } = useFinancePermissions();
  const closures = useUnitClosures(row?.unit.unitId);
  const [mode, setMode] = useState<'history' | 'wizard'>('history');
  const [reversingId, setReversingId] = useState<string | null>(null);
  const [tool, setTool] = useState<'offset' | 'restructure' | null>(null);
  const restructureOn = useFeature('admin.debtRestructure');
  // Sihirbaz her acilista sifirdan baslasin (key).
  const [wizardRun, setWizardRun] = useState(0);

  useEffect(() => {
    if (!row) return;
    setMode(startWithWizard && canWrite ? 'wizard' : 'history');
    setReversingId(null);
    setWizardRun((n) => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [row?.unit.unitId, startWithWizard]);

  const title = row ? `Taşınma / cari · ${row.blockName} / ${row.unit.number}` : 'Taşınma / cari';
  const items = closures.data ?? [];

  return (
    <>
      <Dialog open={row !== null} onClose={onClose} title={title} className="max-w-2xl">
        {row && mode === 'wizard' && (
          <MoveOutWizard
            key={wizardRun}
            row={row}
            names={names}
            onCancel={() => setMode('history')}
            onDone={() => setMode('history')}
            onInvite={() => onInvite(row)}
          />
        )}

        {row && mode === 'history' && (
          <div className="flex flex-col gap-4">
            <UnitPlansSection unitId={row.unit.unitId} canWrite={canWrite} onOffset={() => setTool('offset')} onRestructure={() => setTool('restructure')} />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-small font-medium">
                <History className="size-4 text-muted" aria-hidden="true" />
                Kapama geçmişi
              </p>
              {canWrite && (
                <Button
                  size="sm"
                  onClick={() => {
                    setWizardRun((n) => n + 1);
                    setMode('wizard');
                  }}
                >
                  <LogOut className="size-4" aria-hidden="true" />
                  Taşınma kaydet
                </Button>
              )}
            </div>

            {closures.isPending && (
              <div role="status" aria-label="Kapama geçmişi yükleniyor" className="flex flex-col gap-2">
                <Skeleton className="h-20 w-full" />
                <Skeleton className="h-20 w-full" />
              </div>
            )}
            {closures.isError && <Alert tone="danger">{errorMessage(closures.error)}</Alert>}
            {closures.isSuccess && items.length === 0 && (
              <p className="py-6 text-center text-small text-muted">
                Bu dairede henüz taşınma / cari kapama yapılmamış. Kiracı çıktığında veya daire satıldığında “Taşınma kaydet” ile
                ayrılan kişinin borcunu ayrı bir cariye alın.
              </p>
            )}
            {items.length > 0 && (
              <ul className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                {items.map((c) => (
                  <ClosureCard
                    key={c.closureId}
                    c={c}
                    all={items}
                    names={names}
                    canWrite={canWrite}
                    reversing={reversingId === c.closureId}
                    onReverse={() => setReversingId(c.closureId)}
                    onReverseEnd={() => setReversingId(null)}
                  />
                ))}
              </ul>
            )}
            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose}>
                Kapat
              </Button>
            </div>
          </div>
        )}
      </Dialog>
      {canWrite && row && (
        <>
          <OffsetDialog open={tool === 'offset'} onClose={() => setTool(null)} preset={{ unitId: row.unit.unitId }} />
          {restructureOn && <RestructureWizard open={tool === 'restructure'} onClose={() => setTool(null)} preset={{ unitId: row.unit.unitId }} />}
        </>
      )}
    </>
  );
}
