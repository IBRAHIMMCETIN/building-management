import { ArrowLeft, Calculator, CheckCheck, FileDown, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, CardTitle, Dialog, FormField, Skeleton, Textarea } from '@/components/ui';
import {
  useApprovePeriod,
  useCalculatePeriod,
  useCancelPeriod,
  useCreateCorrection,
  useMeterPermissions,
  usePeriod,
  usePeriodJob,
  usePeriodLines,
  useRefreshAfterPosting,
  useReversePeriod,
} from '@/hooks/useMeters';
import { BulkJobProgress } from '@/components/BulkJobProgress';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { type CalculateResult, type DistributionLine, type MeterPeriod, blockersOf, isStaleCalc, metersApi } from '@/lib/api/meters';
import { errorMessage } from '@/lib/api/errors';
import { formatDateTime } from '@/lib/dates';
import { LIABLE_PARTY_LABELS, formatConsumption, isOpenPeriod } from '@/lib/meters/model';
import { formatTRY } from '@/lib/money';
import { PeriodSummary } from './PeriodsPanel';
import { ReadingSheetCard } from './ReadingSheetCard';
import { ReverseDialog } from './ReverseDialog';
import { useMeterUnits } from './useMeterUnits';

type UnitLabel = (unitId: string, fallback?: string) => string;

const WARNING_LABELS: Record<string, string> = {
  zero_consumption_fallback: 'Toplam tüketim sıfır: tutarın tamamı ortak anahtarla dağıtıldı.',
  legal_deviation: 'Şablon yönetmelik dışı oran kullanıyor (karar referansı kayıtlı).',
  estimated: 'Bazı sayaçlar tahmini (yönetici onaylı) okumayla hesaplandı.',
  spike: 'Bazı sayaçlarda tüketim geçmiş ortalamanın 3 katından fazla; okumaları kontrol edin.',
  rollover: 'Tur atan sayaç var; fark en büyük endeks üzerinden hesaplandı.',
  no_meter_common_only: 'Sayacı olmayan daireler yalnızca ortak pay öder.',
  no_meter_zero_charge: 'Sayacı olmayan ve ortak payı sıfır olan daireye tahakkuk yapılmaz.',
  meter_unit_out_of_scope: 'Kapsam dışı dairelerin sayaçları yok sayıldı.',
};
const warningText = (w: string | { code: string; message?: string }) =>
  typeof w === 'string' ? (WARNING_LABELS[w] ?? w) : (w.message ?? WARNING_LABELS[w.code] ?? w.code);

export function liabilityText(l: DistributionLine['liability']): string {
  if (l.kind === 'former') return 'Ayrılan cari';
  if (l.kind === 'split') return 'Paydaşlara bölünür';
  if (l.kind === 'none') return '—';
  return `${LIABLE_PARTY_LABELS[l.party].split(' ')[0]}${l.vacant ? ' (boş daire)' : ''}`;
}

/** Donem ayrintisi: okumalar -> hesap onizlemesi -> calcHash ile onay -> (gerekirse) toplu geri alma / duzeltilmis donem. */
export function PeriodDetail({ periodId, onBack, onOpen }: { periodId: string; onBack: () => void; onOpen: (periodId: string) => void }) {
  const period = usePeriod(periodId);
  const units = useMeterUnits();
  const unitLabel: UnitLabel = (unitId, fallback) => units.labelOf.get(unitId) ?? fallback ?? unitId;
  const p = period.data;
  const { canManage } = useMeterPermissions();
  const [deleting, setDeleting] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="size-4" aria-hidden="true" />
          Dönemler
        </Button>
        {/* UX-09: yalnizca deftere islenmemis (taslak / hesaplandi) donem silinir; onayli / geri alinan donemde kapali. */}
        {p && canManage && isOpenPeriod(p.status) && (
          <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
            <Trash2 className="size-4" aria-hidden="true" />
            Taslağı sil
          </Button>
        )}
      </div>
      {period.isError && <Alert tone="danger">{errorMessage(period.error)}</Alert>}
      {period.isPending && <Skeleton className="h-24" />}
      {p && (
        <>
          <Card>
            <PeriodSummary period={p} />
            {p.supersedesPeriodId && (
              <p className="mt-2 text-small">
                Geri alınan dönemin düzeltmesidir.{' '}
                <button type="button" className="text-accent underline-offset-4 hover:underline" onClick={() => onOpen(p.supersedesPeriodId as string)}>
                  Eski dönemi aç
                </button>
              </p>
            )}
          </Card>
          {isOpenPeriod(p.status) && (
            <>
              <ReadingSheetCard period={p} unitLabel={unitLabel} />
              <CalculationCard period={p} unitLabel={unitLabel} />
            </>
          )}
          {p.status === 'posting' && <ResumePostingCard period={p} />}
          {(p.status === 'posted' || p.status === 'reversing' || p.status === 'reversed') && <PostedCard period={p} unitLabel={unitLabel} onOpen={onOpen} />}
          {p.status === 'cancelled' && <Alert>Bu dönem iptal edildi.</Alert>}
          <DeleteDraftDialog period={deleting ? p : null} onClose={() => setDeleting(false)} onDeleted={onBack} />
        </>
      )}
    </div>
  );
}

/**
 * Taslak donemi siler (API: POST /periods/:id/cancel). Kayit fiziksel olarak silinmez; `cancelled`
 * olur, bagli faturalarin dagitim kilidi birakilir ve denetim kaydi gerekceyle yazilir. Iptal
 * edilen donem listede varsayilan olarak gizlenir.
 */
function DeleteDraftDialog({ period, onClose, onDeleted }: { period: MeterPeriod | null; onClose: () => void; onDeleted: () => void }) {
  const cancel = useCancelPeriod();
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const reasonError = reason.trim().length < 5 ? 'Gerekçe en az 5 karakter olmalı' : undefined;

  useEffect(() => {
    if (!period) return;
    setReason('');
    setTouched(false);
    cancel.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [period?.periodId]);

  const submit = async () => {
    setTouched(true);
    if (!period || reasonError) return;
    try {
      await cancel.mutateAsync({ periodId: period.periodId, version: period.version, reason: reason.trim() });
      onClose();
      onDeleted();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={!!period} onClose={() => !cancel.isPending && onClose()} title="Taslak dönemi sil" className="max-w-lg">
      {period && (
        <div className="flex flex-col gap-3">
          <p className="text-small">
            <strong>{period.name}</strong> taslağı silinecek. Girilen okumalar bu dönemle birlikte kullanılmaz olur; bağlı faturalar başka bir dönemde
            dağıtılabilir. Deftere yazılmış bir kayıt olmadığı için ters kayıt gerekmez.
          </p>
          <FormField label="Gerekçe" error={touched ? reasonError : undefined}>
            <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Dönem yanlış tarih aralığıyla açıldı" />
          </FormField>
          {cancel.isError && <Alert tone="danger">{errorMessage(cancel.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose} disabled={cancel.isPending}>
              Vazgeç
            </Button>
            <Button variant="danger" loading={cancel.isPending} onClick={() => void submit()}>
              <Trash2 className="size-4" aria-hidden="true" />
              Taslağı sil
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Hesap onizlemesi + onay (calcHash kilidi)
// ---------------------------------------------------------------------------

function CalculationCard({ period, unitLabel }: { period: MeterPeriod; unitLabel: UnitLabel }) {
  const { canManage } = useMeterPermissions();
  const calculate = useCalculatePeriod();
  const approve = useApprovePeriod();
  const [job, setJob] = usePeriodJob(period.periodId);
  const refresh = useRefreshAfterPosting();
  const [result, setResult] = useState<CalculateResult | null>(null);
  const [stale, setStale] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Okuma / tutar degisince donem surumu artar: eski onizleme gecersizdir.
  useEffect(() => {
    setResult((r) => (r?.ok && r.period.version === period.version ? r : null));
    setConfirming(false);
  }, [period.version]);

  async function runCalc() {
    setStale(false);
    setConfirming(false);
    approve.reset();
    try {
      setResult(await calculate.mutateAsync(period.periodId));
    } catch {
      setResult(null);
    }
  }

  async function runApprove(calcHash: string) {
    try {
      const r = await approve.mutateAsync({ periodId: period.periodId, calcHash });
      // Buyuk donem: arka plan isi (202). Ilerleme bu kartta / "tahakkuk suruyor" kartinda izlenir.
      if ('mode' in r && r.mode === 'job') {
        setJob(r.job);
        setConfirming(false);
        return;
      }
      setResult(null);
    } catch (err) {
      if (isStaleCalc(err)) {
        // Onizlemeden sonra veri degisti: kilit onayi reddetti, yeniden onizle.
        setStale(true);
        setResult(null);
        setConfirming(false);
      }
    }
  }

  if (!canManage) {
    return (
      <Card>
        <CardTitle>Hesap</CardTitle>
        <p className="mt-2 text-small text-muted">Hesap önizlemesi ve onay yöneticiye aittir.</p>
      </Card>
    );
  }

  const approveBlockers = blockersOf(approve.error);
  const lines = result?.ok ? result.lines : [];

  if (job) {
    return (
      <Card className="flex flex-col gap-4">
        <CardTitle>Tahakkuk yazılıyor</CardTitle>
        <BulkJobProgress job={job} onSettled={refresh} />
      </Card>
    );
  }

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Dağıtım hesabı</CardTitle>
        <Button variant="secondary" onClick={() => void runCalc()} loading={calculate.isPending}>
          <Calculator className="size-4" aria-hidden="true" />
          {result ? 'Yeniden hesapla' : 'Hesapla (önizleme)'}
        </Button>
      </div>
      <p className="text-small text-muted">Önizleme deftere yazmaz. Onay, önizlenen hesabın aynısıyla yapılır; arada okuma veya tutar değişirse onay reddedilir.</p>

      {stale && <Alert tone="danger">Önizlemeden sonra okumalar, şablon veya tutar değişti. Lütfen yeniden hesaplayıp kontrol edin.</Alert>}
      {calculate.isError && <Alert tone="danger">{errorMessage(calculate.error)}</Alert>}

      {result && !result.ok && (
        <Alert tone="danger">
          <p className="font-medium">Hesap yapılamadı:</p>
          <ul className="list-disc pl-4">
            {result.blockers.map((b) => (
              <li key={`${b.code}-${b.unitId ?? ''}-${b.meterId ?? ''}`}>
                {b.unitId ? `${unitLabel(b.unitId)}: ` : ''}
                {b.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}

      {result?.ok && (
        <>
          <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Toplam" value={formatTRY(result.totals.totalAmount)} />
            <Stat label="Ortak havuz" value={formatTRY(result.totals.commonPool)} />
            <Stat label="Tüketim havuzu" value={formatTRY(result.totals.consumptionPool)} />
            <Stat label="Toplam tüketim" value={formatConsumption(result.totals.totalConsumption)} />
          </dl>
          {result.totals.fallbackToCommon && <Alert>Toplam tüketim sıfır: tutarın tamamı ortak anahtarla dağıtıldı.</Alert>}
          {result.warnings.length > 0 && (
            <ul className="list-disc pl-5 text-small text-warning">
              {[...new Set(result.warnings.map(warningText))].map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <LinesTable lines={lines} unitLabel={unitLabel} />

          {approveBlockers.length > 0 && (
            <Alert tone="danger">
              <ul className="list-disc pl-4">
                {approveBlockers.map((b) => (
                  <li key={`${b.code}-${b.unitId ?? ''}`}>{b.message}</li>
                ))}
              </ul>
            </Alert>
          )}
          {approve.isError && !isStaleCalc(approve.error) && approveBlockers.length === 0 && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {confirming ? (
              <>
                <span className="text-small">
                  {lines.filter((l) => l.amount > 0).length} daireye toplam {formatTRY(result.totals.totalAmount)} tahakkuk edilecek. Emin misiniz?
                </span>
                <Button variant="secondary" onClick={() => setConfirming(false)} disabled={approve.isPending}>
                  Vazgeç
                </Button>
                <Button onClick={() => void runApprove(result.calcHash)} loading={approve.isPending}>
                  Onayla ve tahakkuk et
                </Button>
              </>
            ) : (
              <Button onClick={() => setConfirming(true)}>
                <CheckCheck className="size-4" aria-hidden="true" />
                Onayla
              </Button>
            )}
          </div>
        </>
      )}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-surface-muted p-3">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

function LinesTable({ lines, unitLabel, onStatement, pendingId }: { lines: DistributionLine[]; unitLabel: UnitLabel; onStatement?: (unitId: string) => void; pendingId?: string | null }) {
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-small" aria-label="Dağıtım cetveli">
        <thead>
          <tr className="text-left text-muted">
            <th className="py-1 pr-2">Daire</th>
            <th className="pr-2 text-right">Tüketim</th>
            <th className="pr-2 text-right">Ortak pay</th>
            <th className="pr-2 text-right">Tüketim payı</th>
            <th className="pr-2 text-right">Toplam</th>
            <th className="pr-2">Borçlu</th>
            {onStatement && <th />}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={`${l.unitId}-${l.liability.kind}-${l.liability.accountId ?? ''}`} className="border-t border-border">
              <td className="py-1.5 pr-2">
                {unitLabel(l.unitId, l.unitNumber)}
                {!l.hasMeter && <Badge className="ml-1">Sayaçsız</Badge>}
                {l.estimated && (
                  <Badge tone="accent" className="ml-1">
                    Tahmini
                  </Badge>
                )}
              </td>
              <td className="pr-2 text-right tabular-nums">{l.hasMeter ? formatConsumption(l.consumption) : '—'}</td>
              <td className="pr-2 text-right tabular-nums">{formatTRY(l.commonAmount)}</td>
              <td className="pr-2 text-right tabular-nums">{formatTRY(l.consumptionAmount)}</td>
              <td className="pr-2 text-right font-medium tabular-nums">{formatTRY(l.amount)}</td>
              <td className="pr-2">{liabilityText(l.liability)}</td>
              {onStatement && (
                <td className="text-right">
                  <Button size="xs" variant="ghost" aria-label="Döküm PDF" loading={pendingId === l.unitId} onClick={() => onStatement(l.unitId)}>
                    <FileDown className="size-3.5" aria-hidden="true" />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-border-strong font-semibold">
            <td className="py-1.5 pr-2">Toplam</td>
            <td />
            <td className="pr-2 text-right tabular-nums">{formatTRY(lines.reduce((s, l) => s + l.commonAmount, 0))}</td>
            <td className="pr-2 text-right tabular-nums">{formatTRY(lines.reduce((s, l) => s + l.consumptionAmount, 0))}</td>
            <td className="pr-2 text-right tabular-nums">{formatTRY(total)}</td>
            <td colSpan={onStatement ? 2 : 1} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Yarida kalan onay (posting): ayni calcHash ile kaldigi yerden devam
// ---------------------------------------------------------------------------

function ResumePostingCard({ period }: { period: MeterPeriod }) {
  const { canManage } = useMeterPermissions();
  const approve = useApprovePeriod();
  const [job, setJob] = usePeriodJob(period.periodId);
  const refresh = useRefreshAfterPosting();
  if (job) {
    return (
      <Card className="flex flex-col gap-3">
        <CardTitle>Tahakkuk yazılıyor</CardTitle>
        <BulkJobProgress job={job} onSettled={refresh} canRetry={canManage} />
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>Tahakkuk sürüyor</CardTitle>
      <p className="text-small text-muted">
        Onay {period.approvedAt ? formatDateTime(period.approvedAt) : ''} başlatıldı ancak tamamlanmadı (büyük site veya bağlantı kesintisi). Devam etmek
        mükerrer kayıt oluşturmaz.
      </p>
      {approve.isError && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}
      {canManage && period.calc && (
        <div>
          <Button
            onClick={() =>
              approve.mutate(
                { periodId: period.periodId, calcHash: period.calc?.hash ?? '' },
                // Buyuk donem: suren / yarida kalan is aynen doner, kaldigi yerden izlenir.
                { onSuccess: (r) => ('mode' in r && r.mode === 'job' ? setJob(r.job) : undefined) },
              )
            }
            loading={approve.isPending}
          >
            Onayı tamamla / ilerlemeyi göster
          </Button>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Onayli / geri alinan donem
// ---------------------------------------------------------------------------

function PostedCard({ period, unitLabel, onOpen }: { period: MeterPeriod; unitLabel: UnitLabel; onOpen: (periodId: string) => void }) {
  const { canManage, canRead } = useMeterPermissions();
  const lines = usePeriodLines(period.periodId, canRead);
  const docs = useOpenDocument();
  const resume = useReversePeriod();
  const correction = useCreateCorrection();
  const [reversing, setReversing] = useState(false);

  const openCorrection = async () => {
    try {
      const out = await correction.mutateAsync(period.periodId);
      onOpen('period' in out ? out.period.periodId : out.periodId);
    } catch {
      /* asagida */
    }
  };

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Dağıtım cetveli</CardTitle>
        {canManage && period.status === 'posted' && !period.supersededByPeriodId && (
          <Button variant="danger" size="sm" onClick={() => setReversing(true)}>
            <Undo2 className="size-4" aria-hidden="true" />
            Toplu geri al
          </Button>
        )}
      </div>

      {period.status === 'posted' && (
        <p className="text-small text-muted">
          {period.chargeCount ?? 0} tahakkuk {period.postedAt ? formatDateTime(period.postedAt) : ''} tarihinde deftere yazıldı.
        </p>
      )}

      {period.status === 'reversing' && period.reversal && (
        <Alert tone="danger">
          <p>Geri alma yarıda kaldı. Aynı işlemle kaldığı yerden devam edilir (mükerrer ters kayıt oluşmaz).</p>
          {canManage && (
            <Button
              className="mt-2"
              size="sm"
              loading={resume.isPending}
              onClick={() =>
                resume.mutate({ periodId: period.periodId, idempotencyKey: period.reversal?.key ?? '', reason: period.reversal?.reason ?? '', notify: period.reversal?.notify })
              }
            >
              Geri almayı tamamla
            </Button>
          )}
          {resume.isError && <p className="mt-2">{errorMessage(resume.error)}</p>}
        </Alert>
      )}

      {period.status === 'reversed' && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-muted/50 p-3 text-small">
          <p>
            Dönem {period.reversal?.completedAt ? formatDateTime(period.reversal.completedAt) : ''} geri alındı ({period.reversal?.reversedCount ?? 0} ters
            kayıt, {period.reversal?.notify ? 'sakinler bilgilendirildi' : 'sessiz'}). Gerekçe: {period.reversal?.reason}
          </p>
          {period.supersededByPeriodId ? (
            <div>
              <Button size="sm" variant="secondary" onClick={() => onOpen(period.supersededByPeriodId as string)}>
                Düzeltilmiş dönemi aç
              </Button>
            </div>
          ) : (
            canManage && (
              <div className="flex flex-col gap-1">
                <p className="text-muted">Düzeltilmiş dönem aynı şablon, tarih ve okumalarla taslak olarak açılır; hatalı okumayı düzeltip yeniden onaylayın.</p>
                <div>
                  <Button size="sm" onClick={() => void openCorrection()} loading={correction.isPending}>
                    <RotateCcw className="size-4" aria-hidden="true" />
                    Düzeltilmiş Dönem Aç
                  </Button>
                </div>
                {correction.isError && <p className="text-danger">{errorMessage(correction.error)}</p>}
              </div>
            )
          )}
        </div>
      )}

      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
      {lines.isPending && <Skeleton className="h-32" />}
      {lines.isError && <Alert tone="danger">{errorMessage(lines.error)}</Alert>}
      {lines.data && (
        <LinesTable
          lines={lines.data.lines}
          unitLabel={unitLabel}
          pendingId={docs.pendingId}
          onStatement={period.status === 'posted' ? (unitId) => void docs.open(unitId, () => metersApi.unitStatement(period.periodId, unitId)) : undefined}
        />
      )}

      <ReverseDialog period={reversing ? period : null} unitLabel={unitLabel} onClose={() => setReversing(false)} />
    </Card>
  );
}
