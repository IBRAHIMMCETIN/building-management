import type { PortalPoll } from '@bm/shared/api/polls';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';
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
