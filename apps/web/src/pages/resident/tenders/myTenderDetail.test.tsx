// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type Tender, tenderSchema } from '@/lib/api/tenders';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let data: Tender;
vi.mock('@/hooks/useTenders', () => ({
  useMyTender: () => ({ isPending: false, isError: false, error: null, data }),
  useAskTenderQuestion: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));
vi.mock('@/hooks/useOpenDocument', () => ({ useOpenDocument: () => ({ open: vi.fn(), pendingId: null, error: null }) }));
vi.mock('react-router', () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useParams: () => ({ tenderId: 't1' }),
}));

const { MyTenderDetailPage } = await import('./MyTenderDetailPage');

const tender = (over: Record<string, unknown> = {}) =>
  tenderSchema.parse({
    tenderId: 't1',
    title: 'Isı yalıtımı',
    category: 'mantolama',
    status: 'decided',
    deadline: '2026-11-20',
    deadlinePassed: true,
    minQuotes: 1,
    quoteCount: 1,
    publishedAt: '2026-11-21T07:00:00.000Z',
    decision: { quoteId: 'q1', reason: 'Tek teklif, kurul onaylı', supplierName: 'Cephe Ltd.', netKurus: 90_000_00, vatKurus: 18_000_00, totalKurus: 108_000_00, decidedAt: '2026-11-25T07:00:00.000Z' },
    createdAt: '2026-11-01T07:00:00.000Z',
    updatedAt: '2026-11-25T07:00:00.000Z',
    version: 5,
    description: 'Dış cephe ısı yalıtımı',
    quotes: [],
    comparison: { rows: [], lowestQuoteIds: ['q1'], lowestNetQuoteIds: ['q1'] },
    comments: [
      { commentId: 'c1', body: 'Garanti kaç yıl?', authorKind: 'resident', mine: true, createdAt: '2026-11-22T07:00:00.000Z' },
      { commentId: 'c2', body: '10 yıl.', authorKind: 'management', mine: false, createdAt: '2026-11-22T08:00:00.000Z', replyTo: 'c1' },
    ],
    canComment: false,
    ...over,
  });

let container: HTMLDivElement;
afterEach(() => container?.remove());
async function render() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<MyTenderDetailPage />));
}
const link = { assemblyId: 'asm1', itemId: 'a1', itemTitle: 'Isı yalıtımı yapılsın', meetingAt: '2026-11-10T16:00:00.000Z', decision: 'accepted' };

describe('sakin ihale ayrintisi: genel kurul karari ve yanit bagi', () => {
  it('malik ve kesinlesmis toplanti: karar portal genel kurul sayfasina baglanir; yanit soruyu alintilar', async () => {
    data = tender({ assemblyDecision: { ...link, portalLink: true } });
    await render();
    const a = [...container.querySelectorAll('a')].find((x) => x.textContent?.includes('Isı yalıtımı yapılsın'));
    expect(a?.getAttribute('href')).toBe('/app/genel-kurul/asm1');
    expect(container.textContent).toContain('Dayandığı genel kurul kararı:');
    expect(container.textContent).toContain('Yanıtlanan soru: “Garanti kaç yıl?”');
  });

  it('kiraci (portal baglantisi yok): karar yalnizca metin; sonradan duzeltildiyse belirtilir', async () => {
    data = tender({ assemblyDecision: { ...link, portalLink: false, corrected: true, currentDecision: 'rejected' } });
    await render();
    expect([...container.querySelectorAll('a')].some((x) => x.textContent?.includes('Isı yalıtımı yapılsın'))).toBe(false);
    expect(container.textContent).toContain('Isı yalıtımı yapılsın');
    expect(container.textContent).toContain('(karar sonradan düzeltildi)');
  });
});
