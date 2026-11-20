import { ArrowLeft, ArrowRight, CheckCircle2, UserPlus, Wallet } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Alert, Badge, Button, FormField, Input, Select, Skeleton, Textarea } from '@/components/ui';
import { useClosurePreview, useCreateClosure } from '@/hooks/useClosures';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import type { CariClosure, ClosurePreview } from '@/lib/api/closures';
import { ApiError, errorMessage } from '@/lib/api/errors';
import type { LiableParty } from '@/lib/api/finance';
import { cn } from '@/lib/cn';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { todayIstanbul } from '../finance/schemas';
import {
  CLOSURE_PARTY_LABELS,
  DEBT_TARGET_HINTS,
  type Decision,
  MEMBERSHIP_CHANGE_LABELS,
  STEP_LABELS,
  WIZARD_STEPS,
  type WizardStep,
  advanceTargetLabel,
  blockingReason,
  buildCreateInput,
  debtTargetLabel,
  decisionErrors,
  defaultDecision,
  outcomeText,
  reasonError,
} from './moveOut';
import type { UnitRow } from './unitRows';

type Props = {
  row: UnitRow;
  names: Map<string, string>;
  onCancel: () => void;
  onInvite: () => void;
  onDone: () => void;
};

const choiceClass = cn(
  'flex cursor-pointer items-start gap-2 rounded-md border border-border px-3 py-2',
  'has-checked:border-accent has-checked:bg-accent/10',
  'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent',
);

function Stepper({ step }: { step: WizardStep }) {
  const at = WIZARD_STEPS.indexOf(step);
  return (
    <ol className="flex gap-1 text-xs" aria-label="Adımlar">
      {WIZARD_STEPS.map((s, i) => (
        <li
          key={s}
          aria-current={i === at ? 'step' : undefined}
          className={cn('flex-1 border-t-2 pt-1', i <= at ? 'border-accent text-accent' : 'border-border text-muted', i === at && 'font-semibold')}
        >
          {i + 1}. {STEP_LABELS[s]}
        </li>
      ))}
    </ol>
  );
}

function Amount({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'success' }) {
  return (
    <div className="flex flex-col rounded-md bg-surface-muted px-3 py-2">
      <span className="text-xs text-muted">{label}</span>
      <span className={cn('font-semibold tabular-nums', tone === 'danger' && 'text-danger', tone === 'success' && 'text-success')}>{formatTRY(value)}</span>
    </div>
  );
}

function PreviewBody({ p, names }: { p: ClosurePreview; names: Map<string, string> }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2">
        <Amount label="Çıkışa kadar tazminat" value={p.lateFee} />
        <Amount label="Devreden borç" value={p.debt} tone={p.debt > 0 ? 'danger' : undefined} />
        <Amount label="Devreden avans" value={p.advance} tone={p.advance > 0 ? 'success' : undefined} />
      </div>

      {p.items.length > 0 && (
        <div className="max-h-48 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-left text-small">
            <caption className="sr-only">Devredilecek açık kalemler</caption>
            <thead className="bg-surface-muted/50 text-xs text-muted">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">Kalem</th>
                <th scope="col" className="px-3 py-1.5 font-medium">Vade</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">Kalan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {p.items.map((it) => (
                <tr key={it.sourceChargeId}>
                  <td className="px-3 py-1.5">
                    {it.description}
                    {it.category === 'late_fee' && (
                      <Badge tone="warning" className="ml-1">
                        tazminat
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-1.5 whitespace-nowrap text-muted">{formatDate(it.dueDate)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{formatTRY(it.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {p.memberships.length > 0 ? (
        <div className="text-small">
          <p className="font-medium">Üyelik değişiklikleri</p>
          <ul className="mt-1 flex flex-col gap-0.5 text-muted">
            {p.memberships.map((m) => (
              <li key={m.userId}>
                <span className="text-text">{names.get(m.userId) ?? 'Adı kayıtlı değil'}</span> ({m.relation === 'owner' ? 'malik' : 'kiracı'}):{' '}
                {MEMBERSHIP_CHANGE_LABELS[m.change]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {p.warnings.map((w) => (
        <Alert key={w}>
          {w}
        </Alert>
      ))}
    </div>
  );
}

/**
 * Tasinma / cari kapama sihirbazi. Onizleme her zaman API'den gelir (defter mantigi istemcide
 * tekrarlanmaz); kayit tek atomik istektir ve idempotency anahtari sihirbaz boyunca sabittir.
 */
export function MoveOutWizard({ row, names, onCancel, onInvite, onDone }: Props) {
  const [step, setStep] = useState<WizardStep>('who');
  const [party, setParty] = useState<LiableParty>(row.tenants.length > 0 || row.owners.length === 0 ? 'occupant' : 'owner');
  const [moveOutDate, setMoveOutDate] = useState(todayIstanbul());
  const [query, setQuery] = useState<{ party: LiableParty; moveOutDate: string } | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [done, setDone] = useState<{ closure: CariClosure; replayed: boolean } | null>(null);

  const preview = useClosurePreview(row.unit.unitId, query);
  const accounts = useFinanceAccounts();
  const create = useCreateClosure();
  const [idempotencyKey, renewKey] = useIdempotencyKey();
  const funds = useMemo(() => (accounts.data ?? []).filter((a) => a.type === 'cash' || a.type === 'bank'), [accounts.data]);

  const p = preview.data;
  // Yeni onizleme geldiginde varsayilan karar; tarih/taraf degisirse yeni bir islemdir.
  const pKey = p ? `${p.party}|${p.moveOutDate}` : '';
  useEffect(() => {
    if (!p) return;
    setDecision(defaultDecision(p));
    renewKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca taraf/tarih degisince
  }, [pKey]);

  const dateError = !moveOutDate ? 'Çıkış tarihi seçin.' : moveOutDate > todayIstanbul() ? 'Çıkış tarihi bugünden sonra olamaz.' : undefined;
  const blocked = p ? blockingReason(p) : undefined;
  const dErrors = p && decision ? decisionErrors(p, decision) : {};
  const rError = decision ? reasonError(decision.reason) : undefined;
  const set = (patch: Partial<Decision>) => setDecision((d) => (d ? { ...d, ...patch } : d));

  const goPreview = () => {
    setShowErrors(true);
    if (dateError) return;
    setShowErrors(false);
    setQuery({ party, moveOutDate });
    setStep('preview');
  };
  const goConfirm = () => {
    setShowErrors(true);
    if (Object.keys(dErrors).length) return;
    setShowErrors(false);
    setStep('confirm');
  };
  const submit = async () => {
    setShowErrors(true);
    if (!p || !decision || rError) return;
    try {
      const result = await create.mutateAsync({ unitId: row.unit.unitId, input: buildCreateInput(p, decision, idempotencyKey) });
      setDone(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'idempotency_conflict') renewKey();
    }
  };

  if (done) {
    const c = done.closure;
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center">
        <CheckCircle2 className="size-10 text-success" aria-hidden="true" />
        <p className="font-semibold">Cari {formatDate(c.moveOutDate)} itibarıyla kapatıldı</p>
        <p className="text-small text-muted">
          {outcomeText(c, formatTRY)}
          {done.replayed && ' (bu kapama daha önce kaydedilmişti, tekrar yazılmadı)'}
        </p>
        {c.debt > 0 && c.debtTo === 'former' && (
          <p className="text-small text-muted">
            Tahsilatı{' '}
            <Link to="/admin/finance?tab=former" className="text-accent underline">
              Finans › Ayrılan cariler
            </Link>{' '}
            ekranından alabilirsiniz.
          </p>
        )}
        <div className="flex w-full flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-center">
          <Button variant="secondary" onClick={onDone}>
            Kapama geçmişine dön
          </Button>
          <Button onClick={onInvite}>
            <UserPlus className="size-4" aria-hidden="true" />
            Yeni sakin davet et
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Stepper step={step} />

      {step === 'who' && (
        <>
          <fieldset>
            <legend className="mb-1.5 text-small font-medium">Hangi cari kapanıyor?</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(['occupant', 'owner'] as const).map((v) => (
                <label key={v} className={choiceClass}>
                  <input type="radio" name="party" className="sr-only" checked={party === v} onChange={() => setParty(v)} />
                  <span className="flex flex-col">
                    <span className="text-small font-medium">{CLOSURE_PARTY_LABELS[v]}</span>
                    <span className="text-xs text-muted">
                      {v === 'occupant' ? 'Kiracı taşınıyor / oturan malik evi boşaltıyor' : 'Daire satıldı; malik değişiyor'}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <FormField label="Çıkış (devir) tarihi" error={showErrors ? dateError : undefined} hint="Bu tarih dahil önceki tüm hareketler ayrılan kişiye aittir.">
            <Input type="date" max={todayIstanbul()} value={moveOutDate} onChange={(e) => setMoveOutDate(e.target.value)} />
          </FormField>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="ghost" onClick={onCancel}>
              Vazgeç
            </Button>
            <Button onClick={goPreview}>
              Önizle
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </>
      )}

      {step !== 'who' && preview.isPending && (
        <div role="status" aria-label="Önizleme hesaplanıyor" className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {step !== 'who' && preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}

      {step === 'preview' && p && decision && (
        <>
          <p className="text-small text-muted">
            {CLOSURE_PARTY_LABELS[p.party]} · çıkış {formatDate(p.moveOutDate)}
          </p>
          {p.memberships.length > 1 && (
            <fieldset>
              <legend className="mb-1 text-small font-medium">Ayrılan kişiler</legend>
              <div className="flex flex-col gap-1">
                {p.memberships.map((m) => (
                  <label key={m.userId} className="flex items-center gap-2 text-small">
                    <input
                      type="checkbox"
                      checked={decision.userIds.includes(m.userId)}
                      onChange={(e) =>
                        set({ userIds: e.target.checked ? [...decision.userIds, m.userId] : decision.userIds.filter((u) => u !== m.userId) })
                      }
                    />
                    {names.get(m.userId) ?? 'Adı kayıtlı değil'}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <PreviewBody p={p} names={names} />
          {blocked && <Alert tone="danger">{blocked}</Alert>}
        </>
      )}

      {step === 'decision' && p && decision && (
        <>
          {p.debt === 0 && p.advance === 0 && <Alert>Devredilecek borç veya avans yok; yalnızca cari kesilir ve üyelikler güncellenir.</Alert>}
          {p.debt > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-small font-medium">{formatTRY(p.debt)} borç nereye gitsin?</legend>
              <div className="flex flex-col gap-2">
                {p.targets.debt.map((t) => (
                  <label key={t} className={choiceClass}>
                    <input type="radio" name="debtTo" className="mt-1" checked={decision.debtTo === t} onChange={() => set({ debtTo: t })} />
                    <span className="flex flex-col">
                      <span className="text-small font-medium">{debtTargetLabel(p.party, t)}</span>
                      <span className="text-xs text-muted">{DEBT_TARGET_HINTS[t]}</span>
                    </span>
                  </label>
                ))}
              </div>
              {showErrors && dErrors.debtTo && <p className="mt-1 text-small text-danger">{dErrors.debtTo}</p>}
            </fieldset>
          )}
          {p.debt > 0 && decision.debtTo === 'new_owner' && (
            <FormField label="Yeni malik" error={showErrors ? dErrors.newOwnerUserId : undefined}>
              <Select value={decision.newOwnerUserId} onChange={(e) => set({ newOwnerUserId: e.target.value })}>
                <option value="" disabled>
                  Seçin
                </option>
                {p.incomingOwners.map((o) => (
                  <option key={o.userId} value={o.userId}>
                    {names.get(o.userId) ?? 'Adı kayıtlı değil'} · {formatDate(o.startDate)}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          {p.advance > 0 && (
            <fieldset>
              <legend className="mb-1.5 text-small font-medium">{formatTRY(p.advance)} avans ne olsun?</legend>
              <div className="flex flex-col gap-2">
                {p.targets.advance.map((t) => (
                  <label key={t} className={choiceClass}>
                    <input type="radio" name="advanceTo" className="mt-1" checked={decision.advanceTo === t} onChange={() => set({ advanceTo: t })} />
                    <span className="text-small font-medium">{advanceTargetLabel(p.party, t)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          {p.advance > 0 && decision.advanceTo === 'refund' && (
            <FormField label="İade hesabı" error={showErrors ? dErrors.refundAccountId : undefined} hint="Para bu hesaptan çıkar; işlem geri alınamaz.">
              <Select value={decision.refundAccountId} onChange={(e) => set({ refundAccountId: e.target.value })} disabled={accounts.isPending}>
                <option value="" disabled>
                  {accounts.isPending ? 'Yükleniyor…' : 'Kasa / banka seçin'}
                </option>
                {funds.map((a) => (
                  <option key={a.accountId} value={a.accountId}>
                    {a.name} ({formatTRY(a.balance)})
                  </option>
                ))}
              </Select>
            </FormField>
          )}
        </>
      )}

      {step === 'confirm' && p && decision && (
        <>
          {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md bg-surface-muted px-3 py-2 text-small">
            <dt className="text-muted">Cari</dt>
            <dd>{CLOSURE_PARTY_LABELS[p.party]}</dd>
            <dt className="text-muted">Çıkış</dt>
            <dd>{formatDate(p.moveOutDate)}</dd>
            <dt className="text-muted">Ayrılan</dt>
            <dd>{decision.userIds.length ? decision.userIds.map((u) => names.get(u) ?? 'Adı kayıtlı değil').join(', ') : '—'}</dd>
            <dt className="text-muted">Sonuç</dt>
            <dd>{outcomeText({ ...p, debtTo: decision.debtTo, advanceTo: decision.advanceTo }, formatTRY)}</dd>
          </dl>
          <FormField label="Gerekçe" error={showErrors ? rError : undefined} hint="Kapama kaydında ve ters kayıtlarda görünür.">
            <Textarea
              rows={2}
              maxLength={300}
              placeholder="Örn. Kiracı 15 Kasım'da taşındı, anahtar teslim alındı"
              value={decision.reason}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </FormField>
          <Alert>
            Kapama sonrası bu tarihe kadar olan hareketler ana cariden ters kayıtla düzeltilemez; gerekirse kapamayı geri alın.
          </Alert>
        </>
      )}

      {step !== 'who' && (
        <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-between">
          <Button
            variant="ghost"
            disabled={create.isPending}
            onClick={() => setStep(WIZARD_STEPS[WIZARD_STEPS.indexOf(step) - 1] ?? 'who')}
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            Geri
          </Button>
          {step === 'preview' && (
            <Button disabled={!p || !!blocked} onClick={() => setStep('decision')}>
              Devam
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          )}
          {step === 'decision' && (
            <Button disabled={!p} onClick={goConfirm}>
              Devam
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          )}
          {step === 'confirm' && (
            <Button loading={create.isPending} onClick={() => void submit()}>
              <Wallet className="size-4" aria-hidden="true" />
              Cariyi kapat
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
