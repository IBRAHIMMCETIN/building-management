/** API yanit ornekleri (sozlesme @bm/shared zod semalariyla ayni). */

export const summary = (over: Record<string, unknown> = {}) => ({
  unitId: 'u-3',
  unitLabel: 'A Blok · Daire 3',
  relationLabel: 'Malik',
  asOf: '2026-11-28T09:00:00.000Z',
  status: 'overdue',
  balance: 300000,
  debt: 300000,
  advance: 0,
  totalCharged: 2100000,
  totalPaid: 1800000,
  overdueAmount: 150000,
  accruedLateFee: 7350,
  oldestOverdueDueDate: '2026-10-10',
  daysOverdue: 49,
  openCount: 2,
  nextDue: { dueDate: '2026-12-10', amount: 150000, description: 'Aralık aidatı' },
  lastPayment: { paidAt: '2026-09-07', amount: 150000, receiptNumber: 'MKB-2026-0138' },
  ...over,
});

/** `count` satirli malik carisi: tahakkuk ve tahsilat donusumlu, en eski once (API sirasi). */
export const statement = (count: number) => {
  const entries = Array.from({ length: count }, (_, i) => {
    const collection = i % 2 === 1;
    const day = String((i % 27) + 1).padStart(2, '0');
    const month = String(Math.floor(i / 27) + 1).padStart(2, '0');
    return {
      date: `2025-${month}-${day}`,
      transactionId: `tx-${String(i).padStart(3, '0')}`,
      entryType: collection ? 'COLLECTION' : 'ACCRUAL',
      description: collection ? `Ödeme ${i}` : `Aidat ${i}`,
      ...(collection ? { receiptNumber: `MKB-${i}`, paymentId: `pay-${i}` } : { dueDate: `2025-${month}-${day}` }),
      debit: collection ? 0 : 150000,
      credit: collection ? 150000 : 0,
      balance: 0,
    };
  });
  return {
    unitId: 'u-3',
    period: { from: '2025-01-01', to: '2026-11-28' },
    accounts: [{ liableParty: 'owner', label: 'Malik', openingBalance: 0, totalDebit: 0, totalCredit: 0, closingBalance: 0, entries }],
    closingBalance: 0,
  };
};

export const announcements = (n: number) => ({
  items: Array.from({ length: n }, (_, i) => ({
    announcementId: `an-${i + 1}`,
    title: `Duyuru ${i + 1}`,
    body: `Duyuru ${i + 1} metni.\nİkinci satır.`,
    publishAt: `2026-11-${String(20 - i).padStart(2, '0')}T06:00:00.000Z`,
  })),
});

export const ticket = (id: string, status: string, actions: string[] = []) => ({
  ticketId: id,
  number: `T-${id}`,
  title: `Talep ${id}`,
  description: 'Açıklama',
  category: 'plumbing',
  priority: 'normal',
  location: { kind: 'unit', unitId: 'u-3' },
  status,
  source: 'portal',
  createdAt: '2026-11-25T08:00:00.000Z',
  dueAt: '2026-11-30T08:00:00.000Z',
  actions,
  version: 1,
});

export const quote = (enabled: boolean, totalDue = 307350) => ({
  unitId: 'u-3',
  currency: 'TRY',
  onlinePaymentEnabled: enabled,
  requiresGsmNumber: false,
  asOf: '2026-11-28T09:00:00.000Z',
  lateFeeMonthlyBasisPoints: 500,
  parties: [],
  totalDue,
});
