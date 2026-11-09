import { FilePlus2, HandCoins, Receipt } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button } from '@/components/ui';
import { useFinancePermissions } from '@/hooks/useFinance';
import { cn } from '@/lib/cn';
import { ChargeDuesDialog } from './ChargeDuesDialog';
import { DuesPanel } from './DuesPanel';
import { ExpenseDialog } from './ExpenseDialog';
import { PaymentDialog, type PaymentPreset } from './PaymentDialog';
import { SummaryCards } from './SummaryCards';
import { TransactionsPanel } from './TransactionsPanel';

const TABS = [
  { id: 'transactions', label: 'Hareketler' },
  { id: 'dues', label: 'Aidat durumu' },
] as const;
type TabId = (typeof TABS)[number]['id'];

type Modal = { kind: 'payment'; preset?: PaymentPreset } | { kind: 'expense' } | { kind: 'charge' } | null;

export function FinancePage() {
  const { canRead, canWrite } = useFinancePermissions();
  const [params, setParams] = useSearchParams();
  const tab: TabId = params.get('tab') === 'dues' ? 'dues' : 'transactions';
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
          <p className="text-small text-muted">Kasa, banka, aidat tahakkuku ve tahsilat takibi.</p>
        </div>
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setModal({ kind: 'charge' })}>
              <FilePlus2 className="size-4" aria-hidden="true" />
              Aidat tahakkuk et
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
        <div role="tablist" aria-label="Finans görünümü" className="flex gap-1 border-b border-border">
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
                '-mb-px border-b-2 border-transparent px-4 py-2 text-small font-medium text-muted hover:text-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                tab === t.id && 'border-accent text-accent',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'transactions' ? (
            <TransactionsPanel />
          ) : (
            <DuesPanel canWrite={canWrite} onCollect={(preset) => setModal({ kind: 'payment', preset })} />
          )}
        </div>
      </div>

      {canWrite && (
        <>
          <PaymentDialog open={modal?.kind === 'payment'} onClose={close} preset={modal?.kind === 'payment' ? modal.preset : null} />
          <ExpenseDialog open={modal?.kind === 'expense'} onClose={close} />
          <ChargeDuesDialog open={modal?.kind === 'charge'} onClose={close} />
        </>
      )}
    </div>
  );
}
