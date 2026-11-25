import { CheckCircle2, Copy, Plus, Scale, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, Dialog, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import {
  useApplyBudgetDuesPlan,
  useApproveBudget,
  useBudgetDuesPreview,
  useBudgets,
  useCreateBudget,
  useDeleteBudget,
  useUpdateBudget,
} from '@/hooks/useFinancePeriods';
import { useSite } from '@/hooks/useSite';
import { errorMessage } from '@/lib/api/errors';
import { PARTY_LABELS } from '@/lib/api/finance';
import { type Budget, DUES_KEYS, DUES_KEY_LABELS, MONTH_NAMES, formatPeriod } from '@/lib/api/financePeriods';
import { formatDate } from '@/lib/dates';
import { formatTRY, kurusToInput, parseTRYToKurus } from '@/lib/money';
import { type DraftLine, balanceDues, draftFromBudget, draftToInput, lineTotal, splitAnnual } from './budgetDraft';

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const STATUS: Record<Budget['status'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  approved: { label: 'Onaylı', tone: 'success' },
  draft: { label: 'Taslak', tone: 'warning' },
  superseded: { label: 'Yerine yenisi onaylandı', tone: 'neutral' },
};

/**
 * Finans 2.4 - Butce / yillik isletme projesi. Taslak hazirlanir, karar referansiyla onaylanir;
 * onayli butceden aidat onizlenir ve aylik aidat planina uygulanir. Onayli butce degismez; degisiklik
 * yeni revizyonla yapilir. Raporlar sekmesindeki butce-gerceklesen onayli surumu kullanir.
 */
export function BudgetPanel({ canWrite }: { canWrite: boolean }) {
  const currentYear = Number(todayIso().slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const budgets = useBudgets(year);
  const previousYear = useBudgets(year - 1);
  const create = useCreateBudget();
  const [selected, setSelected] = useState<string | null>(null);

  const items = budgets.data?.items ?? [];
  const draft = items.find((b) => b.status === 'draft');
  const approved = items.find((b) => b.status === 'approved');
  const prevApproved = previousYear.data?.items.find((b) => b.status === 'approved');
  const shown = items.find((b) => b.budgetId === selected) ?? draft ?? approved ?? items[0];

  useEffect(() => setSelected(null), [year]);

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-end gap-4">
        <FormField label="Yıl">
          <Select value={String(year)} onChange={(e) => setYear(Number(e.target.value))}>
            {[currentYear + 1, currentYear, currentYear - 1, currentYear - 2].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </Select>
        </FormField>
        <div className="flex flex-wrap gap-2">
          {items.map((b) => (
            <Button key={b.budgetId} size="sm" variant={shown?.budgetId === b.budgetId ? 'primary' : 'secondary'} onClick={() => setSelected(b.budgetId)}>
              r{b.revision} · {STATUS[b.status].label}
            </Button>
          ))}
        </div>
        {canWrite && !draft && (
          <div className="ml-auto flex flex-wrap gap-2">
            {(approved ?? prevApproved) && (
              <Button
                variant="secondary"
                loading={create.isPending}
                onClick={() => create.mutate({ year, copyFrom: (approved ?? prevApproved)?.budgetId }, { onSuccess: (b) => setSelected(b.budgetId) })}
              >
                <Copy className="size-4" aria-hidden="true" />
                {approved ? 'Yeni revizyon' : `${year - 1} bütçesinden kopyala`}
              </Button>
            )}
            <Button loading={create.isPending} onClick={() => create.mutate({ year }, { onSuccess: (b) => setSelected(b.budgetId) })}>
              <Plus className="size-4" aria-hidden="true" />
              Boş taslak
            </Button>
          </div>
        )}
      </Card>
      {create.isError && <Alert tone="danger">{errorMessage(create.error)}</Alert>}
      {budgets.isPending && <Skeleton className="h-48 w-full" />}
      {budgets.isError && <Alert tone="danger">{errorMessage(budgets.error)}</Alert>}
      {budgets.isSuccess && !shown && <Alert tone="info">{year} için bütçe yok.{canWrite ? ' Boş bir taslakla ya da önceki yılın bütçesinden başlayın.' : ''}</Alert>}
      {shown && (shown.status === 'draft' && canWrite ? <DraftEditor key={`${shown.budgetId}-${shown.version}`} budget={shown} /> : <BudgetView budget={shown} canWrite={canWrite} />)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Taslak duzenleyici
// ---------------------------------------------------------------------------

function DraftEditor({ budget }: { budget: Budget }) {
  const income = useFinanceAccounts('income');
  const expense = useFinanceAccounts('expense');
  const update = useUpdateBudget();
  const remove = useDeleteBudget();
  const [approving, setApproving] = useState(false);
  const [draft, setDraft] = useState(() => draftFromBudget(budget));
  const [expanded, setExpanded] = useState<number | null>(null);
  const accounts = useMemo(() => [...(income.data ?? []), ...(expense.data ?? [])], [income.data, expense.data]);
  const nameOf = (id: string) => accounts.find((a) => a.accountId === id)?.name ?? id;
  const used = new Set(draft.lines.map((l) => l.accountId));
  const totals = useMemo(() => {
    const kindOf = (id: string) => accounts.find((a) => a.accountId === id)?.type;
    const inc = draft.lines.filter((l) => kindOf(l.accountId) === 'income').reduce((s, l) => s + lineTotal(l), 0);
    const exp = draft.lines.filter((l) => kindOf(l.accountId) === 'expense').reduce((s, l) => s + lineTotal(l), 0);
    return { income: inc, expense: exp, result: inc - exp };
  }, [draft.lines, accounts]);
  const duesAccount = draft.dues?.incomeAccountId ?? 'income-dues';
  const setLine = (i: number, patch: Partial<DraftLine>) => setDraft((d) => ({ ...d, lines: d.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)) }));
  const save = (onSuccess?: () => void) => update.mutate({ budgetId: budget.budgetId, input: { version: budget.version, ...draftToInput(draft) } }, { onSuccess });
  const dirty = JSON.stringify(draftToInput(draft)) !== JSON.stringify(draftToInput(draftFromBudget(budget)));

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold">
          {budget.year} işletme projesi · r{budget.revision}
        </h2>
        <Badge tone="warning">Taslak</Badge>
      </div>
      <FormField label="Başlık">
        <Input value={draft.title} maxLength={120} placeholder={`${budget.year} Yılı İşletme Projesi`} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} />
      </FormField>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Bütçe kalemleri</caption>
          <thead className="border-b border-border text-xs text-muted">
            <tr>
              <th scope="col" className="px-2 py-2 font-medium">Kalem (hesap)</th>
              <th scope="col" className="px-2 py-2 font-medium">Tür</th>
              <th scope="col" className="px-2 py-2 text-right font-medium">Yıllık tutar (TL)</th>
              <th scope="col" className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {draft.lines.map((l, i) => {
              const acc = accounts.find((a) => a.accountId === l.accountId);
              return (
                <LineRow
                  key={`${l.accountId}-${i}`}
                  line={l}
                  kind={acc?.type === 'income' ? 'Gelir' : 'Gider'}
                  name={nameOf(l.accountId)}
                  isDues={l.accountId === duesAccount}
                  expanded={expanded === i}
                  onToggle={() => setExpanded(expanded === i ? null : i)}
                  onChange={(patch) => setLine(i, patch)}
                  onRemove={() => setDraft((d) => ({ ...d, lines: d.lines.filter((_, j) => j !== i) }))}
                />
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <FormField label="Kalem ekle">
          <Select
            value=""
            onChange={(e) => {
              const id = e.target.value;
              if (id) setDraft((d) => ({ ...d, lines: [...d.lines, { accountId: id, months: Array(12).fill(0), annualText: '' }] }));
            }}
          >
            <option value="">Hesap seçin…</option>
            <optgroup label="Gelir">
              {(income.data ?? []).filter((a) => !used.has(a.accountId)).map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Gider">
              {(expense.data ?? []).filter((a) => !used.has(a.accountId)).map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.name}
                </option>
              ))}
            </optgroup>
          </Select>
        </FormField>
      </div>

      <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
        <Total label="Gelir" value={totals.income} />
        <Total label="Gider" value={totals.expense} />
        <Total label="Sonuç" value={totals.result} danger={totals.result < 0} />
      </div>

      <fieldset className="flex flex-col gap-3 rounded-lg border border-border p-3">
        <legend className="px-1 text-small font-medium">Aidat</legend>
        <label className="flex items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={!!draft.dues}
            onChange={(e) => setDraft((d) => ({ ...d, dues: e.target.checked ? { distributionKey: 'equal', liableParty: 'occupant' } : null }))}
          />
          Bu bütçeden aylık aidat belirlenecek
        </label>
        {draft.dues && (
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Dağıtım anahtarı">
              <Select value={draft.dues.distributionKey} onChange={(e) => setDraft((d) => ({ ...d, dues: d.dues && { ...d.dues, distributionKey: e.target.value as (typeof DUES_KEYS)[number] } }))}>
                {DUES_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {DUES_KEY_LABELS[k]}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Borçlu">
              <Select value={draft.dues.liableParty} onChange={(e) => setDraft((d) => ({ ...d, dues: d.dues && { ...d.dues, liableParty: e.target.value as 'owner' | 'occupant' } }))}>
                <option value="occupant">{PARTY_LABELS.occupant}</option>
                <option value="owner">{PARTY_LABELS.owner}</option>
              </Select>
            </FormField>
            <FormField label="Gelir hesabı">
              <Select
                value={draft.dues.incomeAccountId ?? 'income-dues'}
                onChange={(e) => setDraft((d) => ({ ...d, dues: d.dues && { ...d.dues, incomeAccountId: e.target.value === 'income-dues' ? undefined : e.target.value } }))}
              >
                {(income.data ?? [])
                  .filter((a) => a.accountId !== 'income-late-fee')
                  .map((a) => (
                    <option key={a.accountId} value={a.accountId}>
                      {a.name}
                    </option>
                  ))}
              </Select>
            </FormField>
            <div className="sm:col-span-3">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => setDraft((d) => balanceDues(d, duesAccount, (id) => accounts.find((a) => a.accountId === id)?.type))}
              >
                <Scale className="size-4" aria-hidden="true" />
                Aidatı giderlere göre dengele
              </Button>
              <p className="mt-1 text-xs text-muted">Aidat satırını, giderlerden diğer gelirler düşüldükten sonra kalan tutara eşitler (12 aya eşit).</p>
            </div>
          </div>
        )}
      </fieldset>

      {update.isError && <Alert tone="danger">{errorMessage(update.error)}</Alert>}
      {remove.isError && <Alert tone="danger">{errorMessage(remove.error)}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={!dirty} loading={update.isPending} onClick={() => save()}>
          Kaydet
        </Button>
        <Button variant="secondary" disabled={dirty || !budget.lines.length} onClick={() => setApproving(true)}>
          <CheckCircle2 className="size-4" aria-hidden="true" />
          Onayla
        </Button>
        <Button variant="subtle" className="ml-auto" loading={remove.isPending} onClick={() => remove.mutate({ budgetId: budget.budgetId, version: budget.version })}>
          <Trash2 className="size-4" aria-hidden="true" />
          Taslağı sil
        </Button>
      </div>
      {dirty && <p className="text-xs text-muted">Onaylamadan önce değişiklikleri kaydedin.</p>}
      <ApproveDialog budget={approving ? budget : null} onClose={() => setApproving(false)} />
    </Card>
  );
}

function Total({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <p className="text-xs text-muted">{label}</p>
      <p className={`font-semibold tabular-nums ${danger ? 'text-danger' : ''}`}>{value < 0 ? `−${formatTRY(-value)}` : formatTRY(value)}</p>
    </div>
  );
}

function LineRow(props: {
  line: DraftLine;
  kind: string;
  name: string;
  isDues: boolean;
  expanded: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const { line } = props;
  const uneven = new Set(line.months).size > 1;
  return (
    <>
      <tr>
        <td className="px-2 py-1.5">
          {props.name}
          {props.isDues && (
            <Badge tone="accent" className="ml-2">
              Aidat
            </Badge>
          )}
        </td>
        <td className="px-2 py-1.5 text-muted">{props.kind}</td>
        <td className="px-2 py-1.5 text-right">
          <Input
            className="ml-auto w-40 text-right tabular-nums"
            inputMode="decimal"
            aria-label={`${props.name} yıllık tutar`}
            value={line.annualText}
            placeholder={kurusToInput(lineTotal(line))}
            onChange={(e) => {
              const k = parseTRYToKurus(e.target.value);
              props.onChange({ annualText: e.target.value, ...(k !== null ? { months: splitAnnual(k) } : {}) });
            }}
          />
        </td>
        <td className="px-2 py-1.5 text-right whitespace-nowrap">
          <Button size="xs" variant="subtle" aria-expanded={props.expanded} onClick={props.onToggle}>
            {uneven ? 'Aylık (farklı)' : 'Aylık'}
          </Button>
          <Button size="xs" variant="subtle" aria-label={`${props.name} kalemini kaldır`} onClick={props.onRemove}>
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </td>
      </tr>
      {props.expanded && (
        <tr>
          <td colSpan={4} className="bg-surface-muted/40 px-2 py-2">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
              {line.months.map((m, i) => (
                <label key={MONTH_NAMES[i]} className="flex flex-col gap-1 text-xs text-muted">
                  {MONTH_NAMES[i]}
                  <Input
                    className="h-8 text-right tabular-nums"
                    inputMode="decimal"
                    defaultValue={kurusToInput(m)}
                    onBlur={(e) => {
                      const k = parseTRYToKurus(e.target.value || '0');
                      if (k !== null) props.onChange({ annualText: '', months: line.months.map((v, j) => (j === i ? k : v)) });
                    }}
                  />
                </label>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function ApproveDialog({ budget, onClose }: { budget: Budget | null; onClose: () => void }) {
  const approve = useApproveBudget();
  const [ref, setRef] = useState('');
  const [date, setDate] = useState(todayIso());
  return (
    <Dialog open={!!budget} onClose={onClose} title="Bütçeyi onayla">
      <div className="flex flex-col gap-4">
        <p className="text-small text-muted">
          Onaylanan bütçe değiştirilemez; yılın önceki onaylı sürümü varsa yerini alır. Genel kurul veya yönetim kurulu karar bilgisini girin.
        </p>
        <FormField label="Karar no / referans">
          <Input value={ref} maxLength={60} placeholder="GK-2026/1" onChange={(e) => setRef(e.target.value)} />
        </FormField>
        <FormField label="Karar tarihi">
          <Input type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} />
        </FormField>
        {approve.isError && <Alert tone="danger">{errorMessage(approve.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Vazgeç
          </Button>
          <Button
            disabled={!ref.trim() || !date}
            loading={approve.isPending}
            onClick={() => budget && approve.mutate({ budgetId: budget.budgetId, version: budget.version, decisionRef: ref.trim(), decisionDate: date }, { onSuccess: onClose })}
          >
            Onayla
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Onayli / gecmis butce gorunumu + aidat
// ---------------------------------------------------------------------------

function BudgetView({ budget, canWrite }: { budget: Budget; canWrite: boolean }) {
  const income = useFinanceAccounts('income');
  const expense = useFinanceAccounts('expense');
  const nameOf = (id: string) => [...(income.data ?? []), ...(expense.data ?? [])].find((a) => a.accountId === id)?.name ?? id;
  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">{budget.title ?? `${budget.year} işletme projesi`}</h2>
          <Badge tone={STATUS[budget.status].tone}>{STATUS[budget.status].label}</Badge>
          <span className="text-small text-muted">r{budget.revision}</span>
          {budget.decision && (
            <span className="text-small text-muted">
              · karar {budget.decision.ref} ({formatDate(budget.decision.date)})
            </span>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Total label="Gelir" value={budget.totals.income} />
          <Total label="Gider" value={budget.totals.expense} />
          <Total label="Sonuç" value={budget.totals.result} danger={budget.totals.result < 0} />
        </div>
        <ul className="divide-y divide-border text-small">
          {budget.lines.map((l) => (
            <li key={l.accountId} className="flex justify-between gap-3 py-1.5">
              <span>
                {nameOf(l.accountId)} <span className="text-xs text-muted">({l.kind === 'income' ? 'gelir' : 'gider'})</span>
              </span>
              <span className="tabular-nums">{formatTRY(l.months.reduce((s, v) => s + v, 0))}</span>
            </li>
          ))}
        </ul>
      </Card>
      {budget.dues && <DuesCard budget={budget} canWrite={canWrite && budget.status === 'approved'} />}
    </div>
  );
}

function DuesCard({ budget, canWrite }: { budget: Budget; canWrite: boolean }) {
  const today = todayIso();
  const [month, setMonth] = useState(today.startsWith(`${budget.year}-`) ? today.slice(0, 7) : `${budget.year}-01`);
  const preview = useBudgetDuesPreview(budget.budgetId, month);
  const site = useSite();
  const apply = useApplyBudgetDuesPlan();
  const p = preview.data;
  const plan = site.data?.settings.monthlyDuesPlan;
  const linked = plan?.budgetId === budget.budgetId;

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-4">
        <h3 className="font-semibold">Aidat</h3>
        <FormField label="Ay">
          <Input type="month" value={month} min={`${budget.year}-01`} max={`${budget.year}-12`} onChange={(e) => setMonth(e.target.value)} />
        </FormField>
        {linked && <Badge tone="success">Aylık aidat planı bu bütçeye bağlı</Badge>}
      </div>
      {preview.isError && <Alert tone="danger">{errorMessage(preview.error)}</Alert>}
      {p && (
        <>
          <p className="text-small">
            {formatPeriod(p.month)} aidat toplamı <strong className="tabular-nums">{formatTRY(p.amount)}</strong>
            {p.preview && ` · ${p.preview.count} bölüm · ${DUES_KEY_LABELS[budget.dues?.distributionKey ?? 'equal']} dağıtım`}
          </p>
          {p.balance.duesAnnual < p.balance.expense - p.balance.otherIncome && (
            <Alert tone="danger">
              Bütçelenen aidat ({formatTRY(p.balance.duesAnnual)}) giderleri karşılamıyor. Gerekli yıllık aidat:{' '}
              {formatTRY(p.balance.suggestedMonthlyDues.reduce((s, v) => s + v, 0))}.
            </Alert>
          )}
          {p.preview && p.preview.items.length > 0 && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
              <table className="w-full text-left text-small">
                <caption className="sr-only">Bölüm başına aidat</caption>
                <tbody className="divide-y divide-border tabular-nums">
                  {p.preview.items.map((i) => (
                    <tr key={i.unitId}>
                      <td className="px-3 py-1">{i.number}</td>
                      <td className="px-3 py-1 text-right">{formatTRY(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {apply.isError && <Alert tone="danger">{errorMessage(apply.error)}</Alert>}
      {apply.data && (
        <Alert tone="success">
          Aylık aidat planı {formatTRY(apply.data.plan?.totalAmount ?? 0)} olarak güncellendi.
          {apply.data.warnings.map((w) => ` ${w.message}.`).join('')}
        </Alert>
      )}
      {canWrite && (
        <div>
          <Button
            disabled={!p || p.amount <= 0 || !site.data}
            loading={apply.isPending}
            onClick={() => site.data && apply.mutate({ budgetId: budget.budgetId, siteVersion: site.data.version, month })}
          >
            Aylık aidat planına uygula
          </Button>
          <p className="mt-1 text-xs text-muted">
            Otomatik aylık tahakkuk bu tutar, dağıtım anahtarı ve gelir hesabıyla yapılır{plan?.enabled ? ` (şu an ${formatTRY(plan.totalAmount)})` : ''}.
          </p>
        </div>
      )}
    </Card>
  );
}
