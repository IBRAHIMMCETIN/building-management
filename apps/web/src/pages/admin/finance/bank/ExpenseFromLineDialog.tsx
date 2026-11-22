import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Dialog, FormField, Input, Select, Spinner } from '@/components/ui';
import { useCreateBankExpense } from '@/hooks/useBank';
import { useFinanceAccounts } from '@/hooks/useFinance';
import type { BankLine } from '@/lib/api/bank';
import { errorMessage } from '@/lib/api/errors';
import { type ExpenseForm, expenseDefaults, expenseFormState } from '@/lib/bank/expense';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

type Props = { open: boolean; onClose: () => void; line: BankLine | null; bankAccountId: string };

const EMPTY: ExpenseForm = { expenseAccountId: '', description: '', supplier: '', invoiceNumber: '' };

/**
 * Faz B3 - Gider Olustur: bankadan cikan satiri (fatura, bakim, banka masrafi...) gider olarak
 * deftere isler. Tutar ve tarih banka satirindan gelir (degistirilemez); kalem ve aciklama secilir.
 */
export function ExpenseFromLineDialog({ open, onClose, line, bankAccountId }: Props) {
  const accounts = useFinanceAccounts('expense');
  const create = useCreateBankExpense();
  const [form, setForm] = useState<ExpenseForm>(EMPTY);

  // Yeni satir acildiginda varsayilanlar (aciklamadan tahmin edilen gider kalemi).
  useEffect(() => {
    if (!open || !line) return;
    create.reset();
    setForm(expenseDefaults(line, accounts.data ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, line?.lineId, accounts.data]);

  const state = useMemo(() => expenseFormState(form), [form]);
  if (!line) return null;
  const set = (patch: Partial<ExpenseForm>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Dialog open={open} onClose={onClose} title="Gider oluştur">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!state.valid || !state.input) return;
          try {
            await create.mutateAsync({ lineId: line.lineId, input: { bankAccountId, expectedVersion: line.version, ...state.input } });
            onClose();
          } catch {
            // asagida gosterilir
          }
        }}
      >
        <div className="rounded-lg border border-border bg-surface-muted/40 px-3 py-2 text-small">
          <p className="font-semibold tabular-nums">{formatTRY(line.amount)}</p>
          <p className="text-muted">
            {formatDate(line.valueDate ?? line.date)} · {line.description}
          </p>
          {line.counterpartyName && <p className="text-xs text-muted">{line.counterpartyName}</p>}
        </div>
        {accounts.isPending ? (
          <Spinner />
        ) : accounts.isError ? (
          <Alert tone="danger">{errorMessage(accounts.error)}</Alert>
        ) : (
          <FormField label="Gider kalemi">
            <Select value={form.expenseAccountId} onChange={(e) => set({ expenseAccountId: e.target.value })} aria-label="Gider kalemi">
              <option value="">Seçin…</option>
              {(accounts.data ?? []).map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name}
                </option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="Açıklama">
          <Input value={form.description} maxLength={200} onChange={(e) => set({ description: e.target.value })} aria-label="Açıklama" />
        </FormField>
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tedarikçi (isteğe bağlı)">
            <Input value={form.supplier} maxLength={120} onChange={(e) => set({ supplier: e.target.value })} aria-label="Tedarikçi" />
          </FormField>
          <FormField label="Fatura / belge no (isteğe bağlı)">
            <Input value={form.invoiceNumber} maxLength={60} onChange={(e) => set({ invoiceNumber: e.target.value })} aria-label="Fatura no" />
          </FormField>
        </div>
        <p className="text-xs text-muted">
          Gider kalemine borç, banka hesabına alacak yazılır (valör tarihli). Yanlışsa “Geri al” ile ters kayıtla iptal edilir.
        </p>
        {!state.valid && state.error && form.expenseAccountId !== '' && <Alert tone="danger">{state.error}</Alert>}
        {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Vazgeç
          </Button>
          <Button type="submit" loading={create.isPending} disabled={!state.valid}>
            Gideri kaydet
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
