// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import { type PortalPoll, portalPollSchema } from '@/lib/api/pollModel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const vote = { isPending: false, isError: false, isSuccess: false, error: null, mutate: vi.fn() };
let detail: PortalPoll;

vi.mock('@/hooks/usePolls', () => ({
  useMyPoll: () => ({ isPending: false, isError: false, data: detail }),
  useVote: () => vote,
}));
vi.mock('@/context/PortalUnitContext', () => ({ usePortalUnit: () => ({ unitId: undefined, selectUnit: vi.fn() }) }));
vi.mock('react-router', () => ({
  Link: ({ children }: { children: unknown }) => children,
  useParams: () => ({ pollId: 'p1' }),
}));

const { MyPollDetailPage } = await import('./MyPollDetailPage');

const poll = (over: Partial<PortalPoll> = {}) =>
  portalPollSchema.parse({
    pollId: 'p1',
    title: 'Asansör yenilensin mi?',
    options: [
      { optionId: 'o1', label: 'Evet' },
      { optionId: 'o2', label: 'Hayır' },
    ],
    audience: 'owners',
    weighting: 'land_share',
    secret: true,
    resultsVisibleBeforeClose: false,
    opensAt: '2026-11-10T07:00:00.000Z',
    closesAt: '2026-11-17T15:00:00.000Z',
    rollDate: '2026-11-10',
    phase: 'open',
    unitId: 'u2',
    eligible: true,
    canVote: true,
    resultsAvailable: false,
    resultsAfterVote: false,
    ...over,
  });

let container: HTMLDivElement;
afterEach(() => {
  container?.remove();
  vi.clearAllMocks();
});
async function render() {
  container = document.createElement('div');
  document.body.append(container);
  await act(async () => createRoot(container).render(<MyPollDetailPage />));
}
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as HTMLButtonElement | undefined;

describe('sakin oylama ayrintisi', () => {
  it('secim yapilmadan gonderilemez; secilen secenekle oy gider; tek oy kurali anlatilir', async () => {
    detail = poll();
    await render();
    expect(button('Oyu gönder')?.disabled).toBe(true);
    expect(container.textContent).toContain('oylama bitene kadar verilen son oy geçerlidir');
    expect(container.textContent).toContain('Gizli oylama');
    const radio = container.querySelector('input[value="o2"]') as HTMLInputElement;
    await act(async () => radio.click());
    expect(button('Oyu gönder')?.disabled).toBe(false);
    await act(async () => button('Oyu gönder')?.closest('form')?.requestSubmit());
    expect(vote.mutate).toHaveBeenCalledWith('o2');
    expect(container.textContent).toContain('Sonuçlar oylama bitince açıklanır');
  });

  it('hisseli bolum: baska paydasin gizli oyu secimsiz gosterilir; oy degistirme dugmesi', async () => {
    detail = poll({ myVote: { castByMe: false } });
    await render();
    expect(container.textContent).toContain('Dairenizin oyu başka bir paydaş tarafından kullanıldı.');
    expect(button('Oyumu değiştir')).toBeDefined();
    expect((container.querySelector('input[value="o1"]') as HTMLInputElement).checked).toBe(false);
  });

  it('ara sonuc acik ama daire oy kullanmadiysa "oy kullanildiktan sonra" bilgisi', async () => {
    detail = poll({ secret: false, resultsVisibleBeforeClose: true, resultsAfterVote: true });
    await render();
    expect(container.textContent).toContain('Ara sonuçlar dairenizin oyu kullanıldıktan sonra görünür');
  });

  it('oy sonrasi sonuc gorulebilir ama yanit sonucu tasimiyorsa "yukleniyor" (bitince aciklanir degil)', async () => {
    detail = poll({ secret: false, resultsVisibleBeforeClose: true, resultsAvailable: true, myVote: { castByMe: true, optionId: 'o1' } });
    await render();
    expect(container.textContent).toContain('Sonuçlar yükleniyor…');
    expect(container.textContent).not.toContain('Sonuçlar oylama bitince açıklanır');
  });

  it('oy hakki yoksa neden gosterilir, form yok', async () => {
    detail = poll({ eligible: false, canVote: false, ineligibleReason: 'Oy listesi tarihinde (2026-11-10) bu bölümün malikleri arasında kayıtlı değilsiniz' });
    await render();
    expect(container.textContent).toContain('malikleri arasında kayıtlı değilsiniz');
    expect(container.querySelector('form')).toBeNull();
  });

  it('bitmis oylama: sonuc, kendi oyum vurgulu, oy formu yok', async () => {
    detail = poll({
      phase: 'closed',
      canVote: false,
      closedAt: '2026-11-12T07:00:00.000Z',
      closedEarly: true,
      myVote: { castByMe: true, optionId: 'o2', castAt: '2026-11-10T08:00:00.000Z' },
      resultsAvailable: true,
      results: {
        pollId: 'p1',
        phase: 'closed',
        final: true,
        weighting: 'land_share',
        rollDate: '2026-11-10',
        eligible: { units: 3, landShare: { numerator: '1200', denominator: '1200' } },
        participation: { units: 3, unitsBps: 10000, landShare: { numerator: '1200', denominator: '1200' }, landShareBps: 10000 },
        tallyHidden: false,
        options: [
          { optionId: 'o1', label: 'Evet', units: 2, unitsBps: 6667, landShare: { numerator: '360', denominator: '1200' }, landShareBps: 3000 },
          { optionId: 'o2', label: 'Hayır', units: 1, unitsBps: 3333, landShare: { numerator: '840', denominator: '1200' }, landShareBps: 7000 },
        ],
        winnerOptionId: 'o2',
        warnings: [],
      },
    });
    await render();
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('erken kapatıldı');
    expect(container.textContent).toContain('Oyunuz: Hayır');
    expect(container.textContent).toContain('Sizin oyunuz');
    expect(container.textContent).toContain('“Hayır” kullanılan oyların salt çoğunluğunu aldı (arsa payı)');
    expect(container.textContent).toContain('840/1.200');
  });
});
