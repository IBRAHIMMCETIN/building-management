import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type PortalCreateTicketInput, portalTicketsApi } from '@/lib/api/portalTickets';
import { useAuth } from './useAuth';
import { portalKeys } from './usePortal';

function useScope() {
  const { user } = useAuth();
  return { apt: user?.apartmentId ?? '', userId: user?.sub ?? '', enabled: user?.role === 'resident' && !!user.apartmentId };
}

export const portalTicketKeys = {
  all: (apt: string, user: string) => [...portalKeys.all(apt, user), 'tickets'] as const,
  list: (apt: string, user: string, status: string) => [...portalKeys.all(apt, user), 'tickets', 'list', status] as const,
  detail: (apt: string, user: string, id: string) => [...portalKeys.all(apt, user), 'tickets', 'detail', id] as const,
  similar: (apt: string, user: string, category: string) => [...portalKeys.all(apt, user), 'tickets', 'similar', category] as const,
};

export function useMyTickets(status: string) {
  const { apt, userId, enabled } = useScope();
  return useQuery({ queryKey: portalTicketKeys.list(apt, userId, status), queryFn: ({ signal }) => portalTicketsApi.list(status, signal), enabled });
}

export function useMyTicket(id: string | undefined) {
  const { apt, userId, enabled } = useScope();
  return useQuery({ queryKey: portalTicketKeys.detail(apt, userId, id ?? ''), queryFn: ({ signal }) => portalTicketsApi.get(id ?? '', signal), enabled: enabled && !!id });
}

/** Ortak alanda benzer acik talep uyarisi (kategori secilince). */
export function useSimilarTickets(category: string | null) {
  const { apt, userId, enabled } = useScope();
  return useQuery({
    queryKey: portalTicketKeys.similar(apt, userId, category ?? ''),
    queryFn: ({ signal }) => portalTicketsApi.similar(category ?? '', signal).then((r) => r.items),
    enabled: enabled && !!category,
    staleTime: 60_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  const { apt, userId } = useScope();
  return () => qc.invalidateQueries({ queryKey: portalTicketKeys.all(apt, userId) });
}

export function useCreateMyTicket() {
  const invalidate = useInvalidate();
  return useMutation({ mutationFn: (input: PortalCreateTicketInput) => portalTicketsApi.create(input), onSuccess: invalidate });
}

export function useMyTicketActions(id: string) {
  const invalidate = useInvalidate();
  const opts = { onSuccess: invalidate };
  return {
    comment: useMutation({ mutationFn: (v: { body: string; photos?: string[] }) => portalTicketsApi.comment(id, v), ...opts }),
    confirm: useMutation({ mutationFn: (v: { version: number; rating?: number; note?: string }) => portalTicketsApi.confirm(id, v), ...opts }),
    reopen: useMutation({ mutationFn: (v: { version: number; note: string }) => portalTicketsApi.reopen(id, v), ...opts }),
    cancel: useMutation({ mutationFn: (v: { version: number }) => portalTicketsApi.cancel(id, v), ...opts }),
  };
}
