import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Spinner } from '@/components/ui';
import { usePayableSuggestions, useSettlePayable } from '@/hooks/useBank';
import type { BankLine } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { confidenceBadge } from '@/lib/bank/allocation';
import { preselectPayable, settleState, sortPayables } from '@/lib/bank/payable';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

type Props = { open: boolean; onClose: () => void; line: BankLine | null; bankAccountId: string };

/**
 * Faz B3.5 - Tedarikci Odemesi: bankadan cikan satirla vadeli giderden dogan tedarikci borcunu
 * kapatir (borc: tedarikci, alacak: banka). Tutar banka satirindan gelir; acik borcu asamaz.
 */
export function SettlePayableDialog({ open, onClose, line, bankAccountId }: Props) {
  const data = usePayableSuggestions(bankAccountId, open && line ? line.lineId : undefined);
  const settle = useSettlePayable();
  const [selected, setSelected] = useState('');
  const [description, setDescription] = useState('');

  const suggestions = data.data?.suggestions ?? [];
  const payables = useMemo(() => sortPayables(data.data?.payables ?? [], suggestions[0]?.payableAccountId), [data.data, suggestions]);

  useEffect(() => {
    if (!open || !line) return;
    settle.reset();
    setDescription('');
    setSelected(preselectPayable(data.data?.suggestions ?? [], data.data?.payables ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.lineId, data.data]);

  if (!line) return null;
  const chosen = payables.find((p) => p.accountId === selected);
  const state = settleState(line.amount, chosen);
  const suggestion = suggestions.find((s) => s.payableAccountId === selected);

  return (
    <Dialog open={open} onClose={onClose} title="Tedarikçi ödemesi">
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-small">
          <p className="font-semibold tabular-nums">{formatTRY(line.amount)}</p>
          <p className="text-muted">
            {formatDate(line.valueDate ?? line.date)} · {line.description}
          </p>
          {line.counterpartyName && <p className="text-xs text-muted">{line.counterpartyName}</p>}
        </div>

        {data.isPending ? (
          <Spinner />
        ) : data.isError ? (
          <Alert tone="danger">{errorMessage(data.error)}</Alert>
        ) : payables.length === 0 ? (
          <Alert tone="info">Açık borcu olan tedarikçi yok. Vadeli gider (tedarikçi borcu) kaydı olmadan bu satırı “Gider Oluştur” ile işleyin.</Alert>
        ) : (
          <fieldset className="flex flex-col gap-1" aria-label="Tedarikçi">
            <legend className="mb-1 text-small font-medium">Tedarikçi</legend>
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-lg border border-border">
              {payables.map((p) => {
                const s = suggestions.find((x) => x.payableAccountId === p.accountId);
                const badge = s ? confidenceBadge(s.confidence) : undefined;
                return (
                  <li key={p.accountId}>
                    <label className="flex cursor-pointer items-start justify-between gap-3 px-3 py-2 text-small">
                      <span className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="payable"
                          value={p.accountId}
                          checked={selected === p.accountId}
                          onChange={() => setSelected(p.accountId)}
                          className="mt-1"
                        />
                        <span>
                          <span className="block font-medium">{p.name}</span>
                          <span className="block text-xs text-muted">
                            {p.openItems.length} açık fatura
                            {p.openItems[0] ? ` · en eski: ${p.openItems[0].description}` : ''}
                          </span>
                        </span>
                      </span>
                      <span className="flex flex-col items-end gap-1">
                        <span className="tabular-nums">{formatTRY(p.openBalance)}</span>
                        {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
        {suggestion && suggestion.reasons.length > 0 && <p className="text-xs text-muted">Öneri: {suggestion.reasons.join(' · ')}</p>}

        <FormField label="Açıklama (isteğe bağlı)">
          <Input value={description} maxLength={200} placeholder={`Tedarikçi ödemesi: ${line.description}`} onChange={(e) => setDescription(e.target.value)} aria-label="Açıklama" />
        </FormField>

        {chosen && state.valid && state.remaining !== undefined && (
          <p className="text-small text-muted">Ödeme sonrası kalan borç: {formatTRY(state.remaining)}</p>
        )}
        {chosen && !state.valid && state.error && <Alert tone="danger">{state.error}</Alert>}
        {settle.isError && <Alert tone="danger">{errorMessage(settle.error)}</Alert>}
        <p className="text-xs text-muted">Tedarikçi hesabına borç, banka hesabına alacak yazılır (valör tarihli). Yanlışsa “Geri al” ile ters kayıtla iptal edilir.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            loading={settle.isPending}
            disabled={!state.valid}
            onClick={async () => {
              if (!chosen || !state.valid) return;
              try {
                await settle.mutateAsync({
                  lineId: line.lineId,
                  input: {
                    bankAccountId,
                    expectedVersion: line.version,
                    payableAccountId: chosen.accountId,
                    ...(description.trim() ? { description: description.trim() } : {}),
                    ...(suggestion ? { source: 'suggestion' as const, confidence: suggestion.confidence } : { source: 'manual' as const }),
                  },
                });
                onClose();
              } catch {
                // yukarida gosterilir
              }
            }}
          >
            Ödemeyi kaydet
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
