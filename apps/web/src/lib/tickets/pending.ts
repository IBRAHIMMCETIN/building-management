/** Genel Bakis "Bekleyen isler": ariza ve bakim kalemleri (saf). */
export type OpsPendingItem = { code: 'tickets_urgent' | 'tickets_sla' | 'maintenance_overdue'; message: string; count: number; to: string };

export function operationsPending(input: { urgentOpen?: number; slaOverdue?: number; maintenanceOverdue?: number }): OpsPendingItem[] {
  const out: OpsPendingItem[] = [];
  if (input.urgentOpen) out.push({ code: 'tickets_urgent', message: 'Açık acil arıza talebi', count: input.urgentOpen, to: '/admin/tickets' });
  if (input.slaOverdue) out.push({ code: 'tickets_sla', message: 'SLA süresini aşan talep', count: input.slaOverdue, to: '/admin/tickets?tab=list' });
  if (input.maintenanceOverdue) out.push({ code: 'maintenance_overdue', message: 'Geciken periyodik bakım', count: input.maintenanceOverdue, to: '/admin/tickets?tab=calendar' });
  return out;
}
