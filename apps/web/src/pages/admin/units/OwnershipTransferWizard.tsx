import { ArrowLeft, ArrowRight, CheckCircle2, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreateTransfer, useTransferPreview } from '@/hooks/useOwnership';
import { ApiError, errorMessage } from '@/lib/api/errors';
import { type OwnerRow, TRANSFER_DEBT_TARGETS, TRANSFER_KINDS, type TransferInput, type TransferPreview } from '@/lib/api/ownership';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { TRANSFER_KIND_HINTS, TRANSFER_KIND_LABELS, formatBps, formatShare, sharesToBps } from '@/lib/ownership/shares';
import { todayIstanbul } from '../finance/schemas';
import { reasonError } from './moveOut';
import {
  DEBT_TARGET_LABELS,
  MEMBERSHIP_CHANGE_LABELS,
  STEP_LABELS,
  WIZARD_STEPS,
  type WizardDraft,
  type WizardStep,
  buildTransferInput,
  draftForKind,
  enteringUsers,
  fillRecipient,
  initialDraft,
} from './ownershipWizard';

type Person = { userId: string; fullName: string };

type Props = {
  unitId: string;
  unitLabel: string;
  owners: OwnerRow[];
  /** Devralan olarak secilebilecek kisiler (apartmanin kayitli kisileri). */
  people: Person[];
  names: Map<string, string>;
  onCancel: () => void;
  onDone: () => void;
};

function Steps({ step }: { step: WizardStep }) {
  const index = step === 'done' ? WIZARD_STEPS.length : WIZARD_STEPS.indexOf(step);
  return (
    <ol className="flex gap-2 text-xs" aria-label="Adımlar">
      {WIZARD_STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={i === index ? 'step' : undefined}
          className={cn('rounded-full border px-2.5 py-1', i === index ? 'border-accent text-accent' : i < index ? 'border-success/30 text-success' : 'border-border text-muted')}
        >
          {i + 1}. {STEP_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

function ShareTable({ title, rows, names }: { title: string; rows: { userId: string; share: OwnerRow['share']; bps?: number }[]; names: Map<string, string> }) {
  const bps = rows.every((r) => r.bps !== undefined) ? rows.map((r) => r.bps as number) : sharesToBps(rows.map((r) => r.share));
  return (
    <div className="rounded-md border border-border">
      <table className="w-full text-left text-small">
        <caption className="px-3 py-1.5 text-left text-xs font-medium text-muted">{title}</caption>
        <tbody className="divide-y divide-border">
          {rows.map((r, i) => (
            <tr key={r.userId}>
              <td className="px-3 py-1.5">{names.get(r.userId) ?? 'Adı kayıtlı değil'}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{formatShare(r.share)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-muted">{formatBps(bps[i] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewBody({ p, names }: { p: TransferPreview; names: Map<string, string> }) {
  const name = (u: string) => names.get(u) ?? 'Adı kayıtlı değil';
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <ShareTable title="Devirden önce" rows={p.before} names={names} />
        <ShareTable title={`${formatDate(p.effectiveDate)} itibarıyla`} rows={p.after} names={names} />
      </div>
      {p.closures.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-small font-medium">Cari kapama</p>
          {p.closures.map((c) => (
            <div key={c.sourceAccountId} className="rounded-md bg-surface-muted px-3 py-2 text-small">
              <p>
                {c.userIds.map(name).join(', ')}: {formatDate(p.cutoff)} itibarıyla carisi kapanır.
              </p>
              <p className="text-muted">
                {c.debt > 0
                  ? `Devreden borç ${formatTRY(c.debt)} → ${c.target === 'new_owner' ? `yeni malik (${c.newOwnerUserId ? name(c.newOwnerUserId) : 'aynı cari'})` : 'ayrılan malik carisi'}`
                  : c.advance > 0
                    ? `Avans ${formatTRY(c.advance)} ayrılan malik carisine aktarılır`
                    : 'Bakiye yok; cari yalnızca kilitlenir'}
                {c.lateFee > 0 && ` · devir tarihine kadar tazminat ${formatTRY(c.lateFee)}`}
              </p>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-small text-muted">Cari hareketi yok: geçmiş borçlar mevcut carilerde kalır.</p>
      )}
      {p.membershipChanges.length > 0 && (
        <div className="text-small">
          <p className="font-medium">Üyelik değişiklikleri</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted">
            {p.membershipChanges.map((m) => (
              <li key={m.userId}>
                <span className="text-text">{name(m.userId)}</span>: {MEMBERSHIP_CHANGE_LABELS[m.change]}
              </li>
            ))}
          </ul>
        </div>
      )}
      {p.warnings.map((w) => (
        <Alert key={w}>{w === 'temsilci yok' ? 'Paylı mülkiyette temsilci seçilmemiş (temsilci yok).' : w}</Alert>
      ))}
    </div>
  );
}

/** Mulk / hisse devri sihirbazi: tur ve pay hareketleri -> onizleme -> gerekce ve onay. */
export function OwnershipTransferWizard({ unitId, unitLabel, owners, people, names, onCancel, onDone }: Props) {
  const today = todayIstanbul();
  const [step, setStep] = useState<WizardStep>('moves');
  const [draft, setDraft] = useState<WizardDraft>(() => initialDraft(today));
  const [buyer, setBuyer] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const create = useCreateTransfer();

  const built = useMemo(() => buildTransferInput(draft, owners, today), [draft, owners, today]);
  const input: TransferInput | null = step === 'preview' || step === 'confirm' ? ('input' in built ? built.input : null) : null;
  const preview = useTransferPreview(unitId, input);
  const entering = enteringUsers(draft, owners);
  const name = (u: string) => names.get(u) ?? 'Adı kayıtlı değil';
  const setMove = (i: number, patch: Partial<WizardDraft['moves'][number]>) =>
    setDraft((d) => ({ ...d, moves: d.moves.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));

  const submit = async () => {
    setTouched(true);
    if (reasonError(reason) || !('input' in built)) return;
    try {
      await create.mutateAsync({ unitId, input: { ...built.input, idempotencyKey, reason: reason.trim() } });
      setStep('done');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'idempotency_conflict') renewKey();
    }
  };

  if (step === 'done') {
    return (
      <div className="flex flex-col items-center gap-3 py-6 text-center">
        <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
        <p className="font-semibold">Devir kaydedildi</p>
        <p className="text-small text-muted">{unitLabel} mülkiyet sicili, üyelikler ve gerekli cari kapamalar tek işlemde güncellendi.</p>
        {(create.data?.warnings ?? []).map((w) => (
          <Alert key={w}>{w}</Alert>
        ))}
        <Button onClick={onDone}>Mülkiyete dön</Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Steps step={step} />

      {step === 'moves' && (
        <>
          <fieldset className="flex flex-col gap-2">
            <legend className="text-small font-medium">Devir türü</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {TRANSFER_KINDS.map((k) => (
                <label
                  key={k}
                  className={cn('flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-small', draft.kind === k ? 'border-accent bg-accent/5' : 'border-border')}
                >
                  <span className="flex items-center gap-2 font-medium">
                    <input type="radio" name="kind" checked={draft.kind === k} onChange={() => setDraft((d) => draftForKind(d, k, owners))} />
                    {TRANSFER_KIND_LABELS[k]}
                  </span>
                  <span className="text-xs text-muted">{TRANSFER_KIND_HINTS[k]}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <FormField label="Devir tarihi (yeni malikin ilk günü)">
            <Input type="date" max={today} value={draft.effectiveDate} onChange={(e) => setDraft((d) => ({ ...d, effectiveDate: e.target.value }))} />
          </FormField>

          {draft.kind !== 'share_partial' && (
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-48 flex-1">
                <FormField label={draft.kind === 'sale_full' ? 'Alıcı (tüm paylar)' : 'Mirasçı (tüm paylar)'}>
                  <Select value={buyer} onChange={(e) => setBuyer(e.target.value)}>
                    <option value="">Kişi seçin</option>
                    {people.map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.fullName}
                      </option>
                    ))}
                  </Select>
                </FormField>
              </div>
              <Button variant="secondary" size="sm" disabled={!buyer} onClick={() => setDraft((d) => fillRecipient(d, buyer))}>
                Boş devralanlara uygula
              </Button>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <p className="text-small font-medium">Pay hareketleri</p>
            {draft.moves.map((m, i) => (
              <div key={i} className="grid grid-cols-1 gap-2 rounded-md border border-border p-2 sm:grid-cols-[1fr_1fr_7rem_auto] sm:items-end">
                <FormField label="Devreden">
                  <Select value={m.fromUserId} onChange={(e) => setMove(i, { fromUserId: e.target.value })}>
                    <option value="">Seçin</option>
                    {owners.map((o) => (
                      <option key={o.userId} value={o.userId}>
                        {name(o.userId)} ({formatShare(o.share)})
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Devralan">
                  <Select value={m.toUserId} onChange={(e) => setMove(i, { toUserId: e.target.value })}>
                    <option value="">Seçin</option>
                    {people.map((p) => (
                      <option key={p.userId} value={p.userId}>
                        {p.fullName}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Pay">
                  <Input inputMode="numeric" placeholder="1/4" value={m.share} onChange={(e) => setMove(i, { share: e.target.value })} />
                </FormField>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`${i + 1}. hareketi sil`}
                  disabled={draft.moves.length === 1}
                  onClick={() => setDraft((d) => ({ ...d, moves: d.moves.filter((_, j) => j !== i) }))}
                >
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            ))}
            <div>
              <Button variant="ghost" size="sm" onClick={() => setDraft((d) => ({ ...d, moves: [...d.moves, { fromUserId: '', toUserId: '', share: '' }] }))}>
                <Plus className="size-4" aria-hidden="true" />
                Hareket ekle
              </Button>
            </div>
            <p className="text-xs text-muted">Pay, bağımsız bölümün tamamına göre kesirdir (örn. 1/2 paydaş payının yarısını devrediyorsa 1/4). Listede olmayan kişiyi önce Daireler ekranından davet edin.</p>
          </div>

          {entering.length > 0 && (
            <fieldset className="flex flex-col gap-1 text-small">
              <legend className="font-medium">Yeni malikler dairede oturacak mı?</legend>
              {entering.map((u) => (
                <label key={u} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.residents.includes(u)}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, residents: e.target.checked ? [...d.residents, u] : d.residents.filter((x) => x !== u) }))
                    }
                  />
                  {name(u)}
                </label>
              ))}
            </fieldset>
          )}

          <fieldset className="flex flex-col gap-1 text-small">
            <legend className="font-medium">Çıkan malikin geçmiş borcu</legend>
            {TRANSFER_DEBT_TARGETS.map((t) => (
              <label key={t} className="flex items-start gap-2">
                <input type="radio" name="debtTo" className="mt-1" checked={draft.debtTo === t} onChange={() => setDraft((d) => ({ ...d, debtTo: t }))} />
                {DEBT_TARGET_LABELS[t]}
              </label>
            ))}
          </fieldset>

          {'error' in built ? (
            <Alert tone="danger">{built.error}</Alert>
          ) : (
            <ShareTable title="Devirden sonra (taslak)" rows={built.after} names={names} />
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onCancel}>
              Vazgeç
            </Button>
            <Button disabled={'error' in built} onClick={() => setStep('preview')}>
              Önizle
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </>
      )}

      {(step === 'preview' || step === 'confirm') && (
        <>
          {preview.isPending && (
            <div role="status" aria-label="Önizleme yükleniyor" className="flex flex-col gap-2">
              <Skeleton className="h-24 w-full" />
            </div>
          )}
          {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
          {preview.data && <PreviewBody p={preview.data} names={names} />}

          {step === 'confirm' && (
            <>
              <p className="text-small">
                <Badge tone="accent">{TRANSFER_KIND_LABELS[draft.kind]}</Badge> {formatDate(draft.effectiveDate)} tarihli devir tek işlemde kaydedilir; gerekirse
                daha sonra “Geri al” ile iptal edilebilir.
              </p>
              {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
              <FormField label="Gerekçe" error={touched ? reasonError(reason) : undefined}>
                <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Tapu satışı, 12.11.2026" />
              </FormField>
            </>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            <Button variant="ghost" onClick={() => setStep(step === 'confirm' ? 'preview' : 'moves')} disabled={create.isPending}>
              <ArrowLeft className="size-4" aria-hidden="true" />
              Geri
            </Button>
            {step === 'preview' ? (
              <Button disabled={!preview.data} onClick={() => setStep('confirm')}>
                Devam
                <ArrowRight className="size-4" aria-hidden="true" />
              </Button>
            ) : (
              <Button loading={create.isPending} onClick={() => void submit()}>
                Devri kaydet
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
