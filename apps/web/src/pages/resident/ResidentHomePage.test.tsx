// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatTRY } from '@/lib/money';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ok = <T,>(data: T) => ({ isPending: false, isError: false, data, refetch: vi.fn() });

let features: Record<string, boolean> = {};
let summary: unknown;
let receipts: unknown;
let breakdown: unknown;
let reference: unknown;
const breakdownMonths: string[] = [];

vi.mock('@/context/SiteFeaturesContext', () => ({ useFeature: (k: string) => features[k] ?? false }));
vi.mock('@/hooks/usePortal', () => ({
  useMySummary: () => summary,
  useMyAnnouncements: () => ok([{ announcementId: 'a1', title: 'Su kesintisi', publishAt: '2026-11-20T08:00:00.000Z' }]),
  useMyReceipts: () => receipts,
  useExpenseBreakdown: (month: string) => {
    breakdownMonths.push(month);
    return breakdown;
  },
}));
vi.mock('@/hooks/usePayments', () => ({ usePaymentQuote: () => ok({ onlinePaymentEnabled: false, totalDue: 0 }) }));
vi.mock('@/hooks/useBank', () => ({ useMyPaymentReference: () => reference }));
vi.mock('@/components/portal/PortalQueryState', () => ({ ChangeUnitLink: () => null, PortalQueryState: () => null }));
vi.mock('./tickets/MyTicketsCard', () => ({ MyTicketsCard: () => <div>Taleplerim</div> }));

const { ResidentHomePage } = await import('./ResidentHomePage');

const SUMMARY = {
  unitId: 'u12',
  unitLabel: 'A Blok · 12',
  relationLabel: 'Kat Maliki',
  asOf: '2026-11-28',
  status: 'pending',
  balance: 150050,
  debt: 150050,
  advance: 0,
  totalCharged: 900000,
  totalPaid: 749950,
  overdueAmount: 0,
  accruedLateFee: 0,
  daysOverdue: 0,
  openCount: 1,
  nextDue: { dueDate: '2026-12-10', amount: 150050, description: 'Aralık 2026 aidatı' },
};

const BREAKDOWN = {
  month: '2026-11',
  total: 1_000_000,
  empty: false,
  items: [
    { category: 'heating', label: 'Isınma', icon: 'flame', amount: 500_000, shareBp: 5000, percent: 50 },
    { category: 'electricity', label: 'Elektrik', icon: 'zap', amount: 333_333, shareBp: 3333, percent: 33.33 },
    { category: 'other', label: 'Diğer', icon: 'ellipsis', amount: 166_667, shareBp: 1667, percent: 16.67 },
  ],
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  features = { 'resident.expenseChart': true };
  summary = ok(SUMMARY);
  receipts = ok({ unitId: 'u12', items: [{ paymentId: 'p1', receiptNumber: 'MKB-000012', paidAt: '2026-11-05', amount: 75000, method: 'bank_transfer', liableParty: 'owner', status: 'valid' }] });
  breakdown = ok(BREAKDOWN);
  reference = ok({
    unitId: 'u12',
    unitLabel: 'A Blok · 12',
    bank: { iban: 'TR330006100519786457841326', accountHolderName: 'Gül Sitesi Yönetimi' },
    references: [{ liableParty: 'owner', label: 'Kat maliki', code: 'K7M2QA' }],
  });
  breakdownMonths.length = 0;
});
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  vi.restoreAllMocks();
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <MemoryRouter>
        <ResidentHomePage />
      </MemoryRouter>,
    ),
  );
}

describe('sade sakin ana sayfasi', () => {
  it('Borcunuz karti buyuk tutar ve son odeme gunu; muhasebe terimi yok', () => {
    render();
    expect(container.textContent).toContain('Borcunuz');
    expect(container.querySelector('[data-testid="debt-amount"]')?.textContent).toBe(formatTRY(150050));
    expect(container.textContent).toContain('Son ödeme günü');
    const text = container.textContent?.toLocaleLowerCase('tr') ?? '';
    for (const term of ['tahakkuk', 'mahsup', 'mizan', 'alacak', 'cari', 'avans']) expect(text).not.toContain(term);
  });

  it('borc yoksa sade "Borcunuz yok"', () => {
    summary = ok({ ...SUMMARY, debt: 0, balance: 0, nextDue: undefined, status: 'no_debt' });
    render();
    expect(container.textContent).toContain('Borcunuz yok');
  });

  it('Ariza bildir tek dokunusla yeni talep ekranina gider', () => {
    render();
    const link = [...container.querySelectorAll('a')].find((a) => a.textContent?.includes('Arıza bildir'));
    expect(link?.getAttribute('href')).toBe('/app/talepler/yeni');
  });

  it('IBAN ve referans kodu tek tikla kopyalanir; "Kopyalandı" geri bildirimi', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render();
    const iban = container.querySelector('button[aria-label="IBAN kopyala"]') as HTMLButtonElement;
    await act(async () => iban.click());
    expect(writeText).toHaveBeenCalledWith('TR330006100519786457841326');
    expect(iban.textContent).toContain('Kopyalandı');
    const code = container.querySelector('button[aria-label="Ödeme referans kodu kopyala"]') as HTMLButtonElement;
    await act(async () => code.click());
    expect(writeText).toHaveBeenLastCalledWith('K7M2QA');
  });

  it('ozellik acikken halka grafik: dilimler, sade kategoriler, yuzde ve tutar', () => {
    render();
    expect(container.textContent).toContain('Aidatınız nereye gidiyor?');
    const circles = container.querySelectorAll('svg circle[data-category]');
    expect([...circles].map((c) => c.getAttribute('data-category'))).toEqual(['heating', 'electricity', 'other']);
    const rows = [...container.querySelectorAll('li[data-category]')].map((li) => li.textContent);
    expect(rows[0]).toContain('Isınma');
    expect(rows[0]).toContain('%50');
    expect(rows[0]).toContain(formatTRY(500_000));
    expect(rows[1]).toContain('%33,3');
    expect(container.textContent).toContain(formatTRY(1_000_000));
    expect(container.textContent).not.toMatch(/Personel|personel/);
  });

  it('ay secici yeni ayi ister', () => {
    render();
    const select = container.querySelector('select[aria-label="Ay seçin"]') as HTMLSelectElement;
    expect(select.options.length).toBe(12);
    const target = select.options[2]?.value as string;
    act(() => {
      select.value = target;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(breakdownMonths.at(-1)).toBe(target);
  });

  it('ozellik kapaliyken grafik hic gorunmez', () => {
    features = {};
    render();
    expect(container.textContent).not.toContain('Aidatınız nereye gidiyor?');
    expect(container.querySelector('svg circle[data-category]')).toBeNull();
  });

  it('gider olmayan ayda sade bos durum', () => {
    breakdown = ok({ month: '2026-11', total: 0, empty: true, items: [] });
    render();
    expect(container.textContent).toContain('henüz gider girilmedi');
    expect(container.querySelector('svg circle[data-category]')).toBeNull();
  });

  it('son odemeler ve son duyurular', () => {
    render();
    expect(container.textContent).toContain('Son ödemeleriniz');
    expect(container.textContent).toContain(formatTRY(75000));
    expect(container.textContent).toContain('Havale / EFT');
    expect(container.textContent).toContain('Su kesintisi');
  });
});
