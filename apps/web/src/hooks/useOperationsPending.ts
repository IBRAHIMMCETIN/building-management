import { operationsPending } from '@/lib/tickets/pending';
import { useMaintenanceTasks } from './useMaintenance';
import { useTicketBoard, useTicketPermissions } from './useTickets';

/**
 * Genel Bakis bekleyen isleri (O1-5): acil acik talepler, SLA asanlar, geciken bakimlar.
 * Gorevlide API gorunurlugu (kendi + havuz) uygulanir.
 */
export function useOperationsPending() {
  const { canSeeBoard } = useTicketPermissions();
  const board = useTicketBoard(canSeeBoard);
  const overdue = useMaintenanceTasks({ status: 'open', overdue: 'true' }, canSeeBoard);
  return {
    enabled: canSeeBoard,
    isPending: canSeeBoard && (board.isPending || overdue.isPending),
    items: operationsPending({ urgentOpen: board.data?.urgentOpenCount, slaOverdue: board.data?.overdueCount, maintenanceOverdue: overdue.data?.length }),
  };
}
