import { ArrowLeftRight, CalendarRange, ChevronRight, FilePlus2, HandCoins, Receipt } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button } from '@/components/ui';
import { useFinancePermissions } from '@/hooks/useFinance';
import { cn } from '@/lib/cn';
import { BankPanel } from './bank/BankPanel';
import { ChargeDuesDialog } from './ChargeDuesDialog';
import { DuesPanel } from './DuesPanel';
import { ExpenseDialog } from './ExpenseDialog';
import { FormerAccountsPanel } from './FormerAccountsPanel';
import { OffsetDialog } from './OffsetDialog';
import { OnlinePaymentsPanel } from './OnlinePaymentsPanel';
import { OwnershipPanel } from './OwnershipPanel';
import { PayablesPanel } from './PayablesPanel';
import { PaymentDialog, type PaymentPreset } from './PaymentDialog';
import { PeriodClosingPanel } from './PeriodClosingPanel';
import { PlansPanel } from './PlansPanel';
import { ReportsPanel } from './ReportsPanel';
import { BudgetPanel } from './BudgetPanel';
import { RestructureWizard } from './RestructureWizard';
import { SummaryCards } from './SummaryCards';
import { TransactionsPanel } from './TransactionsPanel';

const TABS = [
  { id: 'transactions', label: 'Hareketler' },
  { id: 'dues', label: 'Aidat durumu' },
  { id: 'former', label: 'Ayrılan cariler' },
  { id: 'ownership', label: 'Paydaşlar / hisse' },
  { id: 'plans', label: 'Taksit planları' },
  { id: 'online', label: 'Online ödemeler' },
  { id: 'bank', label: 'Banka' },
  { id: 'payables', label: 'Tedarikçiler' },
  // Finans 2.4: raporlar, butce / isletme projesi, donem kapanisi (/admin/finance?tab=closing).
  { id: 'reports', label: 'Raporlar' },
  { id: 'budget', label: 'Bütçe' },
  { id: 'closing', label: 'Dönem kapanışı' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Modal = { kind: 'payment'; preset?: PaymentPreset } | { kind: 'expense' } | { kind: 'charge' } | { kind: 'offset' } | { kind: 'restructure' } | null;

export function FinancePage() {
  const { canRead, canWrite } = useFinancePermissions();
  const [params, setParams] = useSearchParams();
  const tab: TabId = TABS.find((t) => t.id === params.get('tab'))?.id ?? 'transactions';
  const [modal, setModal] = useState<Modal>(null);

  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Finans</h1>
        <Alert>Bu rol finans kayıtlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  const selectTab = (id: TabId) => setParams(id === 'transactions' ? {} : { tab: id }, { replace: true });
  const close = () => setModal(null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Finans</h1>
          <p className="text-small text-muted">Kasa, banka, aidat tahakkuku, tahsilat, avans mahsubu ve borç yapılandırma.</p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal({ kind: 'charge' })}>
              <FilePlus2 className="size-4" aria-hidden="true" />
              Aidat tahakkuk et
            </Button>
            <Button variant="secondary" onClick={() => setModal({ kind: 'offset' })}>
              <ArrowLeftRight className="size-4" aria-hidden="true" />
              Avans mahsubu
            </Button>
            <Button variant="secondary" onClick={() => setModal({ kind: 'restructure' })}>
              <CalendarRange className="size-4" aria-hidden="true" />
              Borç yapılandır
            </Button>
            <Button variant="secondary" onClick={() => setModal({ kind: 'expense' })}>
              <Receipt className="size-4" aria-hidden="true" />
              Gider ekle
            </Button>
            <Button onClick={() => setModal({ kind: 'payment' })}>
              <HandCoins className="size-4" aria-hidden="true" />
              Tahsilat ekle
            </Button>
          </div>
        )}
      </div>

      <SummaryCards />

      <div className="flex flex-col gap-4">
        <ScrollableTabs activeId={tab}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => selectTab(t.id)}
              className={cn(
                'border-b-2 border-transparent px-4 py-2 text-small font-medium text-muted hover:text-text',
                'shrink-0 whitespace-nowrap focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
                tab === t.id && 'border-accent text-accent',
              )}
            >
              {t.label}
            </button>
          ))}
        </ScrollableTabs>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'transactions' && <TransactionsPanel />}
          {tab === 'dues' && <DuesPanel canWrite={canWrite} onCollect={(preset) => setModal({ kind: 'payment', preset })} />}
          {tab === 'former' && <FormerAccountsPanel canWrite={canWrite} onCollect={(preset) => setModal({ kind: 'payment', preset })} />}
          {tab === 'ownership' && <OwnershipPanel canWrite={canWrite} onCollect={(preset) => setModal({ kind: 'payment', preset })} />}
          {tab === 'plans' && <PlansPanel canWrite={canWrite} />}
          {tab === 'online' && <OnlinePaymentsPanel />}
          {tab === 'bank' && <BankPanel canWrite={canWrite} />}
          {tab === 'payables' && <PayablesPanel canWrite={canWrite} />}
          {tab === 'reports' && <ReportsPanel />}
          {tab === 'budget' && <BudgetPanel canWrite={canWrite} />}
          {tab === 'closing' && <PeriodClosingPanel canWrite={canWrite} />}
        </div>
      </div>

      {canWrite && (
        <>
          <PaymentDialog open={modal?.kind === 'payment'} onClose={close} preset={modal?.kind === 'payment' ? modal.preset : null} />
          <ExpenseDialog open={modal?.kind === 'expense'} onClose={close} />
          <ChargeDuesDialog open={modal?.kind === 'charge'} onClose={close} />
          <OffsetDialog open={modal?.kind === 'offset'} onClose={close} />
          <RestructureWizard open={modal?.kind === 'restructure'} onClose={close} />
        </>
      )}
    </div>
  );
}

/**
 * UX-11: dar ekranda saga tasan sekmeler icin yatay kaydirma + sag kenarda gradyan ve ok
 * gostergesi (daha fazla sekme oldugunu belli eder). Aktif sekme gorunur alana kaydirilir.
 */
function ScrollableTabs({ activeId, children }: { activeId: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  useEffect(() => {
    const active = ref.current?.querySelector<HTMLElement>(`#tab-${activeId}`);
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    measure();
  }, [activeId, measure]);

  return (
    <div className="relative">
      {/* Alt cizgi kaydirilan kutunun ic golgesi: aktif sekmenin alt cizgisi uzerine biner, dikey kaydirma cikmaz. */}
      <div
        ref={ref}
        role="tablist"
        aria-label="Finans görünümü"
        className="flex gap-1 overflow-x-auto overflow-y-hidden shadow-[inset_0_-1px_0_var(--color-border)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {edges.left && <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-linear-to-r from-bg to-transparent" />}
      {edges.right && (
        <div className="absolute inset-y-0 right-0 flex items-center bg-linear-to-l from-bg via-bg/90 to-transparent pl-8">
          <button
            type="button"
            aria-label="Diğer sekmeler"
            onClick={() => ref.current?.scrollBy({ left: ref.current.clientWidth * 0.6, behavior: 'smooth' })}
            className="rounded-full p-1 text-muted hover:bg-surface-muted hover:text-text"
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
