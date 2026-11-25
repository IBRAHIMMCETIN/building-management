import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Alert, Button } from '@/components/ui';
import { useTicketPermissions } from '@/hooks/useTickets';
import { cn } from '@/lib/cn';
import { MaintenanceCalendar } from './MaintenanceCalendar';
import { MaintenanceTaskDialog } from './MaintenanceTaskDialog';
import { MaintenanceTemplatesPanel } from './MaintenanceTemplatesPanel';
import { NewTicketDialog } from './NewTicketDialog';
import { TicketBoard } from './TicketBoard';
import { TicketDetailPanel } from './TicketDetailPanel';
import { TicketList } from './TicketList';

const TABS = [
  { id: 'board', label: 'Pano', maintenance: false },
  { id: 'list', label: 'Liste', maintenance: false },
  { id: 'calendar', label: 'Bakım takvimi', maintenance: true },
  { id: 'templates', label: 'Bakım şablonları', maintenance: true },
] as const;
type TabId = (typeof TABS)[number]['id'];

/**
 * Faz 3 (O1-5) "Arıza & Bakım": pano, liste, bakım takvimi ve şablonlar. Talep ayrintisi
 * `?ticket=<id>`, bakim gorevi `?task=<id>` ile acilir (paylasilabilir, geri tusu calisir).
 * Guvenlik gorevlisi panoyu degil yalnizca kendi taleplerinin listesini gorur.
 */
export function TicketsPage() {
  const p = useTicketPermissions();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const tabs = TABS.filter((t) => (t.maintenance ? p.canReadMaintenance : t.id === 'board' ? p.canSeeBoard : true));
  const tab: TabId = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id ?? 'list';
  const ticketId = params.get('ticket');
  const taskId = params.get('task');

  if (!p.canRead) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-title font-bold">Arıza & Bakım</h1>
        <Alert>Bu rol arıza kayıtlarını görüntüleyemez.</Alert>
      </div>
    );
  }

  const set = (next: Record<string, string | null>) => {
    const merged = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) {
      if (v === null) merged.delete(k);
      else merged.set(k, v);
    }
    setParams(merged);
  };
  const openTicket = (id: string) => set({ ticket: id, task: null });
  const openTask = (id: string) => set({ task: id, ticket: null });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-title font-bold">Arıza & Bakım</h1>
          <p className="text-small text-muted">Arıza talepleri, SLA takibi, periyodik bakım takvimi ve masraflar.</p>
        </div>
        {p.canCreate && (
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" aria-hidden="true" />
            Yeni talep
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-4">
        <div role="tablist" aria-label="Arıza ve bakım görünümü" className="flex gap-1 overflow-x-auto border-b border-border">
          {tabs.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              onClick={() => set({ tab: t.id === tabs[0]?.id ? null : t.id })}
              className={cn(
                '-mb-px shrink-0 border-b-2 border-transparent px-4 py-2 text-small font-medium text-muted hover:text-text',
                'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                tab === t.id && 'border-accent text-accent',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {tab === 'board' && <TicketBoard onOpen={openTicket} />}
          {tab === 'list' && <TicketList onOpen={openTicket} />}
          {tab === 'calendar' && <MaintenanceCalendar onOpen={openTask} />}
          {tab === 'templates' && <MaintenanceTemplatesPanel onOpenTask={openTask} />}
        </div>
      </div>

      <TicketDetailPanel ticketId={ticketId} onClose={() => set({ ticket: null })} />
      <MaintenanceTaskDialog taskId={taskId} onClose={() => set({ task: null })} onOpenTicket={openTicket} />
      <NewTicketDialog open={creating} onClose={() => setCreating(false)} onCreated={openTicket} />
    </div>
  );
}
