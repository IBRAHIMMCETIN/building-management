import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { type CompleteTaskInput, type TemplateInput, maintenanceApi } from '@/lib/api/maintenance';
import type { EstimateInput } from '@/lib/api/tickets';
import type { TicketPriority } from '@/lib/tickets/model';
import { useInvalidateOperations, useTicketPermissions } from './useTickets';

export const maintenanceKeys = {
  all: (apt: string) => ['apartment', apt, 'maintenance'] as const,
  presets: (apt: string) => ['apartment', apt, 'maintenance', 'presets'] as const,
  templates: (apt: string, status: string) => ['apartment', apt, 'maintenance', 'templates', status] as const,
  tasks: (apt: string, q: object) => ['apartment', apt, 'maintenance', 'tasks', q] as const,
  calendar: (apt: string, month: string) => ['apartment', apt, 'maintenance', 'calendar', month] as const,
  task: (apt: string, id: string) => ['apartment', apt, 'maintenance', 'task', id] as const,
};

function useEnabled() {
  const { apartmentId, canReadMaintenance } = useTicketPermissions();
  return { apartmentId, enabled: !!apartmentId && canReadMaintenance };
}

export function useMaintenancePresets() {
  const { apartmentId, enabled } = useEnabled();
  return useQuery({ queryKey: maintenanceKeys.presets(apartmentId), queryFn: ({ signal }) => maintenanceApi.presets(signal).then((r) => r.items), enabled, staleTime: Infinity });
}

export function useMaintenanceTemplates(status: 'active' | 'archived' | 'all' = 'active') {
  const { apartmentId, enabled } = useEnabled();
  return useQuery({ queryKey: maintenanceKeys.templates(apartmentId, status), queryFn: ({ signal }) => maintenanceApi.templates(status, signal).then((r) => r.items), enabled });
}

export function useMaintenanceTasks(q: { from?: string; to?: string; status?: string; assignee?: string; overdue?: 'true' }, enabled = true) {
  const { apartmentId, enabled: ok } = useEnabled();
  return useQuery({ queryKey: maintenanceKeys.tasks(apartmentId, q), queryFn: ({ signal }) => maintenanceApi.tasks(q, signal).then((r) => r.items), enabled: ok && enabled });
}

export function useMaintenanceCalendar(month: string) {
  const { apartmentId, enabled } = useEnabled();
  return useQuery({ queryKey: maintenanceKeys.calendar(apartmentId, month), queryFn: ({ signal }) => maintenanceApi.calendar(month, signal), enabled, placeholderData: keepPreviousData });
}

export function useMaintenanceTask(id: string | null) {
  const { apartmentId, enabled } = useEnabled();
  return useQuery({ queryKey: maintenanceKeys.task(apartmentId, id ?? ''), queryFn: ({ signal }) => maintenanceApi.task(id ?? '', signal).then((r) => r.task), enabled: enabled && !!id });
}

export function useCreateMaintenanceTemplate() {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (input: TemplateInput) => maintenanceApi.createTemplate(input), onSuccess: () => invalidate() });
}

export function useUpdateMaintenanceTemplate() {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (v: { id: string; input: TemplateInput & { version: number } }) => maintenanceApi.updateTemplate(v.id, v.input), onSuccess: () => invalidate() });
}

export function useArchiveMaintenanceTemplate() {
  const invalidate = useInvalidateOperations();
  return useMutation({ mutationFn: (v: { id: string; version: number }) => maintenanceApi.archiveTemplate(v.id, v.version), onSuccess: () => invalidate() });
}

export function useTaskActions(id: string) {
  const invalidate = useInvalidateOperations();
  const opts = { onSuccess: () => invalidate() };
  return {
    assign: useMutation({ mutationFn: (v: { version: number; assigneeId: string | null }) => maintenanceApi.assign(id, v), ...opts }),
    start: useMutation({ mutationFn: (version: number) => maintenanceApi.start(id, version), ...opts }),
    complete: useMutation({ mutationFn: (input: CompleteTaskInput) => maintenanceApi.complete(id, input), ...opts }),
    skip: useMutation({ mutationFn: (v: { version: number; reason: string }) => maintenanceApi.skip(id, v), ...opts }),
    estimate: useMutation({ mutationFn: (v: EstimateInput) => maintenanceApi.estimate(id, v), ...opts }),
    openTicket: useMutation({
      mutationFn: (v: { idempotencyKey: string; title?: string; description?: string; priority?: TicketPriority; photos?: string[] }) => maintenanceApi.openTicket(id, v),
      ...opts,
    }),
  };
}
