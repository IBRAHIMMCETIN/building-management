/**
 * Genel kurul sonrasi ve ihale devami (sakin): iptal / erteleme bildirimi, secim sonucu (yalnizca
 * secilenin adi), ihale kararinin dayandigi genel kurul karari (malikse baglanti) ve belirli soruya yanit.
 */
import { fireEvent, screen } from '@testing-library/react-native';
import { assembly, heldAssembly, residentContexts } from '@/test/assemblyFixtures';
import { renderApp } from '@/test/renderApp';
import { tender } from '@/test/tenderFixtures';
import { RESIDENT_MORE } from '@/lib/nav';
import { AssembliesScreen } from './AssembliesScreen';
import { AssemblyDetailScreen, electionLines } from './AssemblyDetailScreen';
import { TenderDetailScreen } from './TenderDetailScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(async () => ({ type: 'opened' })), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

const asOwner = { env: { apiMode: 'demo' as const } };
const contexts = { 'GET /api/me/contexts': residentContexts('owner') };

beforeEach(() => mockPush.mockClear());

describe('genel kurul: iptal, erteleme, secim', () => {
  it('iptal edilen toplanti: gerekce ve tarihle uyari; erteleme gecmisi', async () => {
    await renderApp(<AssemblyDetailScreen id="as-1" />, {
      ...asOwner,
      routes: {
        ...contexts,
        'GET /api/portal/assemblies/as-1': assembly({
          status: 'cancelled',
          phase: 'cancelled',
          cancelReason: 'Yönetici istifa etti',
          cancelledAt: '2026-12-01T09:00:00.000Z',
          reschedules: [{ previousScheduledAt: '2026-12-15T16:00:00.000Z', scheduledAt: '2026-12-20T16:00:00.000Z', placeChanged: false, reason: 'Salon tadilatta', at: '2026-11-28T09:00:00.000Z' }],
        }),
      },
    });
    expect(await screen.findByText('Toplantı iptal edildi: Yönetici istifa etti')).toBeTruthy();
    expect(screen.getByText(/^İptal tarihi: .+\. Bu tarihte toplantı yapılmayacak/)).toBeTruthy();
    expect(screen.getByText(/^Toplantı ertelendi: .+ yerine .+\. Gerekçe: Salon tadilatta$/)).toBeTruthy();
  });

  it('secim sonucu: secilenin adi, digerleri sira etiketiyle; secilemediyse aciklama', async () => {
    const decision = { decision: 'accepted' as const, rule: 'persons_and_land' as const, votes: { yes: 3, no: 1, abstain: 0 }, units: null, persons: null, landShareBps: null, corrected: false, recordedAt: '2026-12-15T17:00:00.000Z' };
    const candidates = [
      { candidateId: 'c1', name: 'Ali Veli', votes: 3, persons: 3, units: 3, landShareBps: 9000, elected: true },
      { candidateId: 'c2', name: 'Aday 2', votes: 1, persons: 1, units: 1, landShareBps: 1000, elected: false },
    ];
    const held = heldAssembly();
    await renderApp(<AssemblyDetailScreen id="as-0" />, {
      ...asOwner,
      routes: {
        ...contexts,
        'GET /api/portal/assemblies/as-0': {
          ...held,
          agenda: [{ itemId: 'a1', title: 'Yönetici seçimi', decisionKind: 'manager_election', majority: 'persons_and_land', candidateCount: 2, decision: { ...decision, election: { winnerName: 'Ali Veli', candidates } } }],
        },
      },
    });
    expect(await screen.findByText('Seçilen: Ali Veli')).toBeTruthy();
    expect(screen.getByText('Aday 2: 1 oy · 1 kat maliki · 1 bölüm · arsa payı %10')).toBeTruthy();
    expect(electionLines({ winnerName: null, noWinner: 'Seçim yapılamadı: hiçbir aday çoğunluğa ulaşmadı.', candidates }).head).toBe('Seçim yapılamadı: hiçbir aday çoğunluğa ulaşmadı.');
  });
});

describe('ihale: genel kurul karari bagi ve yanitlar', () => {
  const base = tender();
  const decided = {
    ...base,
    status: 'decided' as const,
    decision: { quoteId: base.quotes[0]!.quoteId, reason: 'En düşük teklif', supplierName: base.quotes[0]!.supplierName, netKurus: 1, vatKurus: 0, totalKurus: 12_000_000, decidedAt: '2026-11-25T07:00:00.000Z' },
  };
  const link = { assemblyId: 'asm1', itemId: 'a1', itemTitle: 'Isı yalıtımı yapılsın', meetingAt: '2026-11-10T16:00:00.000Z', decision: 'accepted' as const };

  it('malik ve kesinlesmis toplanti: karar baglantisi genel kurul ayrintisini acar', async () => {
    await renderApp(<TenderDetailScreen id="t-1" />, { routes: { 'GET /api/portal/tenders/t-1': { tender: { ...decided, assemblyDecision: { ...link, portalLink: true } } } } });
    expect(await screen.findByText('Dayanak genel kurul kararı: 10 Kas 2026 · Isı yalıtımı yapılsın')).toBeTruthy();
    await fireEvent.press(screen.getByRole('link', { name: 'Genel kurul kararını aç' }));
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/resident/assemblies/[id]', params: { id: 'asm1' } });
  });

  it('kiraci / kesinlesmemis: baglanti yok, yalnizca metin; duzeltme notu', async () => {
    await renderApp(<TenderDetailScreen id="t-1" />, {
      routes: { 'GET /api/portal/tenders/t-1': { tender: { ...decided, assemblyDecision: { ...link, portalLink: false, corrected: true, currentDecision: 'rejected' } } } },
    });
    expect(await screen.findByText('Dayanak genel kurul kararı: 10 Kas 2026 · Isı yalıtımı yapılsın')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Genel kurul kararını aç' })).toBeNull();
    expect(screen.getByText('Bu karar sonradan düzeltildi (güncel kayıt: reddedildi).')).toBeTruthy();
  });

  it('yonetim yaniti belirli soruya: soru alintilanir', async () => {
    const comments = [
      { commentId: 'q1', body: 'Teklif KDV dahil mi?', authorKind: 'resident' as const, mine: true, createdAt: '2026-11-26T08:00:00.000Z' },
      { commentId: 'r1', body: 'Evet, KDV dahil.', authorKind: 'management' as const, mine: false, createdAt: '2026-11-26T09:00:00.000Z', replyTo: 'q1' },
    ];
    await renderApp(<TenderDetailScreen id="t-1" />, { routes: { 'GET /api/portal/tenders/t-1': { tender: { ...base, comments } } } });
    expect(await screen.findByText('Yanıtlanan soru: Teklif KDV dahil mi?')).toBeTruthy();
    expect(screen.getByText('Evet, KDV dahil.')).toBeTruthy();
  });
});

describe('modul anahtarlari (abonelik / site ozelligi)', () => {
  it('Oylamalar ve Genel Kurul modules.pollsAssemblies, İhaleler modules.tenders anahtarina bagli', () => {
    const featureOf = (key: string) => RESIDENT_MORE.find((i) => i.key === key)?.feature;
    expect([featureOf('oylamalar'), featureOf('genel-kurul'), featureOf('ihale')]).toEqual(['modules.pollsAssemblies', 'modules.pollsAssemblies', 'modules.tenders']);
  });

  it('genel kurul 403: modul kapaliysa kapali ozellik notu, malik degilse maliklere acik bilgisi', async () => {
    await renderApp(<AssembliesScreen />, {
      ...asOwner,
      routes: { ...contexts, 'GET /api/portal/assemblies': { status: 403, body: { error: 'feature_disabled', feature: 'modules.pollsAssemblies', message: 'Bu özellik siteniz için kapalı' } } },
    });
    expect(await screen.findByText('Bu özellik sitenizde kapalı. Açılmasını isterseniz site yönetiminize söyleyebilirsiniz.')).toBeTruthy();
    expect(screen.queryByText('Genel kurul bilgileri kat maliklerine açıktır')).toBeNull();
  });
});
