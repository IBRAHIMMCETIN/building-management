import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Dialog, FormField, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useLineSuggestions, useMatchLine, useMatchTargets } from '@/hooks/useBank';
import { type BankLine, type MatchTarget, type Suggestion, closedAccountFrom } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { type AllocationRow, MAX_ALLOCATIONS, allocationState, confidenceBadge, fillRemaining, filterTargets, rowsFromSuggestion } from '@/lib/bank/allocation';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

type Props = { open: boolean; onClose: () => void; line: BankLine | null; bankAccountId: string };

const targetLabel = (t: MatchTarget) =>
  `${t.unitLabel} · ${t.partyLabel}${t.holderNames.length ? ` · ${t.holderNames.join(', ')}` : ''}${t.openBalance > 0 ? ` · borç ${formatTRY(t.openBalance)}` : ''}${t.closedThrough ? ` · kapalı (${formatDate(t.closedThrough)})` : ''}`;

/**
 * Eslestir / Bol: tek banka satirini 1-10 alt cariye dagitir. Oneriler tek tikla uygulanir; kapali
 * (tasinma kapamasi) cariye dusen eslestirmede API'nin onerdigi ayrilan cari secilebilir.
 */
export function MatchDialog({ open, onClose, line, bankAccountId }: Props) {
  const suggestions = useLineSuggestions(bankAccountId, open && line ? line.lineId : undefined);
  const targets = useMatchTargets(open);
  const match = useMatchLine();
  const [rows, setRows] = useState<AllocationRow[]>([]);
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  const [applied, setApplied] = useState<Suggestion | undefined>();

  // Yeni satir acildiginda formu ilk oneriyle (yoksa bos tek satirla) baslat.
  useEffect(() => {
    if (!open || !line) return;
    setQuery('');
    setReason('');
    match.reset();
    const first = line.suggestion;
    setApplied(first);
    setRows(first ? rowsFromSuggestion(first) : [{ accountId: '', amount: '' }]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.lineId]);

  const state = useMemo(() => allocationState(line?.amount ?? 0, rows), [line?.amount, rows]);
  const filtered = useMemo(() => filterTargets(targets.data ?? [], query, 50), [targets.data, query]);
  const byId = useMemo(() => new Map((targets.data ?? []).map((t) => [t.accountId, t])), [targets.data]);
  const closed = closedAccountFrom(match.error);

  if (!line) return null;

  const setRow = (i: number, patch: Partial<AllocationRow>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const apply = (s: Suggestion) => {
    setApplied(s);
    setRows(rowsFromSuggestion(s));
    match.reset();
  };
  const replaceAccount = (from: string, to: string) => {
    setRows((rs) => rs.map((r) => (r.accountId === from ? { ...r, accountId: to } : r)));
    setApplied(undefined);
    match.reset();
  };

  const submit = async () => {
    if (!state.valid) return;
    const sameAsSuggestion =
      applied &&
      applied.allocations.length === state.allocations.length &&
      applied.allocations.every((a, i) => a.accountId === state.allocations[i]?.accountId && a.amount === state.allocations[i]?.amount);
    try {
      await match.mutateAsync({
        lineId: line.lineId,
        input: {
          bankAccountId,
          expectedVersion: line.version,
          allocations: state.allocations,
          ...(reason.trim().length >= 3 ? { reason: reason.trim() } : {}),
          source: sameAsSuggestion ? 'suggestion' : 'manual',
          ...(sameAsSuggestion && applied ? { confidence: applied.confidence } : {}),
        },
      });
      onClose();
    } catch {
      // Hata asagida gosterilir (kapali cari icin secenekli).
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="Eşleştir / Böl" className="max-w-3xl">
      <div className="flex flex-col gap-4">
        <div className="rounded-md bg-surface-muted p-3 text-small">
          <p className="font-medium">{line.description}</p>
          <p className="text-muted">
            {formatDate(line.valueDate ?? line.date)}
            {line.counterpartyName ? ` · ${line.counterpartyName}` : ''}
            {line.counterpartyIbanMasked ? ` · ${line.counterpartyIbanMasked}` : ''}
          </p>
          <p className="mt-1 text-heading font-semibold tabular-nums">{formatTRY(line.amount)}</p>
        </div>

        <section aria-label="Öneriler" className="flex flex-col gap-2">
          <h3 className="text-small font-semibold">Öneriler</h3>
          {suggestions.isPending && <Spinner />}
          {suggestions.data && suggestions.data.suggestions.length === 0 && <p className="text-small text-muted">Bu satır için öneri bulunamadı; cariyi aşağıdan seçin.</p>}
          <ul className="flex flex-col gap-2">
            {suggestions.data?.suggestions.map((s, i) => {
              const badge = confidenceBadge(s.confidence);
              return (
                <li key={`${s.kind}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border p-2">
                  <div className="min-w-0 text-small">
                    <p className="font-medium">{s.allocations.map((a) => `${a.unitLabel} (${a.partyLabel}) ${formatTRY(a.amount)}`).join(' + ')}</p>
                    <p className="text-muted">{s.reasons.join(' · ')}</p>
                  </div>
                  <span className="flex items-center gap-2">
                    <Badge tone={badge.tone}>{badge.label}</Badge>
                    <Button size="xs" variant="secondary" onClick={() => apply(s)}>
                      Uygula
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </section>

        <section aria-label="Dağıtım" className="flex flex-col gap-3">
          <FormField label="Cari ara" hint="Blok/daire, kişi adı veya referans kodu">
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="ör. A Blok 12, Ayşe" />
          </FormField>
          {rows.map((r, i) => {
            const selected = r.accountId ? byId.get(r.accountId) : undefined;
            const options = selected && !filtered.some((t) => t.accountId === selected.accountId) ? [selected, ...filtered] : filtered;
            return (
              <div key={i} className="grid grid-cols-[1fr_9rem_auto] items-end gap-2">
                <FormField label={`Cari ${i + 1}`}>
                  <Select value={r.accountId} onChange={(e) => setRow(i, { accountId: e.target.value })}>
                    <option value="">Seçin…</option>
                    {options.map((t) => (
                      <option key={t.accountId} value={t.accountId}>
                        {targetLabel(t)}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <FormField label="Tutar">
                  <Input inputMode="decimal" value={r.amount} onChange={(e) => setRow(i, { amount: e.target.value })} placeholder="0,00" />
                </FormField>
                <Button variant="ghost" size="sm" aria-label={`Cari ${i + 1} satırını sil`} disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                  <Trash2 className="size-4" aria-hidden="true" />
                </Button>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="secondary" disabled={rows.length >= MAX_ALLOCATIONS} onClick={() => setRows((rs) => [...rs, { accountId: '', amount: '' }])}>
              <Plus className="size-4" aria-hidden="true" />
              Cari ekle (böl)
            </Button>
            <Button size="sm" variant="ghost" disabled={state.remaining <= 0} onClick={() => setRows((rs) => fillRemaining(line.amount, rs))}>
              Kalanı son satıra ekle
            </Button>
            <span className="ml-auto text-small tabular-nums" aria-live="polite">
              Dağıtılan {formatTRY(state.total)} / {formatTRY(line.amount)}
              {state.remaining !== 0 && <span className="text-warning"> · kalan {formatTRY(state.remaining)}</span>}
            </span>
          </div>
          {!state.valid && state.error && <p className="text-small text-muted">{state.error}</p>}
        </section>

        <FormField label="Not (isteğe bağlı)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
        </FormField>

        {closed ? (
          <Alert tone="danger">
            <p>
              Seçilen cari taşınma kapamasıyla {closed.closedThrough ? formatDate(closed.closedThrough) : ''} tarihine kadar kapatıldı. Ödeme ayrılan cariye
              işlenebilir:
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {closed.formerAccounts.length === 0 && <span>Bu dairede açık ayrılan cari yok.</span>}
              {closed.formerAccounts.map((f) => (
                <Button key={f.accountId} size="xs" variant="secondary" onClick={() => replaceAccount(closed.accountId, f.accountId)}>
                  {f.name} ({formatTRY(Math.max(0, f.balance))} borç) seç
                </Button>
              ))}
            </div>
          </Alert>
        ) : (
          match.isError && <Alert tone="danger">{errorMessage(match.error)}</Alert>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button loading={match.isPending} disabled={!state.valid} onClick={() => void submit()}>
            Tahsilata çevir
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

type ReasonDialogProps = {
  open: boolean;
  title: string;
  description: string;
  actionLabel: string;
  danger?: boolean;
  pending: boolean;
  error: unknown;
  onClose: () => void;
  onSubmit: (reason: string) => void;
};

/** Yoksay / geri al: zorunlu gerekce (3-300 karakter) denetim kaydina yazilir. */
export function ReasonDialog({ open, title, description, actionLabel, danger, pending, error, onClose, onSubmit }: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (open) setReason('');
  }, [open]);
  const valid = reason.trim().length >= 3;
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onSubmit(reason.trim());
        }}
      >
        <p className="text-small text-muted">{description}</p>
        <FormField label="Gerekçe" hint="Denetim kaydına yazılır (en az 3 karakter)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={300} />
        </FormField>
        {error ? <Alert tone="danger">{errorMessage(error)}</Alert> : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} loading={pending} disabled={!valid}>
            {actionLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
