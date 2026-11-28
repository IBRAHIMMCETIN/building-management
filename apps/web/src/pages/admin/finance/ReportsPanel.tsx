import { FileDown } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, FormField, Input, Select, Skeleton } from '@/components/ui';
import { useFinanceAccounts } from '@/hooks/useFinance';
import { useFinanceReport } from '@/hooks/useFinancePeriods';
import { useOpenDocument } from '@/hooks/useOpenDocument';
import { errorMessage } from '@/lib/api/errors';
import {
  REPORT_KINDS,
  REPORT_LABELS,
  type ReportData,
  type ReportKind,
  type ReportQuery,
  financePeriodsApi,
  formatPeriod,
  formatPeriodShort,
} from '@/lib/api/financePeriods';
import { formatDate } from '@/lib/dates';
import { formatTRY } from '@/lib/money';

const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date());
const dash = (n: number) => (n === 0 ? '—' : formatTRY(n));
const signed = (n: number) => (n === 0 ? '—' : `${formatTRY(Math.abs(n))} ${n > 0 ? 'B' : 'A'}`);

/**
 * Finans 2.4 - Raporlar: mizan, gelir-gider, butce-gerceklesen, kesin hesap, borclu listesi ve
 * kasa/banka dokumu. Kapali aylar donem kapanis goruntusunden okunur. PDF sunucuda uretilir.
 */
export function ReportsPanel() {
  const today = todayIso();
  const year = today.slice(0, 4);
  const [kind, setKind] = useState<ReportKind>('trial-balance');
  const [query, setQuery] = useState<Record<ReportKind, ReportQuery>>({
    'trial-balance': { from: `${year}-01`, to: today.slice(0, 7) },
    'income-expense': { year },
    'budget-vs-actual': { year },
    'annual-statement': { year },
    debtors: {},
    'funds-ledger': { accountId: 'cash', from: `${today.slice(0, 7)}-01`, to: today },
  });
  const q = query[kind];
  const set = (patch: ReportQuery) => setQuery((all) => ({ ...all, [kind]: { ...all[kind], ...patch } }));
  const docs = useOpenDocument();

  return (
    <div className="flex flex-col gap-4">
      <FilterChips label="Rapor" value={kind} options={REPORT_KINDS.map((k) => ({ value: k, label: REPORT_LABELS[k] }))} onChange={setKind} />
      <Card className="flex flex-wrap items-end gap-4">
        <ReportFilters kind={kind} query={q} onChange={set} />
        <div className="ml-auto">
          <Button variant="secondary" loading={docs.pendingId === kind} onClick={() => docs.open(kind, () => financePeriodsApi.reportPdf(kind, q))}>
            <FileDown className="size-4" aria-hidden="true" />
            PDF
          </Button>
        </div>
      </Card>
      {docs.error && <Alert tone="danger">{docs.error}</Alert>}
      <ReportBody kind={kind} query={q} />
    </div>
  );
}

function YearSelect({ value, onChange }: { value?: string; onChange: (y: string) => void }) {
  const current = Number(todayIso().slice(0, 4));
  const years = Array.from({ length: 6 }, (_, i) => String(current + 1 - i));
  return (
    <FormField label="Yıl">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        {years.map((y) => (
          <option key={y} value={y}>
            {y}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

function ReportFilters({ kind, query, onChange }: { kind: ReportKind; query: ReportQuery; onChange: (q: ReportQuery) => void }) {
  const funds = useFinanceAccounts();
  if (kind === 'trial-balance') {
    return (
      <>
        <FormField label="Başlangıç">
          <Input type="month" value={query.from} onChange={(e) => onChange({ from: e.target.value })} />
        </FormField>
        <FormField label="Bitiş">
          <Input type="month" value={query.to} onChange={(e) => onChange({ to: e.target.value })} />
        </FormField>
      </>
    );
  }
  if (kind === 'debtors') return <p className="text-small text-muted">Bugün itibarıyla borcu olan bağımsız bölümler.</p>;
  if (kind === 'funds-ledger') {
    const options = (funds.data ?? []).filter((a) => a.type === 'cash' || a.type === 'bank');
    return (
      <>
        <FormField label="Hesap">
          <Select value={query.accountId} onChange={(e) => onChange({ accountId: e.target.value })}>
            {options.map((a) => (
              <option key={a.accountId} value={a.accountId}>
                {a.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Başlangıç">
          <Input type="date" value={query.from} onChange={(e) => onChange({ from: e.target.value })} />
        </FormField>
        <FormField label="Bitiş">
          <Input type="date" value={query.to} onChange={(e) => onChange({ to: e.target.value })} />
        </FormField>
      </>
    );
  }
  return <YearSelect value={query.year} onChange={(year) => onChange({ year })} />;
}

function ReportBody({ kind, query }: { kind: ReportKind; query: ReportQuery }) {
  const report = useFinanceReport(kind, query);
  if (report.isPending) return <Skeleton className="h-64 w-full" />;
  if (report.isError) return <Alert tone="danger">{errorMessage(report.error)}</Alert>;
  const data = report.data as ReportData<ReportKind>;
  switch (kind) {
    case 'trial-balance':
      return <TrialBalance data={data as ReportData<'trial-balance'>} />;
    case 'income-expense':
      return <IncomeExpense data={data as ReportData<'income-expense'>} />;
    case 'budget-vs-actual':
      return <BudgetVsActual data={data as ReportData<'budget-vs-actual'>} />;
    case 'annual-statement':
      return <AnnualStatement data={data as ReportData<'annual-statement'>} />;
    case 'debtors':
      return <Debtors data={data as ReportData<'debtors'>} />;
    case 'funds-ledger':
      return <FundsLedger data={data as ReportData<'funds-ledger'>} />;
  }
}

function Table({ caption, head, children, note }: { caption: string; head: ReactNode; children: ReactNode; note?: ReactNode }) {
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full text-left text-small">
        <caption className="sr-only">{caption}</caption>
        <thead className="border-b border-border text-xs text-muted">{head}</thead>
        <tbody className="divide-y divide-border tabular-nums">{children}</tbody>
      </table>
      {note && <p className="px-4 py-2 text-xs text-muted">{note}</p>}
    </Card>
  );
}
const Th = ({ children, right }: { children?: ReactNode; right?: boolean }) => (
  <th scope="col" className={`px-3 py-2 font-medium whitespace-nowrap ${right ? 'text-right' : ''}`}>
    {children}
  </th>
);
const Td = ({ children, right, strong, muted }: { children?: ReactNode; right?: boolean; strong?: boolean; muted?: boolean }) => (
  <td className={`px-3 py-1.5 whitespace-nowrap ${right ? 'text-right' : ''} ${strong ? 'font-semibold' : ''} ${muted ? 'text-muted' : ''}`}>{children}</td>
);

function ClosedNote({ months }: { months: string[] }) {
  if (!months.length) return null;
  return <>Kapalı aylar ({months.map(formatPeriodShort).join(', ')}) dönem kapanış görüntüsünden alınmıştır.</>;
}

function TrialBalance({ data }: { data: ReportData<'trial-balance'> }) {
  return (
    <>
      {!data.balanced && <Alert tone="danger">Mizan dengede değil. Lütfen destek ekibine bildirin.</Alert>}
      <Table
        caption="Mizan"
        note={<ClosedNote months={data.closedMonths} />}
        head={
          <tr>
            <Th>Kod</Th>
            <Th>Hesap</Th>
            <Th right>Açılış</Th>
            <Th right>Borç</Th>
            <Th right>Alacak</Th>
            <Th right>Kapanış</Th>
          </tr>
        }
      >
        {data.rows.map((r) => (
          <tr key={r.accountId}>
            <Td muted>{r.code ?? ''}</Td>
            <Td>{r.name}</Td>
            <Td right>{signed(r.opening)}</Td>
            <Td right>{dash(r.debit)}</Td>
            <Td right>{dash(r.credit)}</Td>
            <Td right strong>
              {signed(r.closing)}
            </Td>
          </tr>
        ))}
        <tr className="bg-surface-muted/40">
          <Td />
          <Td strong>Toplam</Td>
          <Td />
          <Td right strong>
            {formatTRY(data.totals.debit)}
          </Td>
          <Td right strong>
            {formatTRY(data.totals.credit)}
          </Td>
          <Td />
        </tr>
      </Table>
    </>
  );
}

function IncomeExpense({ data }: { data: ReportData<'income-expense'> }) {
  const head = (
    <tr>
      <Th>Hesap</Th>
      {data.months.map((m) => (
        <Th key={m} right>
          {formatPeriodShort(m)}
        </Th>
      ))}
      <Th right>Toplam</Th>
    </tr>
  );
  const rows = (items: typeof data.income, label: string, totals: number[], total: number) => (
    <>
      {items.map((r) => (
        <tr key={r.accountId}>
          <Td>{r.name}</Td>
          {r.months.map((v, i) => (
            <Td key={data.months[i]} right>
              {dash(v)}
            </Td>
          ))}
          <Td right strong>
            {dash(r.total)}
          </Td>
        </tr>
      ))}
      <tr className="bg-surface-muted/40">
        <Td strong>{label}</Td>
        {totals.map((v, i) => (
          <Td key={data.months[i]} right strong>
            {dash(v)}
          </Td>
        ))}
        <Td right strong>
          {dash(total)}
        </Td>
      </tr>
    </>
  );
  return (
    <Table caption="Gelir - gider" head={head} note={<ClosedNote months={data.closedMonths} />}>
      {rows(data.income, 'Toplam gelir', data.totals.income, data.totals.incomeTotal)}
      {rows(data.expense, 'Toplam gider', data.totals.expense, data.totals.expenseTotal)}
      <tr>
        <Td strong>Sonuç</Td>
        {data.totals.result.map((v, i) => (
          <Td key={data.months[i]} right strong>
            <span className={v < 0 ? 'text-danger' : ''}>{v === 0 ? '—' : `${v < 0 ? '−' : ''}${formatTRY(Math.abs(v))}`}</span>
          </Td>
        ))}
        <Td right strong>
          <span className={data.totals.resultTotal < 0 ? 'text-danger' : ''}>{`${data.totals.resultTotal < 0 ? '−' : ''}${formatTRY(Math.abs(data.totals.resultTotal))}`}</span>
        </Td>
      </tr>
    </Table>
  );
}

function BudgetVsActual({ data }: { data: ReportData<'budget-vs-actual'> }) {
  if (!data.budget) return <Alert tone="info">{data.year} için onaylı bütçe yok. Bütçe sekmesinden işletme projesini hazırlayıp onaylayın.</Alert>;
  const line = (l: (typeof data.lines)[number]) => {
    const over = l.kind === 'expense' ? l.variance > 0 : l.variance < 0;
    return (
      <tr key={l.accountId}>
        <Td>{l.name}</Td>
        <Td right>{dash(l.budgetTotal)}</Td>
        <Td right>{dash(l.budgetYtd)}</Td>
        <Td right>{dash(l.actualYtd)}</Td>
        <Td right>
          <span className={l.variance !== 0 && over ? 'text-danger' : ''}>{l.variance === 0 ? '—' : `${l.variance > 0 ? '+' : '−'}${formatTRY(Math.abs(l.variance))}`}</span>
        </Td>
        <Td right muted>
          {l.variancePct === undefined ? '—' : `%${l.variancePct.toLocaleString('tr-TR')}`}
        </Td>
      </tr>
    );
  };
  return (
    <>
      <p className="text-small text-muted">
        Onaylı bütçe r{data.budget.revision}
        {data.budget.decision && ` · karar ${data.budget.decision.ref} (${formatDate(data.budget.decision.date)})`}
        {data.throughMonth && ` · karşılaştırma Ocak – ${formatPeriod(data.throughMonth)}`}
      </p>
      <Table
        caption="Bütçe – gerçekleşen"
        note="Giderde pozitif fark bütçe aşımını, gelirde negatif fark beklenenden az geliri gösterir."
        head={
          <tr>
            <Th>Kalem</Th>
            <Th right>Yıllık bütçe</Th>
            <Th right>Bütçe (dönem)</Th>
            <Th right>Gerçekleşen</Th>
            <Th right>Fark</Th>
            <Th right>Sapma</Th>
          </tr>
        }
      >
        {data.lines.filter((l) => l.kind === 'income').map(line)}
        {data.lines.filter((l) => l.kind === 'expense').map(line)}
      </Table>
    </>
  );
}

function AnnualStatement({ data }: { data: ReportData<'annual-statement'> }) {
  const row = (label: string, value: ReactNode, strong = false) => (
    <tr key={label}>
      <Td strong={strong}>{label}</Td>
      <Td right strong={strong}>
        {value}
      </Td>
    </tr>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Table caption="Gelirler" head={<tr><Th>Gelirler</Th><Th right>Tutar</Th></tr>}>
        {data.income.rows.map((r) => row(r.name, dash(r.total)))}
        {row('Toplam gelir', formatTRY(data.income.total), true)}
      </Table>
      <Table caption="Giderler" head={<tr><Th>Giderler</Th><Th right>Tutar</Th></tr>}>
        {data.expense.rows.map((r) => row(r.name, dash(r.total)))}
        {row('Toplam gider', formatTRY(data.expense.total), true)}
      </Table>
      <Table caption="Kasa ve banka" head={<tr><Th>Kasa ve banka</Th><Th right>Yıl sonu</Th></tr>}>
        {data.funds.rows.map((r) => row(r.name, formatTRY(r.closing)))}
        {row(`Toplam (yıl başı ${formatTRY(data.funds.opening)})`, formatTRY(data.funds.closing), true)}
      </Table>
      <Table
        caption="Sonuç ve devir"
        head={<tr><Th>Sonuç ve devir</Th><Th right /></tr>}
        note={data.yearClosed ? 'Yılın tüm ayları kapalı.' : 'Yıl kapanmadı; açık aylar defterden hesaplandı.'}
      >
        {row('Dönem sonucu', <span className={data.result < 0 ? 'text-danger' : ''}>{`${data.result < 0 ? '−' : ''}${formatTRY(Math.abs(data.result))}`}</span>, true)}
        {row('Sakin alacakları (yıl sonu)', formatTRY(data.receivables.closing))}
        {row('Sakin avansları (yıl sonu)', formatTRY(data.receivables.advancesClosing))}
        {(data.supplierAdvances.closing !== 0 || data.supplierAdvances.opening !== 0) &&
          row('Tedarikçilere verilen avans (yıl sonu)', formatTRY(data.supplierAdvances.closing))}
        {row('Tedarikçi borçları (yıl sonu)', formatTRY(data.payables.closing))}
        {data.budget && row('Bütçelenen gelir / gider', `${formatTRY(data.budget.income)} / ${formatTRY(data.budget.expense)}`)}
      </Table>
    </div>
  );
}

function Debtors({ data }: { data: ReportData<'debtors'> }) {
  if (!data.items.length) return <Alert tone="success">Borcu olan bağımsız bölüm yok.</Alert>;
  return (
    <Table
      caption="Borçlu listesi"
      head={
        <tr>
          <Th>Bölüm</Th>
          <Th right>Kat maliki</Th>
          <Th right>Sakin</Th>
          <Th right>Ayrılan cari</Th>
          <Th right>Toplam borç</Th>
          <Th right>Vadesi geçen</Th>
          <Th right>Gecikme taz.</Th>
          <Th right>Gün</Th>
        </tr>
      }
    >
      {data.items.map((i) => (
        <tr key={i.unitId}>
          <Td>{i.label}</Td>
          <Td right>{dash(i.owner)}</Td>
          <Td right>{dash(i.occupant)}</Td>
          <Td right>{dash(i.former)}</Td>
          <Td right strong>
            {formatTRY(i.balance)}
          </Td>
          <Td right>
            <span className={i.overdue > 0 ? 'text-warning' : ''}>{dash(i.overdue)}</span>
          </Td>
          <Td right>{dash(i.lateFee)}</Td>
          <Td right muted>
            {i.daysOverdue || '—'}
          </Td>
        </tr>
      ))}
      <tr className="bg-surface-muted/40">
        <Td strong>{data.totals.count} bölüm</Td>
        <Td />
        <Td />
        <Td />
        <Td right strong>
          {formatTRY(data.totals.balance)}
        </Td>
        <Td right strong>
          {formatTRY(data.totals.overdue)}
        </Td>
        <Td right strong>
          {dash(data.totals.lateFee)}
        </Td>
        <Td />
      </tr>
    </Table>
  );
}

function FundsLedger({ data }: { data: ReportData<'funds-ledger'> }) {
  const rows = useMemo(() => data.rows, [data.rows]);
  return (
    <Table
      caption="Hesap dökümü"
      head={
        <tr>
          <Th>Tarih</Th>
          <Th>Açıklama</Th>
          <Th right>Giriş</Th>
          <Th right>Çıkış</Th>
          <Th right>Bakiye</Th>
        </tr>
      }
    >
      <tr>
        <Td muted>{formatDate(data.from)}</Td>
        <Td muted>Devreden bakiye</Td>
        <Td />
        <Td />
        <Td right>{formatTRY(data.opening)}</Td>
      </tr>
      {rows.map((r) => (
        <tr key={`${r.transactionId}-${r.balance}`}>
          <Td>{formatDate(r.date)}</Td>
          <Td>
            <span className="block max-w-md truncate">{r.description}</span>
          </Td>
          <Td right>{dash(r.in)}</Td>
          <Td right>{dash(r.out)}</Td>
          <Td right>{formatTRY(r.balance)}</Td>
        </tr>
      ))}
      <tr className="bg-surface-muted/40">
        <Td />
        <Td strong>
          Toplam / kapanış <Badge className="ml-1">{rows.length} hareket</Badge>
        </Td>
        <Td right strong>
          {formatTRY(data.totals.in)}
        </Td>
        <Td right strong>
          {formatTRY(data.totals.out)}
        </Td>
        <Td right strong>
          {formatTRY(data.closing)}
        </Td>
      </tr>
    </Table>
  );
}
