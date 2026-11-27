// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type PortalAssembly, portalAssemblySchema } from '@/lib/api/assemblyModel';
import { ApiError } from '@/lib/api/errors';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const doc = { open: vi.fn(), pendingId: null, error: null };
let state: { isPending: boolean; isError: boolean; error: unknown; data?: unknown; refetch: () => void };

vi.mock('@/hooks/useAssemblies', () => ({
  useMyAssembly: () => state,
  useMyAssemblies: () => state,
}));
vi.mock('@/hooks/useOpenDocument', () => ({ useOpenDocument: () => doc }));
vi.mock('@/context/PortalUnitContext', () => ({ usePortalUnit: () => ({ unitId: undefined, selectUnit: vi.fn() }) }));
vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useParams: () => ({ assemblyId: 'asm1' }),
}));

const { MyAssemblyDetailPage } = await import('./MyAssemblyDetailPage');
const { MyAssembliesPage } = await import('./MyAssembliesPage');

const assembly = (over: Partial<PortalAssembly> = {}) =>
  portalAssemblySchema.parse({
    assemblyId: 'asm1',
    kind: 'ordinary',
    secondMeeting: false,
    scheduledAt: '2026-12-15T16:00:00.000Z',
    location: 'Site toplantı salonu',
    onlineUrl: 'https://meet.example/x',
    rollDate: '2026-12-15',
    status: 'planned',
    phase: 'upcoming',
    calledAt: '2026-11-27T09:00:00.000Z',
    lastCalledAt: '2026-11-27T09:00:00.000Z',
    secondMeetingPlan: { scheduledAt: '2026-12-29T16:00:00.000Z', location: 'Bahçe', onlineUrl: 'https://meet.example/ikinci' },
    agenda: [
      { itemId: 'a1', title: 'Yönetici seçimi', decisionKind: 'manager_election', majority: 'persons_and_land' },
      { itemId: 'a2', title: 'İşletme projesi', decisionKind: 'operating_budget', majority: 'attendees' },
    ],
    minutesAvailable: false,
    ...over,
  });

const ok = (data: unknown) => ({ isPending: false, isError: false, error: null, data, refetch: vi.fn() });

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(node));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

describe('sakin genel kurul ayrintisi', () => {
  it('yaklasan toplanti: tarih, yer, baglanti, cagri, ikinci toplanti, gundem ve gerekli cogunluk; karar ve tutanak yok', async () => {
    state = ok(assembly());
    await render(<MyAssemblyDetailPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('Olağan toplantı');
    expect(text).toContain('Yaklaşan');
    expect(text).toContain('15 Ara 2026 19:00 (Türkiye saati)');
    expect(text).toContain('Site toplantı salonu');
    expect(container.querySelector('a[href="https://meet.example/x"]')).not.toBeNull();
    expect(text).toContain('Yeter sayı sağlanamazsa ikinci toplantı');
    expect(text).toContain('29 Ara 2026 19:00 · Bahçe');
    expect(container.querySelector('a[href="https://meet.example/ikinci"]')).not.toBeNull();
    expect(text).toContain('Gerekli çoğunluk: Bütün kat maliklerinin sayı (kişi) ve arsa payı çoğunluğu');
    expect(text).toContain('yasal çağrı yönetiminizce ayrıca yapılır');
    expect(text).not.toContain('Kabul edildi');
    expect(button('Tutanağı görüntüle')).toBeUndefined();
    expect(text).toContain('kesinleştirildiğinde burada görünür');
  });

  it('kesinlesen toplanti: toplam oylar ve arsa payi, yeter sayi ozeti; tutanak imzali linkle acilir', async () => {
    state = ok(
      assembly({
        status: 'held',
        phase: 'held',
        minutesAvailable: true,
        quorum: { met: true, secondMeeting: false, noAttendance: false, presentOwners: 3, totalOwners: 4, presentVotes: 3, totalVotes: 4 },
        agenda: [
          {
            itemId: 'a1',
            title: 'Yönetici seçimi',
            majority: 'persons_and_land',
            decision: { decision: 'accepted', rule: 'persons_and_land', votes: { yes: 3, no: 0, abstain: 0 }, units: { yes: 3, no: 0, abstain: 0 }, landShareBps: { yes: 9000, no: 0, abstain: 0 }, corrected: true, recordedAt: '2026-12-15T17:00:00.000Z' },
          },
          { itemId: 'a2', title: 'İşletme projesi', majority: 'attendees' },
        ],
      }),
    );
    await render(<MyAssemblyDetailPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('Toplantı yapıldı');
    expect(text).toContain('Toplantı yeter sayısı sağlandı (3/4 kat maliki).');
    expect(text).toContain('Kabul edildi');
    expect(text).toContain('Kabul 3 oy · 3 bölüm · arsa payı %90');
    expect(text).toContain('karar kaydı düzeltildi');
    expect(text).toContain('Bu madde için karar kaydı yok.');
    await act(async () => button('Tutanağı görüntüle')?.click());
    expect(doc.open).toHaveBeenCalledWith('asm1', expect.any(Function));
  });

  it('kiraci / malik olmayan (403): kat maliklerine acik bilgisi, "daireye atanmadiniz" degil', async () => {
    state = { isPending: false, isError: true, error: new ApiError(403, { error: 'forbidden', message: 'Genel kurul bilgileri yalnızca kat maliklerine açıktır' }), refetch: vi.fn() };
    await render(<MyAssemblyDetailPage />);
    expect(container.textContent).toContain('Genel kurul bilgileri kat maliklerine açıktır');
    expect(container.textContent).not.toContain('Henüz bir daireye atanmadınız');
  });
});

describe('sakin genel kurul listesi', () => {
  it('toplanti satiri ayrintiya baglanir; evre rozeti ve tutanak bilgisi', async () => {
    state = ok([assembly(), assembly({ assemblyId: 'asm0', status: 'held', phase: 'held', minutesAvailable: true, secondMeeting: true })]);
    await render(<MyAssembliesPage />);
    expect(container.querySelector('a[href="/app/genel-kurul/asm1"]')?.textContent).toContain('Yaklaşan');
    const held = container.querySelector('a[href="/app/genel-kurul/asm0"]')?.textContent ?? '';
    expect(held).toContain('(ikinci toplantı)');
    expect(held).toContain('Tutanak hazır');
  });

  it('bos liste ve 403', async () => {
    state = ok([]);
    await render(<MyAssembliesPage />);
    expect(container.textContent).toContain('Henüz toplantı yok');
    container.remove();
    state = { isPending: false, isError: true, error: new ApiError(403), refetch: vi.fn() };
    await render(<MyAssembliesPage />);
    expect(container.textContent).toContain('kat maliklerine açıktır');
  });
});
