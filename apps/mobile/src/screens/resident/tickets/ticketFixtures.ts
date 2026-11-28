/** Talep ekrani testleri icin API yanit ornekleri (sozlesme @bm/shared/api/portalTickets ile ayni). */

export const portalTicket = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  ticketId: id,
  number: `T-${id}`,
  title: `Talep ${id}`,
  description: 'Banyo tavanından su damlıyor.',
  category: 'plumbing',
  priority: 'normal',
  location: { kind: 'unit', unitId: 'u-3' },
  status,
  source: 'portal',
  createdAt: '2026-11-25T08:00:00.000Z',
  dueAt: '2026-11-30T08:00:00.000Z',
  assigned: status !== 'open',
  actions: [] as string[],
  version: 3,
  ...over,
});

export const ticketEvents = [
  { eventId: 'e1', kind: 'created', visibility: 'public', at: '2026-11-25T08:00:00.000Z', mine: true, byRole: 'resident' },
  {
    eventId: 'e2',
    kind: 'status_changed',
    visibility: 'public',
    at: '2026-11-27T10:00:00.000Z',
    byRole: 'building_staff',
    from: 'in_progress',
    to: 'resolved',
    body: 'Conta değiştirildi.',
    photoKeys: ['apartments/a/tickets/t/abc.jpg'],
  },
];

export const ticketSummary = {
  unitId: 'u-3',
  unitLabel: 'A Blok · Daire 3',
  relationLabel: 'Malik',
  asOf: '2026-11-28T09:00:00.000Z',
  status: 'no_debt',
  balance: 0,
  debt: 0,
  advance: 0,
  totalCharged: 0,
  totalPaid: 0,
  overdueAmount: 0,
  accruedLateFee: 0,
  daysOverdue: 0,
  openCount: 0,
};
