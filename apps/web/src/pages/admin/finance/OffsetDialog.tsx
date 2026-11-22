import { ArrowRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useIdempotencyKey } from '@/hooks/useIdempotencyKey';
import { useCreateOffset, useOffsetPreview } from '@/hooks/useRestructure';
import { errorMessage } from '@/lib/api/errors';
import type { FinanceAccount } from '@/lib/api/finance';
import { formatDate } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { offsetFormState } from '@/lib/restructure/model';

export type OffsetPreset = { unitId?: string; sourceAccountId?: string; targetAccountId?: string };
type Props = { open: boolean; onClose: () => void; preset?: OffsetPreset | null };

const balanceText = (a: FinanceAccount) =>
  a.balance < 0 ? `avans ${formatTRY(-a.balance)}` : a.balance > 0 ? `borç ${formatTRY(a.balance)}` : 'bakiye yok';

/**
 * Finans 2.2 - Avans mahsubu: bir alt carideki serbest avansi baska bir alt carinin acik borcuna
 * mahsup eder (tek `offset` islemi). Farkli kisiler arasi mahsupta muvafakat beyani zorunlu.
 */
export function OffsetDialog({ open, onClose, preset }: Props) {
  const accounts = useFinanceAccounts('receivable');
  const create = useCreateOffset();
  const [key, renewKey] = useIdempotencyKey();
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [amountText, setAmountText] = useState('');
  const [pickItems, setPickItems] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [consentNote, setConsentNote] = useState('');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSource(preset?.sourceAccountId ?? '');
    setTarget(preset?.targetAccountId ?? '');
    setAmountText('');
    setPickItems(false);
    setSelected([]);
    setConsent(false);
    setConsentNote('');
    setReason('');
    setTouched(false);
    create.reset();
    renewKey();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- yalnizca acilista
  }, [open]);

  const options = useMemo(
    () =>
      (accounts.data ?? [])
        .filter((a) => a.unitId && (!preset?.unitId || a.unitId === preset.unitId))
        .sort((a, b) => a.name.localeCompare(b.name, 'tr', { numeric: true })),
    [accounts.data, preset?.unitId],
  );
  const preview = useOffsetPreview(source, target);
  const p = preview.data;
  const state = offsetFormState({
    amount: parseTRYToKurus(amountText),
    maxAmount: p?.maxAmount ?? 0,
    selected: pickItems ? selected : [],
    items: p?.targetOpenItems ?? [],
    consentRequired: p?.consentRequired ?? false,
    consent,
    consentNote,
    reason,
  });
  const show = (e?: string) => (touched ? e : undefined);

  const submit = async () => {
    setTouched(true);
    if (!p || !state.valid) return;
    try {
      await create.mutateAsync({
        idempotencyKey: key,
        sourceAccountId: source,
        targetAccountId: target,
        amount: state.amount,
        ...(state.settles ? { settles: state.settles } : {}),
        ...(p.consentRequired ? { consent: { thirdParty: true as const, note: consentNote.trim() } } : {}),
        reason: reason.trim(),
      });
      onClose();
    } catch {
      // asagida gosterilir
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Avans mahsubu" className="max-w-xl">
      <div className="flex flex-col gap-3">
        <p className="text-small text-muted">
          Bir carideki serbest avans, başka bir carinin açık borcuna mahsup edilir. Kaynakta avans azalır, hedefte borç kapanır; hata
          olursa mahsup kaydından ters kayıtla geri alınır.
        </p>
        {accounts.isError && <Alert tone="danger">{errorMessage(accounts.error)}</Alert>}
        <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-end">
          <FormField label="Kaynak cari (avans)">
            <Select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Kaynak cari">
              <option value="">Seçin</option>
              {options.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name} · {balanceText(a)}
                </option>
              ))}
            </Select>
          </FormField>
          <ArrowRight className="hidden size-5 text-muted sm:mb-2.5 sm:block" aria-hidden="true" />
          <FormField label="Hedef cari (borç)">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Hedef cari">
              <option value="">Seçin</option>
              {options.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name} · {balanceText(a)}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
        {source && source === target && <Alert tone="danger">Kaynak ve hedef aynı cari olamaz.</Alert>}

        {preview.isFetching && !p && <Spinner />}
        {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
        {p && (
          <>
            <dl className="grid grid-cols-3 gap-2 text-small" aria-label="Mahsup önizlemesi">
              <div className="rounded-md bg-surface-muted p-2">
                <dt className="text-muted">Serbest avans</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(p.sourceAdvance)}</dd>
              </div>
              <div className="rounded-md bg-surface-muted p-2">
                <dt className="text-muted">Açık borç</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(p.targetOpenDebt)}</dd>
              </div>
              <div className="rounded-md bg-surface-muted p-2">
                <dt className="text-muted">En fazla</dt>
                <dd className="font-semibold tabular-nums">{formatTRY(p.maxAmount)}</dd>
              </div>
            </dl>
            <div>{p.samePerson ? <Badge tone="success">Aynı kişi</Badge> : <Badge tone="warning">Farklı kişiler</Badge>}</div>

            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={pickItems} onChange={(e) => setPickItems(e.target.checked)} />
              Kalem seçerek mahsup et (seçilmezse en eski borçtan başlanır)
            </label>
            {pickItems ? (
              <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-lg border border-border" aria-label="Açık kalemler">
                {p.targetOpenItems.map((i) => (
                  <li key={i.chargeId}>
                    <label className="flex items-center justify-between gap-3 px-3 py-2 text-small">
                      <span className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          value={i.chargeId}
                          checked={selected.includes(i.chargeId)}
                          onChange={(e) => setSelected((cur) => (e.target.checked ? [...cur, i.chargeId] : cur.filter((x) => x !== i.chargeId)))}
                        />
                        <span>
                          {i.description}
                          <span className="block text-xs text-muted">
                            Vade {formatDate(i.dueDate)}
                            {i.overdue ? ' · gecikmede' : ''}
                            {i.plan ? ` · taksit ${i.plan.no}` : ''}
                          </span>
                        </span>
                      </span>
                      <span className="tabular-nums">{formatTRY(i.remaining)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <FormField label="Tutar (TL)" error={show(state.errors.amount)}>
                <Input inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} placeholder="0,00" aria-label="Tutar" />
              </FormField>
            )}
            {!pickItems && p.maxAmount > 0 && (
              <div>
                <Button variant="ghost" size="xs" onClick={() => setAmountText(kurusToInput(p.maxAmount))}>
                  Tamamını mahsup et ({formatTRY(p.maxAmount)})
                </Button>
              </div>
            )}
            {pickItems && state.errors.amount && touched && <Alert tone="danger">{state.errors.amount}</Alert>}

            {p.consentRequired && (
              <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                <label className="flex items-start gap-2 text-small">
                  <input type="checkbox" className="mt-1" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
                  Kaynak carinin sahibinden bu mahsup için muvafakat alındı.
                </label>
                <FormField label="Muvafakat açıklaması" error={show(state.errors.consent)}>
                  <Input value={consentNote} maxLength={300} onChange={(e) => setConsentNote(e.target.value)} placeholder="Örn. Kiracı yazılı onay verdi (12.11.2026)" />
                </FormField>
              </div>
            )}

            <FormField label="Gerekçe" error={show(state.errors.reason)}>
              <Textarea rows={2} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Örn. Kiracının fazla ödemesi aidata sayıldı" />
            </FormField>

            {state.amount > 0 && !state.errors.amount && (
              <p className="text-small text-muted" aria-live="polite">
                Mahsup sonrası: kaynakta kalan avans {formatTRY(p.sourceAdvance - state.amount)}, hedefte kalan borç{' '}
                {formatTRY(p.targetOpenDebt - state.amount)}.
              </p>
            )}
          </>
        )}

        {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={create.isPending} disabled={!p || (touched && !state.valid)} onClick={() => void submit()}>
            Mahsubu kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
