import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { Linking } from 'react-native';
import { renderApp } from '@/test/renderApp';
import { tender, tenderSummary } from '@/test/tenderFixtures';
import { TenderDetailScreen } from './TenderDetailScreen';
import { TendersScreen, istanbulToday, tenderCardLines } from './TendersScreen';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn(), WebBrowserPresentationStyle: { PAGE_SHEET: 'pageSheet' } }));

beforeEach(() => mockPush.mockClear());

describe('İhaleler', () => {
  it('paylasilan ve karara baglanan ihaleler; dokununca ayrinti', async () => {
    await renderApp(<TendersScreen />, {
      routes: {
        'GET /api/portal/tenders': {
          items: [
            tenderSummary(),
            tenderSummary({
              tenderId: 't-2',
              title: 'Asansör revizyonu',
              category: 'asansor',
              status: 'decided',
              decision: { quoteId: 'q', reason: 'Uygun', supplierName: 'Güven Asansör', netKurus: 1, vatKurus: 0, totalKurus: 48_600_000, decidedAt: '2026-10-01T08:00:00.000Z' },
            }),
          ],
        },
      },
    });
    const first = await screen.findByRole('button', { name: 'Dış cephe mantolama, Sakinlerle paylaşıldı, Mantolama / dış cephe, Teklif: 2/3 · En düşük: ₺120.000,00' });
    expect(screen.getByRole('button', { name: /^Asansör revizyonu, Karara bağlandı, Asansör, .*Seçilen: Güven Asansör · ₺486\.000,00$/ })).toBeTruthy();
    await fireEvent.press(first);
    expect(mockPush).toHaveBeenCalledWith({ pathname: '/resident/tenders/[id]', params: { id: 't-1' } });
  });

  it('ihale yoksa bos durum', async () => {
    await renderApp(<TendersScreen />, { routes: { 'GET /api/portal/tenders': { items: [] } } });
    expect(await screen.findByText('Paylaşılmış ihale yok')).toBeTruthy();
  });

  it('teklif toplanirken son gun metni (web TenderCard kurali)', () => {
    const lines = tenderCardLines(tenderSummary({ status: 'collecting', deadline: '2026-12-01', quoteCount: 1, lowestTotalKurus: undefined }), '2026-11-28');
    expect(lines.outcome).toBe('Son teklif: 1 Ara 2026 · 3 gün kaldı');
    expect(lines.short).toBe(true);
    expect(istanbulToday(new Date('2026-11-28T22:30:00.000Z'))).toBe('2026-11-29');
  });
});

describe('İhale ayrintisi', () => {
  it('teklifler KDV dahil toplama gore sirali; en dusuk ve fark; geri cekilen teklif gerekcesiyle', async () => {
    await renderApp(<TenderDetailScreen id="t-1" />, { routes: { 'GET /api/portal/tenders/t-1': { tender: tender() } } });
    expect(await screen.findByRole('header', { name: 'Dış cephe mantolama' })).toBeTruthy();
    const headers = screen.getAllByRole('header').map((h) => h.props.children);
    expect(headers.indexOf('Cephe A.Ş.')).toBeLessThan(headers.indexOf('Yalıtım Ltd.'));
    expect(screen.getByText('En düşük')).toBeTruthy();
    expect(screen.getByText('2. sırada')).toBeTruthy();
    expect(screen.getAllByLabelText('KDV dahil toplam: ₺120.000,00')).toHaveLength(1);
    expect(screen.getByLabelText('Teklifteki tutar: ₺100.000,00 + KDV')).toBeTruthy();
    expect(screen.getByLabelText('KDV: ₺20.000,00 (%20)')).toBeTruthy();
    expect(screen.getByLabelText('En düşüğe göre: +₺30.000,00 (%25)')).toBeTruthy();
    expect(screen.getByLabelText('Garanti: Yok')).toBeTruthy();
    expect(screen.getByLabelText('Garanti: 2 yıl')).toBeTruthy();
    expect(screen.getByText('Geri çekilen teklifler')).toBeTruthy();
    expect(screen.getByText('₺90.000,00 KDV dahil · Firma vazgeçti')).toBeTruthy();
  });

  it('teklif belgesi: imzali link istenir ve sistem goruntuleyicisinde acilir', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
    await renderApp(<TenderDetailScreen id="t-1" />, {
      routes: {
        'GET /api/portal/tenders/t-1': { tender: tender() },
        'GET /api/portal/tenders/t-1/quotes/q-b/document': { url: 'https://s3.test/teklif.pdf?sig=1', fileName: 'q-b.pdf', contentType: 'application/pdf', expiresAt: '2026-11-28T09:05:00.000Z' },
      },
    });
    await fireEvent.press(await screen.findByRole('button', { name: 'Cephe A.Ş. teklif belgesini aç' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith('https://s3.test/teklif.pdf?sig=1'));
    // Belge alinamazsa hata (diger teklif icin uc tanimli degil).
    await fireEvent.press(screen.getByRole('button', { name: 'Yalıtım Ltd. teklif belgesini aç' }));
    expect(await screen.findByText('Kayıt bulunamadı.')).toBeTruthy();
  });

  it('sorular: sakinler birbirinin kimligini gormez ("Sakin" / "Siz"), yonetim yaniti ayri', async () => {
    await renderApp(<TenderDetailScreen id="t-1" />, { routes: { 'GET /api/portal/tenders/t-1': { tender: tender() } } });
    expect(await screen.findByLabelText(/^Sakin, .*: İskele ne zaman kurulacak\?$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Yönetim, .*: Karar sonrası iki hafta içinde\.$/)).toBeTruthy();
    expect(screen.getByLabelText(/^Siz, .*: Garanti süresi uzatılabilir mi\?$/)).toBeTruthy();
    expect(screen.getByText('Diğer sakinler sorunuzu adınız olmadan görür.')).toBeTruthy();
  });

  it('soru gonderme: en az 3 karakter; ayni anahtarla tekrar denenir, basarida yenilenir', async () => {
    let fail = true;
    let current = tender();
    const { calls } = await renderApp(<TenderDetailScreen id="t-1" />, {
      routes: {
        'GET /api/portal/tenders/t-1': () => ({ tender: current }),
        'POST /api/portal/tenders/t-1/comments': ({ body }: { body: { body: string } }) => {
          if (fail) return { status: 503, body: { error: 'unavailable', message: 'Servis geçici olarak kullanılamıyor.' } };
          current = tender({ comments: [...current.comments, { commentId: `c${current.comments.length + 1}`, body: body.body, authorKind: 'resident', mine: true, createdAt: '2026-11-28T09:00:00.000Z' }] });
          return { tender: current, replayed: false };
        },
      },
    });
    const field = await screen.findByLabelText('Sorunuz');
    const send = () => screen.getByRole('button', { name: 'Soruyu gönder' });
    expect(send().props.accessibilityState?.disabled).toBe(true);

    await fireEvent.changeText(field, ' ab ');
    await fireEvent.press(send());
    expect(await screen.findByText('Mesaj en az 3 karakter olmalı.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await fireEvent.changeText(field, '  Ödeme takvimi nasıl olacak?  ');
    await fireEvent.press(send());
    expect(await screen.findByText('Servis geçici olarak kullanılamıyor.')).toBeTruthy();
    fail = false;
    await fireEvent.press(send());
    expect(await screen.findByLabelText(/^Siz, .*: Ödeme takvimi nasıl olacak\?$/)).toBeTruthy();

    const posts = calls.filter((c) => c.method === 'POST').map((c) => c.body as { idempotencyKey: string; body: string });
    expect(posts).toHaveLength(2);
    expect(posts[0]?.body).toBe('Ödeme takvimi nasıl olacak?');
    expect(posts[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(posts[1]?.idempotencyKey).toBe(posts[0]?.idempotencyKey);
    expect(screen.getByLabelText('Sorunuz').props.value).toBe('');

    // Yeni soru yeni anahtarla.
    await fireEvent.changeText(screen.getByLabelText('Sorunuz'), 'İkinci soru burada');
    await fireEvent.press(send());
    expect(await screen.findByLabelText(/^Siz, .*: İkinci soru burada$/)).toBeTruthy();
    const last = calls.filter((c) => c.method === 'POST').at(-1)?.body as { idempotencyKey: string };
    expect(last.idempotencyKey).not.toBe(posts[0]?.idempotencyKey);
  });

  it('karara baglanan ihale: karar, gerekce, referans; soru yazilamaz', async () => {
    await renderApp(<TenderDetailScreen id="t-1" />, {
      routes: {
        'GET /api/portal/tenders/t-1': {
          tender: tender({
            status: 'decided',
            canComment: false,
            shortfallReason: 'Üçüncü firma teklif vermedi.',
            decision: { quoteId: 'q-a', reason: 'Daha uzun garanti.', reference: 'Genel kurul 2026/2', supplierName: 'Yalıtım Ltd.', netKurus: 125_000_00, vatKurus: 25_000_00, totalKurus: 150_000_00, decidedAt: '2026-11-25T08:00:00.000Z' },
          }),
        },
      },
    });
    expect(await screen.findByRole('header', { name: 'Yönetimin kararı: Yalıtım Ltd. · ₺150.000,00' })).toBeTruthy();
    expect(screen.getByText(/En düşük teklif seçilmedi$/)).toBeTruthy();
    expect(screen.getByText('Karar referansı: Genel kurul 2026/2')).toBeTruthy();
    expect(screen.getByText('Seçilen teklif')).toBeTruthy();
    expect(screen.getByText('3 teklif hedeflenmişti, 2 teklif alındı. Yönetimin açıklaması: Üçüncü firma teklif vermedi.')).toBeTruthy();
    expect(screen.queryByLabelText('Sorunuz')).toBeNull();
    expect(screen.getByText('Sorular yalnızca ihale sakinlerle paylaşıldıktan sonra ve karar verilene kadar yazılabilir.')).toBeTruthy();
  });
});
