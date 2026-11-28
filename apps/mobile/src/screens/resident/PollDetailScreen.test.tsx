import type { PortalPoll } from '@bm/shared/api/polls';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { finalResults, poll } from '@/test/pollFixtures';
import { renderApp } from '@/test/renderApp';
import { PollDetailScreen } from './PollDetailScreen';

jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const radio = (name: string) => screen.getByRole('radio', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const disabled = (name: string) => button(name).props.accessibilityState?.disabled === true;

/** Ayrinti + oy ucu; oy sonrasi ayrinti sunucudaki son hali dondurur. */
function voteRoutes(initial: PortalPoll, onVote: (optionId: string) => { status: number; body?: unknown } | PortalPoll) {
  let current = initial;
  return {
    'GET /api/portal/polls/p1': () => current,
    'POST /api/portal/polls/p1/vote': ({ body }: { body: unknown }) => {
      const out = onVote((body as { optionId: string }).optionId);
      if ('pollId' in out) current = out;
      return out;
    },
    setCurrent: (p: PortalPoll) => {
      current = p;
    },
  };
}

describe('Oylama ayrintisi: oy verme', () => {
  it('secim yapilmadan gonderilemez; onay adimindan sonra secilen secenekle oy gider', async () => {
    const r = voteRoutes(poll(), (optionId) => poll({ myVote: { castByMe: true, optionId, castAt: '2026-11-28T09:00:00.000Z' } }));
    const { calls } = await renderApp(<PollDetailScreen id="p1" />, { routes: r });

    expect(await screen.findByRole('header', { name: 'Asansör yenilensin mi?' })).toBeTruthy();
    expect(screen.getByText(/oylama bitene kadar verilen son oy geçerlidir/)).toBeTruthy();
    expect(screen.getByText(/Gizli oylama: yönetim hangi bölümün/)).toBeTruthy();
    expect(screen.getByText('Sonuçlar oylama bitince açıklanır.')).toBeTruthy();
    expect(disabled('Oyu gönder')).toBe(true);

    await fireEvent.press(radio('Hayır'));
    expect(radio('Hayır').props.accessibilityState).toMatchObject({ checked: true });
    expect(disabled('Oyu gönder')).toBe(false);

    // Onay adimi: henuz istek yok; secim ve "son oy gecerli" aciklamasi gosterilir.
    await fireEvent.press(button('Oyu gönder'));
    expect(screen.getByText('“Hayır” seçeneğine oy vereceksiniz.')).toBeTruthy();
    expect(screen.getByText('Oylama bitene kadar verilen son oy geçerlidir; isterseniz sonra değiştirebilirsiniz.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await fireEvent.press(button('Oyu onayla'));
    expect(await screen.findByText('Oyunuz kaydedildi. Oylama bitene kadar değiştirebilirsiniz.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST')).toEqual([{ method: 'POST', path: '/api/portal/polls/p1/vote', query: {}, body: { optionId: 'o2' } }]);
    // Yanit ayrintiya yazildi: oy degistirme moduna gecildi, ayni secimle tekrar gonderilemez.
    expect(await screen.findByText('Oyunuz: Hayır')).toBeTruthy();
    expect(screen.getByRole('header', { name: 'Oyunuzu değiştirin' })).toBeTruthy();
    expect(disabled('Oyumu değiştir')).toBe(true);
  });

  it('onaydan vazgecilirse oy gonderilmez; secim degisince onay kapanir', async () => {
    const { calls } = await renderApp(<PollDetailScreen id="p1" />, { routes: voteRoutes(poll(), () => poll()) });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Evet' }));
    await fireEvent.press(button('Oyu gönder'));
    await fireEvent.press(button('Vazgeç'));
    expect(screen.queryByRole('button', { name: 'Oyu onayla' })).toBeNull();
    await fireEvent.press(button('Oyu gönder'));
    await fireEvent.press(radio('Hayır'));
    expect(screen.queryByRole('button', { name: 'Oyu onayla' })).toBeNull();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('oy degistirme: hisseli bolumde paydasin gizli oyu secimsiz; onay metni degisikligi soyler', async () => {
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: voteRoutes(poll({ myVote: { castByMe: false } }), (optionId) => poll({ myVote: { castByMe: true, optionId } })),
    });
    expect(await screen.findByText('Dairenizin oyu başka bir paydaş tarafından kullanıldı.')).toBeTruthy();
    expect(radio('Evet').props.accessibilityState).toMatchObject({ checked: false });
    await fireEvent.press(radio('Evet'));
    await fireEvent.press(button('Oyumu değiştir'));
    expect(screen.getByText('Oyunuz “Evet” olarak değiştirilecek.')).toBeTruthy();
    await fireEvent.press(button('Değişikliği onayla'));
    expect(await screen.findByText('Oyunuz: Evet')).toBeTruthy();
  });

  it('409 oylama sona erdi: hata gosterilir, guncel durum (kapali) yeniden yuklenir', async () => {
    const r = voteRoutes(poll(), () => {
      r.setCurrent(poll({ phase: 'closed', canVote: false, closedAt: '2026-11-28T08:59:00.000Z' }));
      return { status: 409, body: { error: 'poll_closed', message: 'Oylama sona erdi; oy kabul edilmiyor' } };
    });
    const { calls } = await renderApp(<PollDetailScreen id="p1" />, { routes: r });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Evet' }));
    await fireEvent.press(button('Oyu gönder'));
    await fireEvent.press(button('Oyu onayla'));

    expect(await screen.findByText('Oyunuz kaydedilmedi: Oylama sona erdi; oy kabul edilmiyor.')).toBeTruthy();
    expect(await screen.findByText('Oylama sona erdi; oy kabul edilmiyor.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('radio', { name: 'Evet' })).toBeNull());
    expect(screen.getByRole('header', { name: 'Oyunuz' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'GET' && c.path === '/api/portal/polls/p1').length).toBeGreaterThanOrEqual(2);
  });

  it('ara sonuc acik ama daire oy kullanmadiysa "oy kullanildiktan sonra" bilgisi', async () => {
    await renderApp(<PollDetailScreen id="p1" />, { routes: { 'GET /api/portal/polls/p1': poll({ secret: false, resultsVisibleBeforeClose: true, resultsAfterVote: true }) } });
    expect(await screen.findByText('Ara sonuçlar dairenizin oyu kullanıldıktan sonra görünür.')).toBeTruthy();
    expect(screen.getByText(/Açık oylama: yönetim hangi bölümün/)).toBeTruthy();
  });

  it('oy hakki yoksa neden gosterilir, secenekler yok', async () => {
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: { 'GET /api/portal/polls/p1': poll({ eligible: false, canVote: false, ineligibleReason: 'Oy listesi tarihinde (2026-11-10) bu bölümün malikleri arasında kayıtlı değilsiniz' }) },
    });
    expect(await screen.findByText(/malikleri arasında kayıtlı değilsiniz\. Oy listesi yönetimin/)).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Oyu gönder' })).toBeNull();
  });

  it('bitmis oylama: kesin sonuc, kendi oyum vurgulu, salt cogunluk cumlesi, oy formu yok', async () => {
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: {
        'GET /api/portal/polls/p1': poll({
          phase: 'closed',
          canVote: false,
          closedAt: '2026-11-12T07:00:00.000Z',
          closedEarly: true,
          myVote: { castByMe: true, optionId: 'o2', castAt: '2026-11-10T08:00:00.000Z' },
          resultsAvailable: true,
          results: finalResults,
        }),
      },
    });
    expect(await screen.findByText(/\(erken kapatıldı\)/)).toBeTruthy();
    expect(screen.getByText('Oyunuz: Hayır')).toBeTruthy();
    expect(screen.getByText('Sizin oyunuz')).toBeTruthy();
    expect(screen.getByText('Sonuç: “Hayır” kullanılan oyların salt çoğunluğunu aldı (arsa payı).')).toBeTruthy();
    expect(screen.getByLabelText('Hayır, kazanan, sizin oyunuz: %70. 1 bölüm (%33,33) · arsa payı 840/1.200 (%70)')).toBeTruthy();
    expect(screen.getByLabelText('Katılım (bölüm): 3 / 3 bölüm · %100')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('Oylama ayrintisi: sonuclar, daire, ekran okuyucu, yenileme hatasi', () => {
  const liveResults = { ...finalResults, phase: 'open' as const, final: false };
  const openWithResults = (over: Partial<PortalPoll> = {}) =>
    poll({ secret: false, resultsVisibleBeforeClose: true, resultsAvailable: true, results: liveResults, myVote: { castByMe: true, optionId: 'o1' }, ...over });

  afterEach(async () => {
    jest.restoreAllMocks();
    await AsyncStorage.clear();
  });

  it('gizli oylama surerken: yalnizca katilim, dagilim yok', async () => {
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: { 'GET /api/portal/polls/p1': poll({ resultsAvailable: true, results: { ...liveResults, tallyHidden: true, options: undefined, winnerOptionId: undefined } }) },
    });
    expect(await screen.findByText('Gizli oylama sürüyor: seçeneklerin dağılımı oylama bitince açıklanır. Şimdilik yalnızca katılım görünür.')).toBeTruthy();
    expect(screen.getByLabelText('Katılım (bölüm): 3 / 3 bölüm · %100')).toBeTruthy();
    expect(screen.queryByLabelText(/^Evet.*: %/)).toBeNull();
  });

  it('oy degistirme: yanitta sonuc yok, ara sonuc yeniden cekim gelene kadar ekranda kalir', async () => {
    let voted = false;
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: {
        // Oy sonrasi yeniden cekim bekletilir: ekranda yalnizca oy yaniti + onceki sonuc var.
        'GET /api/portal/polls/p1': () => (voted ? new Promise(() => undefined) : openWithResults()),
        'POST /api/portal/polls/p1/vote': () => {
          voted = true;
          return openWithResults({ myVote: { castByMe: true, optionId: 'o2' }, results: undefined });
        },
      },
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Hayır' }));
    await fireEvent.press(button('Oyumu değiştir'));
    await fireEvent.press(button('Değişikliği onayla'));
    expect(await screen.findByText('Oyunuz: Hayır')).toBeTruthy();
    expect(screen.getByLabelText(/^Hayır, önde, sizin oyunuz: %70\./)).toBeTruthy();
    expect(screen.queryByText('Sonuçlar oylama bitince açıklanır.')).toBeNull();
  });

  it('ilk oy: sonuc acilir ama yanit sonuc tasimaz -> "yükleniyor", yeniden cekimle sonuc gelir', async () => {
    let release: () => void = () => undefined;
    let voted = false;
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: {
        'GET /api/portal/polls/p1': () =>
          voted
            ? new Promise((resolve) => {
                release = () => resolve(openWithResults({ myVote: { castByMe: true, optionId: 'o2' } }));
              })
            : poll({ secret: false, resultsVisibleBeforeClose: true, resultsAfterVote: true }),
        'POST /api/portal/polls/p1/vote': () => {
          voted = true;
          return poll({ secret: false, resultsVisibleBeforeClose: true, resultsAvailable: true, myVote: { castByMe: true, optionId: 'o2' } });
        },
      },
    });
    expect(await screen.findByText('Ara sonuçlar dairenizin oyu kullanıldıktan sonra görünür.')).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: 'Hayır' }));
    await fireEvent.press(button('Oyu gönder'));
    await fireEvent.press(button('Oyu onayla'));
    expect(await screen.findByText('Sonuçlar yükleniyor…')).toBeTruthy();
    await act(async () => release());
    expect(await screen.findByLabelText(/^Hayır, önde, sizin oyunuz: %70\./)).toBeTruthy();
  });

  it('secili daire okuma ve oy istegine ?unitId= olarak gider', async () => {
    await AsyncStorage.setItem('bm.portal-unit.mock-resident.apt-dev-1', 'u-9');
    const { calls } = await renderApp(<PollDetailScreen id="p1" />, {
      routes: voteRoutes(poll({ unitId: 'u-9' }), (optionId) => poll({ unitId: 'u-9', myVote: { castByMe: true, optionId } })),
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Evet' }));
    await fireEvent.press(button('Oyu gönder'));
    await fireEvent.press(button('Oyu onayla'));
    await screen.findByText('Oyunuz: Evet');
    expect(calls.find((c) => c.method === 'GET' && c.path === '/api/portal/polls/p1')?.query).toEqual({ unitId: 'u-9' });
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/api/portal/polls/p1/vote', query: { unitId: 'u-9' }, body: { optionId: 'o1' } });
  });

  it("iOS: onay adimi ve gonderim sonucu VoiceOver'a duyurulur (basari ve 409)", async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined);
    let closed = false;
    await renderApp(<PollDetailScreen id="p1" />, {
      routes: voteRoutes(poll(), (optionId) =>
        closed ? { status: 409, body: { error: 'poll_closed', message: 'Oylama sona erdi; oy kabul edilmiyor' } } : poll({ myVote: { castByMe: true, optionId } }),
      ),
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Evet' }));
    await fireEvent.press(button('Oyu gönder'));
    expect(announce).toHaveBeenLastCalledWith(
      '“Evet” seçeneğine oy vereceksiniz. Oylama bitene kadar verilen son oy geçerlidir; isterseniz sonra değiştirebilirsiniz. Oyu onayla düğmesiyle onaylayın.',
    );
    await fireEvent.press(button('Oyu onayla'));
    await waitFor(() => expect(announce).toHaveBeenLastCalledWith('Oyunuz kaydedildi. Oylama bitene kadar değiştirebilirsiniz.'));

    closed = true;
    await fireEvent.press(await screen.findByRole('radio', { name: 'Hayır' }));
    await fireEvent.press(button('Oyumu değiştir'));
    await fireEvent.press(button('Değişikliği onayla'));
    await waitFor(() => expect(announce).toHaveBeenLastCalledWith('Oyunuz kaydedilmedi: Oylama sona erdi; oy kabul edilmiyor.'));
  });

  it('arka plan yenilemesi hata verirse ekran ve secim korunur; satir ici uyari + tekrar dene', async () => {
    let fail = false;
    const { queryClient } = await renderApp(<PollDetailScreen id="p1" />, {
      routes: { 'GET /api/portal/polls/p1': () => (fail ? { status: 503, body: { error: 'unavailable', message: 'Servis geçici olarak kullanılamıyor.' } } : poll()) },
    });
    await fireEvent.press(await screen.findByRole('radio', { name: 'Hayır' }));
    fail = true;
    await act(async () => {
      await queryClient.refetchQueries();
    });
    expect(await screen.findByText(/^Güncel bilgiler alınamadı; son yüklenen bilgiler gösteriliyor\. Servis geçici/)).toBeTruthy();
    expect(radio('Hayır').props.accessibilityState).toMatchObject({ checked: true });
    fail = false;
    await fireEvent.press(button('Tekrar dene'));
    await waitFor(() => expect(screen.queryByText(/^Güncel bilgiler alınamadı/)).toBeNull());
    expect(radio('Hayır').props.accessibilityState).toMatchObject({ checked: true });
  });
});
