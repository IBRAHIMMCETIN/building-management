import { PARTY_LABELS, PLAN_REQUEST_STATUS_LABELS, PLAN_REQUEST_STATUS_TONES } from '@bm/shared/api/planRequests';
import { Check, Pencil, Settings2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Alert, Badge, Button, Card, FormField, Input, Skeleton, Textarea } from '@/components/ui';
import {
  useApprovePlanRequest,
  usePlanPreview,
  usePlanRequestDetail,
  usePlanRequestSettings,
  usePlanRequests,
  useRejectPlanRequest,
  useSavePlanRequestSettings,
} from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import type { PlanInput, PlanRequest } from '@/lib/api/restructure';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { DEFAULT_RULE, MAX_INSTALLMENTS, reasonError } from '@/lib/restructure/model';

type NameOf = (accountId: string) => string;

/** Onay formu: degisiklik yoksa "olduğu gibi" (API varsayilanlari), varsa yalnizca degisen alanlar gonderilir. */
export function approvalInput(
  asIs: { installments: number; firstDueDate: string; includeLateFees: boolean },
  draft: { installments: number; firstDueDate: string; includeLateFees: boolean; reason: string },
) {
  return {
    ...(draft.installments !== asIs.installments ? { installments: draft.installments } : {}),
    ...(draft.firstDueDate !== asIs.firstDueDate ? { firstDueDate: draft.firstDueDate } : {}),
    ...(draft.includeLateFees !== asIs.includeLateFees ? { includeLateFees: draft.includeLateFees } : {}),
    ...(draft.reason.trim() ? { reason: draft.reason.trim() } : {}),
  };
}

function ApprovePanel({ r, editing, onDone }: { r: PlanRequest; editing: boolean; onDone: () => void }) {
  const detail = usePlanRequestDetail(r.requestId);
  const approve = useApprovePlanRequest();
  const asIs = detail.data?.asIs;
  const [installments, setInstallments] = useState(r.installments);
  const [firstDueDate, setFirstDueDate] = useState('');
  const [includeLateFees, setIncludeLateFees] = useState(true);
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!asIs) return;
    setInstallments(asIs.installments);
    setFirstDueDate(asIs.firstDueDate);
    setIncludeLateFees(asIs.includeLateFees);
  }, [asIs]);

  // Yonetim sinirlari (API de uygular): en fazla taksit ve en dusuk taksit tutari.
  const maxAllowed = Math.min(MAX_INSTALLMENTS, detail.data?.limits?.maxInstallments ?? MAX_INSTALLMENTS);
  const installmentsError =
    !Number.isInteger(installments) || installments < 1 ? 'En az 1 taksit olmalı' : installments > maxAllowed ? `Talep sınırlarına göre en fazla ${maxAllowed} taksit` : undefined;
  const drift = detail.data?.drift;
  const preview: PlanInput | null =
    asIs && asIs.chargeIds.length > 0 && !installmentsError && /^\d{4}-\d{2}-\d{2}$/.test(firstDueDate)
      ? { accountId: asIs.accountId, chargeIds: asIs.chargeIds, installments, firstDueDate, includeLateFees, rule: DEFAULT_RULE }
      : null;
  const pv = usePlanPreview(preview);

  if (detail.isPending) return <Skeleton className="h-20 w-full" />;
  if (detail.isError) return <Alert tone="danger">{errorMessage(detail.error)}</Alert>;
  if (!asIs) return <Alert tone="info">Talep artık beklemede değil; listeyi yenileyin.</Alert>;
  const noItems = asIs.chargeIds.length === 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {noItems && <Alert tone="info">Talepteki gecikmiş kalemler kapanmış (borç ödenmiş olabilir). Talebi reddedebilirsiniz.</Alert>}
      {drift?.changed && !noItems && (
        <Alert tone="info">
          {`Borç talepten sonra değişti (talepte gecikmiş ${formatTRY(drift.overdueThen)}, şimdi talepteki kalemlerde ${formatTRY(drift.asIsOverdue)}${drift.newItems > 0 ? `; ${drift.newItems} yeni geciken kalem plana alınmaz` : ''}). Onay "değiştirerek" kaydedilir.`}
        </Alert>
      )}
      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Taksit sayısı" error={installmentsError} hint={`İstenen: ${r.installments} · en fazla ${maxAllowed}`}>
            <Input type="number" min={1} max={MAX_INSTALLMENTS} value={installments} onChange={(e) => setInstallments(Number(e.target.value))} />
          </FormField>
          <FormField label="İlk taksit vadesi">
            <Input type="date" value={firstDueDate} onChange={(e) => setFirstDueDate(e.target.value)} />
          </FormField>
          <label className="flex items-start gap-2 sm:col-span-2">
            <input type="checkbox" className="mt-1" checked={includeLateFees} onChange={(e) => setIncludeLateFees(e.target.checked)} />
            Bugüne kadar işleyen (dondurulan) gecikme tazminatı taksitlere dahil edilsin
          </label>
        </div>
      ) : (
        <p className="text-muted">
          {asIs.installments} taksit · ilk taksit {formatDate(asIs.firstDueDate)} · {asIs.chargeIds.length} gecikmiş kalem
          {asIs.includeLateFees ? ' · işleyen tazminat taksitlere dahil' : ''}
        </p>
      )}
      {pv.data && (
        <p>
          Plan toplamı <strong className="tabular-nums">{formatTRY(pv.data.total)}</strong> · aylık{' '}
          <span className="tabular-nums">{formatTRY(pv.data.installments[0]?.amount ?? 0)}</span>
          {pv.data.frozenLateFee > 0 ? ` · dondurulan tazminat ${formatTRY(pv.data.frozenLateFee)}` : ''}
        </p>
      )}
      {pv.isError && <Alert tone="danger">{errorMessage(pv.error)}</Alert>}
      <Input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="Gerekçe (isteğe bağlı)" aria-label="Onay gerekçesi" />
      {approve.isError && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone} disabled={approve.isPending}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          loading={approve.isPending}
          disabled={noItems || !!installmentsError || pv.isError}
          onClick={async () => {
            try {
              await approve.mutateAsync({ requestId: r.requestId, input: approvalInput(asIs, { installments, firstDueDate, includeLateFees, reason }) });
              onDone();
            } catch {
              // yukarida gosterilir
            }
          }}
        >
          {editing ? 'Değiştirerek onayla' : 'Planı oluştur'}
        </Button>
      </div>
    </div>
  );
}

function RejectPanel({ r, onDone }: { r: PlanRequest; onDone: () => void }) {
  const reject = useRejectPlanRequest();
  const [reason, setReason] = useState('');
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <FormField label="Ret gerekçesi (sakine gösterilir)" error={reason && reasonError(reason) ? reasonError(reason) : undefined}>
        <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {reject.isError && <Alert tone="danger">{errorMessage(reject.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Vazgeç
        </Button>
        <Button
          size="sm"
          variant="danger"
          loading={reject.isPending}
          disabled={!!reasonError(reason)}
          onClick={async () => {
            try {
              await reject.mutateAsync({ requestId: r.requestId, reason: reason.trim() });
              onDone();
            } catch {
              // yukarida gosterilir
            }
          }}
        >
          Talebi reddet
        </Button>
      </div>
    </div>
  );
}

function PlanRequestRow({ r, canWrite, nameOf }: { r: PlanRequest; canWrite: boolean; nameOf: NameOf }) {
  const [mode, setMode] = useState<'approve' | 'change' | 'reject' | null>(null);
  return (
    <li className="flex flex-col gap-2 px-3 py-3 text-small">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-medium">
            {nameOf(r.accountId)} <span className="text-muted">· {PARTY_LABELS[r.liableParty]}</span>
          </p>
          <p className="text-muted">
            {r.installments} taksit istendi · yaklaşık {formatTRY(r.estimate.total)} (gecikmiş {formatTRY(r.estimate.overdue)}) · {formatDateTime(r.createdAt)}
            {r.note ? ` · “${r.note}”` : ''}
          </p>
        </div>
        {canWrite && !mode && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => setMode('approve')}>
              <Check className="size-4" aria-hidden="true" />
              Olduğu gibi onayla
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setMode('change')}>
              <Pencil className="size-4" aria-hidden="true" />
              Değiştir
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('reject')}>
              <X className="size-4" aria-hidden="true" />
              Reddet
            </Button>
          </div>
        )}
      </div>
      {(mode === 'approve' || mode === 'change') && <ApprovePanel r={r} editing={mode === 'change'} onDone={() => setMode(null)} />}
      {mode === 'reject' && <RejectPanel r={r} onDone={() => setMode(null)} />}
    </li>
  );
}

/** Yonetimin sakin talep sinirlari (en fazla taksit, en dusuk taksit, tazminatin dahil olmasi). */
function PlanRequestSettingsForm({ onDone }: { onDone: () => void }) {
  const settings = usePlanRequestSettings();
  const save = useSavePlanRequestSettings();
  const s = settings.data?.settings;
  const [enabled, setEnabled] = useState(true);
  const [max, setMax] = useState(6);
  const [minText, setMinText] = useState('');
  const [includeLateFees, setIncludeLateFees] = useState(true);
  useEffect(() => {
    if (!s) return;
    setEnabled(s.enabled);
    setMax(s.maxInstallments);
    setMinText(kurusToInput(s.minInstallmentAmount));
    setIncludeLateFees(s.includeLateFees);
  }, [s]);
  if (settings.isPending) return <Skeleton className="h-24 w-full" />;
  if (settings.isError || !settings.data) return <Alert tone="danger">{errorMessage(settings.error)}</Alert>;
  const min = parseTRYToKurus(minText);
  const maxError = !Number.isInteger(max) || max < 2 || max > MAX_INSTALLMENTS ? `2-${MAX_INSTALLMENTS} arası olmalı` : undefined;
  const minError = min === null || min < 100 ? 'En az 1,00 ₺ olmalı' : undefined;
  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3 text-small">
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Sakinler Borçlarım ekranından taksit talebi gönderebilsin
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="En fazla taksit" error={maxError}>
          <Input type="number" min={2} max={MAX_INSTALLMENTS} value={max} onChange={(e) => setMax(Number(e.target.value))} />
        </FormField>
        <FormField label="En düşük taksit tutarı (₺)" error={minError}>
          <Input inputMode="decimal" value={minText} onChange={(e) => setMinText(e.target.value)} />
        </FormField>
      </div>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-1" checked={includeLateFees} onChange={(e) => setIncludeLateFees(e.target.checked)} />
        Yapılandırmada dondurulan gecikme tazminatı taksitlere dahil edilsin (kapalıysa ayrı borç olarak kalır)
      </label>
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          Kapat
        </Button>
        <Button
          size="sm"
          loading={save.isPending}
          disabled={!!maxError || !!minError}
          onClick={async () => {
            if (min === null) return;
            try {
              await save.mutateAsync({ version: settings.data.version, enabled, maxInstallments: max, minInstallmentAmount: min, includeLateFees });
              onDone();
            } catch {
              // yukarida gosterilir
            }
          }}
        >
          Kaydet
        </Button>
      </div>
    </div>
  );
}

/**
 * Finans 2.2 sonrasi - "Taksit planlari" sekmesinin ustunde sakin yapilandirma talepleri kuyrugu
 * (olduğu gibi / degistirerek onay, gerekceli ret) ve talep sinirlari. KVKK: yalnizca yonetim.
 */
export function PlanRequestsSection({ canWrite, nameOf }: { canWrite: boolean; nameOf: NameOf }) {
  // Bekleyenler cari basliklarindan (tum talepler taranmaz); son kararlar sinirli liste.
  const requests = usePlanRequests('pending');
  const latest = usePlanRequests(undefined, 10);
  const settings = usePlanRequestSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  if (!canWrite) return null;
  const pending = requests.data?.items ?? [];
  const recent = (latest.data?.items ?? []).filter((r) => r.status !== 'pending').slice(0, 5);
  const closed = settings.data && !settings.data.settings.enabled;

  return (
    <Card className="p-0">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-small font-semibold">Sakin taksit talepleri{pending.length > 0 ? ` (${pending.length} bekliyor)` : ''}</p>
        <Button size="xs" variant="ghost" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
          <Settings2 className="size-3.5" aria-hidden="true" />
          Talep sınırları
        </Button>
      </div>
      {settingsOpen && <PlanRequestSettingsForm onDone={() => setSettingsOpen(false)} />}
      {closed && !settingsOpen && (
        <p className="border-b border-border px-3 py-2 text-small text-muted">Sakinler şu anda taksit talebi gönderemez. Açmak için “Talep sınırları”nı kullanın.</p>
      )}
      {requests.isPending && (
        <div role="status" aria-label="Talepler yükleniyor" className="p-3">
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {requests.isError && (
        <div className="p-3">
          <Alert tone="danger">{errorMessage(requests.error)}</Alert>
        </div>
      )}
      {requests.isSuccess && pending.length === 0 && <p className="px-3 py-3 text-small text-muted">Bekleyen taksit talebi yok.</p>}
      {pending.length > 0 && (
        <ul className="divide-y divide-border" aria-label="Bekleyen taksit talepleri">
          {pending.map((r) => (
            <PlanRequestRow key={r.requestId} r={r} canWrite={canWrite} nameOf={nameOf} />
          ))}
        </ul>
      )}
      {recent.length > 0 && (
        <ul className="divide-y divide-border border-t border-border text-small" aria-label="Sonuçlanan taksit talepleri">
          {recent.map((r) => (
            <li key={r.requestId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {nameOf(r.accountId)} · {r.decision?.installments ?? r.installments} taksit
                <span className="block text-xs text-muted">
                  {formatDateTime(r.decision?.at ?? r.updatedAt)}
                  {r.decision?.mode === 'changed' ? ' · değiştirerek onaylandı' : ''}
                  {r.status === 'rejected' && r.decision ? ` · ${r.decision.reason}` : ''}
                </span>
              </span>
              <Badge tone={PLAN_REQUEST_STATUS_TONES[r.status]}>{PLAN_REQUEST_STATUS_LABELS[r.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
