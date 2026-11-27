import { ArrowRight, Briefcase, Search } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, FilterChips, Input, Kpi, Select, Skeleton } from '@/components/ui';
import { useAuth } from '@/hooks/useAuth';
import { type OpenTarget, useOpenApartment, usePortfolio, usePortfolioAccess } from '@/hooks/usePortfolio';
import { errorMessage } from '@/lib/api/errors';
import { formatPeriod } from '@/lib/api/financePeriods';
import {
  type PortfolioCard,
  type PortfolioFilter,
  type PortfolioSort,
  type PortfolioTotals,
  SECTION_LABELS,
  filterCards,
  mergePages,
  needsAttention,
  sortCards,
} from '@/lib/api/portfolio';
import { formatDate, formatDateTime } from '@/lib/dates';
import { formatTRY } from '@/lib/money';
import { ROLE_LABELS } from '@/types/roles';

const SORTS: readonly { value: PortfolioSort; label: string }[] = [
  { value: 'name', label: 'Ada göre (A–Z)' },
  { value: 'collection', label: 'Tahsilat oranı (düşük önce)' },
  { value: 'overdue', label: 'Vadesi geçmiş alacak (yüksek önce)' },
  { value: 'tickets', label: 'Açık talep (çok önce)' },
];

/** Karttan acilan apartman ekranlari (hepsi portfoy rollerine, denetci dahil, aciktir). */
const SCREENS = {
  overview: '/admin',
  dues: '/admin/finance?tab=dues',
  tickets: '/admin/tickets',
  maintenance: '/admin/tickets?tab=calendar',
  equipment: '/admin/equipment',
  assemblies: '/admin/assemblies',
  polls: '/admin/polls',
  tenders: '/admin/tenders',
} as const;

const pct = (n: number) => `%${n.toLocaleString('tr-TR')}`;

/**
 * Yonetim firmasi portfoyu: kullanicinin yonettigi / denetledigi apartmanlarin ozeti. Yalnizca
 * toplamlar gosterilir (sakin bilgisi yok); bir apartmanin ekranina gecis mevcut baglam secimiyle.
 */
export function PortfolioPage() {
  const { support } = useAuth();
  const { roleAllowed } = usePortfolioAccess();
  const portfolio = usePortfolio();
  const open = useOpenApartment();
  const [filter, setFilter] = useState<PortfolioFilter>('all');
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<PortfolioSort>('name');

  const merged = useMemo(() => mergePages(portfolio.data?.pages ?? []), [portfolio.data]);
  const first = portfolio.data?.pages[0];

  if (!roleAllowed) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Portföy</h1>
        <Alert>{support ? 'Destek oturumunda yönetim portföyü açılamaz; destek erişimi tek apartmanla sınırlıdır.' : 'Bu rol yönetim portföyünü görüntüleyemez.'}</Alert>
      </div>
    );
  }

  const header = (
    <div>
      <h1 className="text-title font-bold">Portföy</h1>
      <p className="text-small text-muted">Yönettiğiniz ve denetlediğiniz apartmanların özeti. Bir apartmanın ekranına geçmek için satırdaki bağlantıları kullanın.</p>
    </div>
  );

  if (portfolio.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <div role="status" aria-label="Portföy yükleniyor" className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-24" />
            ))}
          </div>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-16 w-full" />
          ))}
        </div>
      </div>
    );
  }

  if (portfolio.isError) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card className="flex flex-col items-start gap-3">
          <Alert tone="danger">{errorMessage(portfolio.error)}</Alert>
          <Button variant="secondary" onClick={() => void portfolio.refetch()}>
            Tekrar dene
          </Button>
        </Card>
      </div>
    );
  }

  if (merged.total === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <Card className="flex flex-col items-center gap-3 py-10 text-center">
          <div className="grid size-12 place-items-center rounded-full bg-surface-muted text-accent">
            <Briefcase className="size-6" aria-hidden="true" />
          </div>
          <p className="font-semibold">Portföyünüzde apartman yok</p>
          <p className="max-w-content text-small text-muted">Yönetici, yönetim firması veya denetçi olduğunuz apartmanlar burada listelenir.</p>
        </Card>
      </div>
    );
  }

  const { items, total, totals } = merged;
  const loaded = items.length;
  const attention = items.filter(needsAttention).length;
  const incomplete = items.filter((c) => c.status !== 'ok').length;
  const shown = sortCards(filterCards(items, filter, q), sort);
  const filters: { value: PortfolioFilter; label: string; count: number }[] = [
    { value: 'all', label: 'Tümü', count: loaded },
    { value: 'attention', label: 'Dikkat gerektiren', count: attention },
    ...(incomplete > 0 || filter === 'incomplete' ? [{ value: 'incomplete' as const, label: 'Eksik veri', count: incomplete }] : []),
  ];
  const go = (target: OpenTarget) => {
    if (!open.isPending) open.mutate(target);
  };
  const pendingKey = open.isPending && open.variables ? `${open.variables.apartmentId}|${open.variables.to}` : null;

  return (
    <div className="flex flex-col gap-6">
      {header}

      <div className="flex flex-col gap-4">
        <p className="text-small text-muted">
          {total} apartman · {totals.unitCount.toLocaleString('tr-TR')} bağımsız bölüm · {first ? formatDate(first.asOf) : ''} itibarıyla
          {loaded < total && <> · toplamlar yüklenen {loaded} apartman içindir</>}
        </p>
        <TotalsStrip totals={totals} period={first?.period} />
      </div>

      {totals.incompleteCount > 0 && (
        <Alert>
          {totals.incompleteCount} apartmanın bazı verileri okunamadı; toplamlar bu bölümler olmadan hesaplandı. İlgili satırlar «Eksik veri» ile işaretlendi.
        </Alert>
      )}
      {open.isError && <Alert tone="danger">{errorMessage(open.error)}</Alert>}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <FilterChips<PortfolioFilter> label="Apartman filtresi" value={filter} onChange={setFilter} options={filters} />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative w-full sm:w-64">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input type="search" aria-label="Apartman ara" placeholder="Apartman adı…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" />
          </div>
          <label className="flex items-center gap-2 text-small sm:w-72">
            <span className="shrink-0 text-muted">Sırala</span>
            <Select value={sort} onChange={(e) => setSort(e.target.value as PortfolioSort)}>
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-small text-muted">Bu filtreye uyan apartman yok.</p>
      ) : (
        <ApartmentList items={shown} onOpen={go} pendingKey={pendingKey} disabled={open.isPending} />
      )}

      {portfolio.hasNextPage && (
        <Button variant="secondary" className="self-center" loading={portfolio.isFetchingNextPage} onClick={() => void portfolio.fetchNextPage()}>
          Daha fazla yükle
        </Button>
      )}
    </div>
  );
}

function TotalsStrip({ totals: t, period }: { totals: PortfolioTotals; period?: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Kpi
        label={`${period ? formatPeriod(period) : 'Bu ay'} tahsilat`}
        value={t.collectionRatePct === undefined ? formatTRY(t.collected) : pct(t.collectionRatePct)}
        detail={`Tahakkuk ${formatTRY(t.charged)} · tahsil ${formatTRY(t.collected)}`}
      />
      <Kpi
        label="Vadesi geçmiş alacak"
        value={formatTRY(t.overdue)}
        detail={t.overdue > 0 ? `${t.overdueUnitCount} bölüm · toplam alacak ${formatTRY(t.receivables)}` : 'Vadesi geçen borç yok'}
        warn={t.overdue > 0}
      />
      <Kpi label="Kasa + banka" value={formatTRY(t.totalFunds)} detail={`Kasa ${formatTRY(t.cash)} · Banka ${formatTRY(t.bank)}`} />
      <Kpi
        label="Açık talep"
        value={String(t.openTickets)}
        detail={`${t.urgentTickets} acil · ${t.ticketSlaBreaches} SLA aşımı`}
        warn={t.ticketSlaBreaches > 0}
      />
      <Kpi label="Bakım görevi" value={`${t.maintenanceOverdue} geciken`} detail={`${t.maintenanceDueThisWeek} görev 7 gün içinde`} warn={t.maintenanceOverdue > 0} />
      <Kpi label="Ekipman son tarihleri" value={String(t.equipmentExpiring)} detail="Garanti, sözleşme ve kontrol · 30 gün içinde" />
      <Kpi label="Yaklaşan genel kurul" value={String(t.upcomingAssemblies)} detail={`${t.openPolls} açık oylama`} />
      <Kpi label="Açık ihale" value={String(t.openTenders)} detail="Taslak, teklif toplama veya yayında" />
    </div>
  );
}

type ListProps = { items: PortfolioCard[]; onOpen: (t: OpenTarget) => void; pendingKey: string | null; disabled: boolean };
type DrillProps = Omit<ListProps, 'items'> & { align: 'left' | 'right' };

/**
 * Hucredeki deger: tiklaninca o apartmanin ilgili ekrani acilir (baglam degisir). Erisilebilir ad
 * gorunen degerle baslar (WCAG 2.5.3); apartman ve ekran yalnizca ekran okuyucuya sonuna eklenir.
 */
function Drill({ card, to, label, onOpen, pendingKey, disabled, align, children }: { card: PortfolioCard; to: string; label: string; children: ReactNode } & DrillProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-busy={pendingKey === `${card.apartmentId}|${to}` || undefined}
      onClick={() => onOpen({ apartmentId: card.apartmentId, role: card.role, to })}
      className={`rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50 ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      {children}
      <span className="sr-only">
        {' '}
        ({card.apartmentName}, {label})
      </span>
    </button>
  );
}

const Missing = () => (
  <span className="text-muted">
    —<span className="sr-only"> okunamadı</span>
  </span>
);

function CardMarks({ card, end = false }: { card: PortfolioCard; end?: boolean }) {
  return (
    <span className={`flex flex-wrap items-center gap-1.5 ${end ? 'justify-end' : ''}`}>
      <Badge>{ROLE_LABELS[card.role]}</Badge>
      {card.readOnly && <Badge tone="accent">Salt okunur</Badge>}
      {card.status === 'partial' && <Badge tone="warning">Eksik veri</Badge>}
      {card.status === 'error' && <Badge tone="danger">Okunamadı</Badge>}
    </span>
  );
}

function FailedNote({ card }: { card: PortfolioCard }) {
  if (card.status !== 'partial') return null;
  return <span className="block font-normal text-small text-muted">Okunamayan: {card.failed.map((s) => SECTION_LABELS[s]).join(', ')}</span>;
}

/**
 * Hucre icerikleri: masaustu tablo ve mobil kart ayni metinleri kullanir. Tutar sutunlari her
 * gorunumde saga hizalidir (aile tablolari gibi); sayi / metin sutunlari tabloda sola.
 */
function cells(c: PortfolioCard, p: DrillProps) {
  const d = (to: string, label: string, children: ReactNode, align: DrillProps['align'] = p.align) => (
    <Drill card={c} to={to} label={label} {...p} align={align}>
      {children}
    </Drill>
  );
  return {
    collection: c.collection
      ? d(
          SCREENS.dues,
          'aidat durumu',
          <>
            <span className="font-medium tabular-nums">{c.collection.collectionRatePct === undefined ? '—' : pct(c.collection.collectionRatePct)}</span>
            <span className="block text-small text-muted tabular-nums">
              {formatTRY(c.collection.collected)} / {formatTRY(c.collection.charged)}
            </span>
          </>,
          'right',
        )
      : <Missing />,
    overdue: c.finance
      ? d(
          SCREENS.dues,
          'vadesi geçmiş alacak',
          <>
            <span className={`font-medium tabular-nums ${c.finance.overdue > 0 ? 'text-warning' : ''}`}>{formatTRY(c.finance.overdue)}</span>
            {c.finance.overdueUnitCount > 0 && <span className="block text-small text-muted">{c.finance.overdueUnitCount} bölüm</span>}
          </>,
          'right',
        )
      : <Missing />,
    funds: c.finance ? <span className="tabular-nums">{formatTRY(c.finance.totalFunds)}</span> : <Missing />,
    tickets: c.tickets
      ? d(
          SCREENS.tickets,
          'açık talepler',
          <>
            <span className="font-medium tabular-nums">{c.tickets.openCount} açık</span>
            <span className="block text-small text-muted">
              {c.tickets.openByPriority.urgent} acil ·{' '}
              <span className={c.tickets.overdueCount > 0 ? 'text-danger' : undefined}>{c.tickets.overdueCount} SLA aşımı</span>
            </span>
          </>,
        )
      : <Missing />,
    maintenance: c.maintenance
      ? d(
          SCREENS.maintenance,
          'bakım takvimi',
          <>
            <span className={`font-medium tabular-nums ${c.maintenance.overdueCount > 0 ? 'text-warning' : ''}`}>{c.maintenance.overdueCount} geciken</span>
            <span className="block text-small text-muted">{c.maintenance.dueThisWeekCount} bu hafta</span>
          </>,
        )
      : <Missing />,
    upcoming: (
      <span className={`flex flex-col gap-0.5 ${p.align === 'right' ? 'items-end' : 'items-start'}`}>
        {c.equipment ? d(SCREENS.equipment, 'ekipman son tarihleri', <>{c.equipment.expiringCount} ekipman son tarihi</>) : <Missing />}
        {c.assemblies
          ? d(SCREENS.assemblies, 'genel kurul', <>{c.assemblies.nextAt ? `Genel kurul ${formatDateTime(c.assemblies.nextAt)}` : `${c.assemblies.upcomingCount} genel kurul`}</>)
          : <Missing />}
        {c.polls ? d(SCREENS.polls, 'oylamalar', <>{c.polls.openCount} açık oylama</>) : <Missing />}
        {c.tenders ? d(SCREENS.tenders, 'ihaleler', <>{c.tenders.openCount} açık ihale</>) : <Missing />}
      </span>
    ),
  };
}

function OpenButton({ card, onOpen, pendingKey, disabled, full = false }: { card: PortfolioCard; full?: boolean } & Omit<ListProps, 'items'>) {
  return (
    <Button
      variant={full ? 'secondary' : 'ghost'}
      size="sm"
      className={full ? 'mt-3 w-full' : undefined}
      disabled={disabled}
      loading={pendingKey === `${card.apartmentId}|${SCREENS.overview}`}
      aria-label={`${card.apartmentName} Genel Bakış ekranını aç`}
      onClick={() => onOpen({ apartmentId: card.apartmentId, role: card.role, to: SCREENS.overview })}
    >
      <span className={full ? undefined : 'hidden lg:inline'}>Genel Bakış</span>
      <ArrowRight className="size-4" aria-hidden="true" />
    </Button>
  );
}

function ApartmentList({ items, ...p }: ListProps) {
  const rows = items.map((c) => ({ c, x: cells(c, { ...p, align: 'left' }), m: cells(c, { ...p, align: 'right' }) }));
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border bg-surface/60 shadow-sm backdrop-blur-sm md:block">
        <table className="w-full text-left text-small">
          <caption className="sr-only">Apartman bazlı portföy özeti</caption>
          <thead className="border-b border-border bg-surface-muted/50 text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Apartman</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Tahsilat</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Vadesi geçmiş</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">Kasa + banka</th>
              <th scope="col" className="px-4 py-3 font-medium">Talepler</th>
              <th scope="col" className="px-4 py-3 font-medium">Bakım</th>
              <th scope="col" className="px-4 py-3 font-medium">Yaklaşan</th>
              <th scope="col" className="px-4 py-3">
                <span className="sr-only">İşlemler</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border text-text-secondary [&>tr]:transition-colors [&>tr:hover]:bg-surface-muted/40">
            {rows.map(({ c, x }) => (
              <tr key={c.apartmentId} className="align-top">
                <th scope="row" className="px-4 py-3 font-semibold">
                  {c.apartmentName}
                  <span className="mt-1 block font-normal">
                    <CardMarks card={c} />
                  </span>
                  <FailedNote card={c} />
                  {c.units && <span className="block font-normal text-small text-muted">{c.units.count} bağımsız bölüm</span>}
                </th>
                <td className="px-4 py-3 text-right">{x.collection}</td>
                <td className="px-4 py-3 text-right">{x.overdue}</td>
                <td className="px-4 py-3 text-right">{x.funds}</td>
                <td className="px-4 py-3">{x.tickets}</td>
                <td className="px-4 py-3">{x.maintenance}</td>
                <td className="px-4 py-3">{x.upcoming}</td>
                <td className="px-4 py-2.5 text-right">
                  <OpenButton card={c} {...p} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="flex flex-col gap-3 md:hidden" aria-label="Portföydeki apartmanlar">
        {rows.map(({ c, m }) => (
          <li key={c.apartmentId} className="rounded-xl border border-border bg-surface/60 p-5 shadow-sm backdrop-blur-sm transition-colors hover:border-border-strong">
            <div className="flex items-start justify-between gap-3">
              <p className="font-semibold">{c.apartmentName}</p>
              <CardMarks card={c} end />
            </div>
            <FailedNote card={c} />
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
              <dt className="text-muted">Tahsilat</dt>
              <dd className="text-right">{m.collection}</dd>
              <dt className="text-muted">Vadesi geçmiş</dt>
              <dd className="text-right">{m.overdue}</dd>
              <dt className="text-muted">Kasa + banka</dt>
              <dd className="text-right">{m.funds}</dd>
              <dt className="text-muted">Talepler</dt>
              <dd className="text-right">{m.tickets}</dd>
              <dt className="text-muted">Bakım</dt>
              <dd className="text-right">{m.maintenance}</dd>
              <dt className="text-muted">Yaklaşan</dt>
              <dd className="flex justify-end text-right">{m.upcoming}</dd>
            </dl>
            <OpenButton card={c} full {...p} />
          </li>
        ))}
      </ul>
    </>
  );
}
