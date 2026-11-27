import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ChargeInput, type CreateTicketInput, type EstimateInput, type NewCostInput, type TicketListQuery, type UpdateTicketInput, expenseOptionsApi, ticketsApi } from '@/lib/api/tickets';
import type { TransitionAction } from '@/lib/tickets/model';
import type { Role } from '@/types/roles';
import { useAuth } from './useAuth';
import { financeKeys } from './useFinance';

/** API rol listeleriyle ayni (tickets/routes.ts, workcosts/routes.ts, maintenance/routes.ts). */
export const TICKET_READ: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'security_guard', 'observer'];
export const TICKET_MANAGE: readonly Role[] = ['apartment_manager', 'management_company'];
export const TICKET_WRITE: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'security_guard'];
export const MAINTENANCE_READ: readonly Role[] = ['apartment_manager', 'management_company', 'building_staff', 'observer'];
export const COST_READ: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

export function useTicketPermissions() {
  const { user } = useAuth();
  const role = user?.role;
  const has = (list: readonly Role[]) => !!role && list.includes(role);
  return {
    apartmentId: user?.apartmentId ?? '',
    userId: user?.sub ?? '',
    canRead: has(TICKET_READ),
    canCreate: has(TICKET_WRITE),
    canManage: has(TICKET_MANAGE),
    isStaff: role === 'building_staff',
    canSeeBoard: has(MAINTENANCE_READ),
    canReadMaintenance: has(MAINTENANCE_READ),
    canReadCosts: has(COST_READ),
    canWriteCosts: has(TICKET_MANAGE),
    /** Ic not ve fotograf: yonetim + gorevli. */
    canInternal: has(['apartment_manager', 'management_company', 'building_staff']),
  };
}

export const ticketKeys = {
  all: (apt: string) => ['apartment', apt, 'tickets'] as const,
  list: (apt: string, q: TicketListQuery) => ['apartment', apt, 'tickets', 'list', q] as const,
  board: (apt: string) => ['apartment', apt, 'tickets', 'board'] as const,
  detail: (apt: string, id: string) => ['apartment', apt, 'tickets', 'detail', id] as const,
  assignees: (apt: string) => ['apartment', apt, 'tickets', 'assignees'] as const,
  costs: (apt: string, kind: string, id: string) => ['apartment', apt, 'tickets', 'costs', kind, id] as const,
  expenseOptions: (apt: string) => ['apartment', apt, 'tickets', 'expense-options'] as const,
  similar: (apt: string, q: object) => ['apartment', apt, 'tickets', 'similar', q] as const,
};

/** Talep, bakim ve (masrafta) finans onbellegi birlikte tazelenir. */
export function useInvalidateOperations() {
  const qc = useQueryClient();
  const { apartmentId } = useTicketPermissions();
  return (opts: { finance?: boolean } = {}) =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ticketKeys.all(apartmentId) }),
      qc.invalidateQueries({ queryKey: ['apartment', apartmentId, 'maintenance'] }),
      ...(opts.finance ? [qc.invalidateQueries({ queryKey: financeKeys.all(apartmentId) })] : []),
    ]);
}

export function useTicketList(q: TicketListQuery) {
  const { apartmentId, canRead } = useTicketPermissions();
  return useQuery({
    queryKey: ticketKeys.list(apartmentId, q),
    queryFn: ({ signal }) => ticketsApi.list(q, signal),
    enabled: !!apartmentId && canRead,
    placeholderData: keepPreviousData,
  });
}

export function useTicketBoard(enabled = true) {
  const { apartmentId, canSeeBoard } = useTicketPermissions();
  return useQuery({ queryKey: ticketKeys.board(apartmentId), queryFn: ({ signal }) => ticketsApi.board(signal), enabled: enabled && !!apartmentId && canSeeBoard });
}

export function useTicket(id: string | null) {
  const { apartmentId, canRead } = useTicketPermissions();
  return useQuery({ queryKey: ticketKeys.detail(apartmentId, id ?? ''), queryFn: ({ signal }) => ticketsApi.get(id ?? '', signal), enabled: !!apartmentId && canRead && !!id });
}

export function useAssignees() {
  const { apartmentId, canSeeBoard } = useTicketPermissions();
  return useQuery({
    queryKey: ticketKeys.assignees(apartmentId),
    queryFn: ({ signal }) => ticketsApi.assignees(signal).then((r) => r.items),
    enabled: !!apartmentId && canSeeBoard,
    staleTime: 5 * 60_000,
  });
}

export function useCreateTicket() {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: CreateTicketInput) => ticketsApi.create(input), onSuccess: () => invalidate() });
}

export function useUpdateTicket(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: UpdateTicketInput) => ticketsApi.update(id, input), onSuccess: () => invalidate() });
}

/** v2: gorevlinin tahmini tutar notu (bilgi amacli; Finans'a yazilmaz). */
export function useEstimateTicket(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: EstimateInput) => ticketsApi.estimate(id, input), onSuccess: () => invalidate() });
}

export function useAssignTicket(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: { version: number; assigneeId: string | null; note?: string }) => ticketsApi.assign(id, input), onSuccess: () => invalidate() });
}

export function useTransitionTicket(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({
    mutationFn: (input: { version: number; action: TransitionAction; note?: string; photos?: string[] }) => ticketsApi.transition(id, input),
    onSuccess: () => invalidate(),
  });
}

export function useCommentTicket(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: { body: string; visibility: 'public' | 'internal'; photos?: string[] }) => ticketsApi.comment(id, input), onSuccess: () => invalidate() });
}

// --- Masraflar (O1-4) --------------------------------------------------------

export type CostTarget = { kind: 'ticket' | 'maintenance'; id: string };

export function useWorkCosts(target: CostTarget | null, api: { costs: (id: string, signal?: AbortSignal) => ReturnType<typeof ticketsApi.costs> }) {
  const { apartmentId, canReadCosts } = useTicketPermissions();
  return useQuery({
    queryKey: ticketKeys.costs(apartmentId, target?.kind ?? '', target?.id ?? ''),
    queryFn: ({ signal }) => api.costs(target?.id ?? '', signal),
    enabled: !!apartmentId && canReadCosts && !!target,
  });
}

export function useExpenseOptions(enabled: boolean) {
  const { apartmentId, canWriteCosts } = useTicketPermissions();
  return useQuery({ queryKey: ticketKeys.expenseOptions(apartmentId), queryFn: ({ signal }) => expenseOptionsApi.list(signal).then((r) => r.items), enabled: enabled && !!apartmentId && canWriteCosts });
}

type CostApi = {
  addCost: (id: string, input: NewCostInput) => ReturnType<typeof ticketsApi.addCost>;
  unlinkCost: (id: string, expenseId: string, reason: string) => ReturnType<typeof ticketsApi.unlinkCost>;
};

export function useAddCost(id: string, api: CostApi) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: NewCostInput) => api.addCost(id, input), onSuccess: () => invalidate({ finance: true }) });
}

export function useUnlinkCost(id: string, api: CostApi) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (v: { expenseId: string; reason: string }) => api.unlinkCost(id, v.expenseId, v.reason), onSuccess: () => invalidate({ finance: true }) });
}

export function useChargeUnit(id: string) {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: ChargeInput) => ticketsApi.charge(id, input), onSuccess: () => invalidate({ finance: true }) });
}
