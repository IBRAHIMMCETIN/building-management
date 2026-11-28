import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { createPlanRequestsDemo } from '@/dev/demoPlanRequests';
import { renderApp } from '@/test/renderApp';
import { RestructureRequestCard } from './RestructureRequestCard';

const MAIN = 'recv-u1-occupant';
const OPTIONS = {
  unitId: 'u1',
  settings: { enabled: true, maxInstallments: 6, minInstallmentAmount: 50000, includeLateFees: true },
  minInstallments: 2,
  accounts: [{ accountId: MAIN, liableParty: 'occupant', overdue: 300000, accruedLateFee: 1200, total: 301200, maxInstallments: 4, eligible: true }],
};
const request = (over: Record<string, unknown>) => ({
  requestId: 'r1',
  unitId: 'u1',
  accountId: MAIN,
  liableParty: 'occupant',
  installments: 3,
  estimate: { overdue: 300000, accruedLateFee: 1200, total: 301200, installmentAmount: 100400 },
  status: 'pending',
  createdAt: '2026-11-05T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
  ...over,
});

describe('Borçlarım - taksit talebi karti', () => {
  it('sinirli taksit secimi, aylik tutar; talep gonderilir', async () => {
    const { calls } = await renderApp(<RestructureRequestCard />, {
      routes: {
        'GET /api/portal/plan-requests/options': OPTIONS,
        'GET /api/portal/plan-requests': { items: [] },
        'POST /api/portal/plan-requests': ({ body }: { body: Record<string, unknown> }) => ({ status: 201, body: { replayed: false, request: request({ installments: body.installments }) } }),
      },
    });
    expect(await screen.findByText('Taksit talebi')).toBeTruthy();
    expect(screen.getByText('Taksitlenecek: yaklaşık ₺3.012,00')).toBeTruthy();
    // 2..4 taksit; varsayilan 3.
    expect(screen.getByRole('radio', { name: '2 taksit' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: '5 taksit' })).toBeNull();
    expect(screen.getByText(/Aylık yaklaşık ₺1\.004,00/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('radio', { name: '4 taksit' }));
    expect(screen.getByText(/Aylık yaklaşık ₺753,00/)).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Talep gönder' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/portal/plan-requests')).toBe(true));
    const post = calls.find((c) => c.method === 'POST' && c.path === '/api/portal/plan-requests');
    expect(post?.body).toMatchObject({ liableParty: 'occupant', installments: 4, idempotencyKey: expect.any(String) });
    expect(await screen.findByText('Talebiniz yönetime iletildi. Sonucu burada ve bildirimle göreceksiniz.')).toBeTruthy();
  });

  it('talep durumlari: bekleyen geri cekilir, reddedilen gerekce; borc yoksa kart gizli', async () => {
    const { calls } = await renderApp(<RestructureRequestCard />, {
      routes: {
        'GET /api/portal/plan-requests/options': { ...OPTIONS, accounts: [{ ...OPTIONS.accounts[0], eligible: false, reason: 'pending_request', pendingRequest: 'mine', pendingRequestId: 'r1' }] },
        'GET /api/portal/plan-requests': { items: [request({}), request({ requestId: 'r0', status: 'rejected', decision: { at: '2026-10-02T09:00:00.000Z', mode: 'rejected', reason: 'Önce ödeme yapın' } })] },
        'POST /api/portal/plan-requests/r1/withdraw': { request: request({ status: 'withdrawn', decision: { at: '2026-11-06T09:00:00.000Z', mode: 'withdrawn', reason: 'x' } }) },
      },
    });
    expect(await screen.findByText('Onay bekliyor')).toBeTruthy();
    expect(screen.getByText('Gerekçe: Önce ödeme yapın')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Talep gönder' })).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Taksit talebini geri çek' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.path === '/api/portal/plan-requests/r1/withdraw')).toBe(true));
  });

  it('ozellik kapali (403) veya talep edilecek borc yoksa kart gosterilmez', async () => {
    await renderApp(<RestructureRequestCard />, {
      routes: {
        'GET /api/portal/plan-requests/options': { status: 403, body: { error: 'feature_disabled', message: 'Kapalı' } },
        'GET /api/portal/plan-requests': { status: 403, body: { error: 'feature_disabled', message: 'Kapalı' } },
      },
    });
    await waitFor(() => expect(screen.queryByText('Taksit talebi')).toBeNull());
  });

  it('yonetim talep almiyor (secenekler 403): form yok, gecmis talep ve karari gorunur', async () => {
    await renderApp(<RestructureRequestCard />, {
      routes: {
        'GET /api/portal/plan-requests/options': { status: 403, body: { error: 'forbidden', message: 'Yönetim şu anda taksit talebi almıyor' } },
        'GET /api/portal/plan-requests': { items: [request({ requestId: 'r0', status: 'rejected', decision: { at: '2026-10-02T09:00:00.000Z', mode: 'rejected', reason: 'Talepler kapandı' } })] },
      },
    });
    expect(await screen.findByText('Gerekçe: Talepler kapandı')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Talep gönder' })).toBeNull();
  });
});

describe('demo veri (yalnizca __DEV__)', () => {
  it('secenek, talep, tekrar gonderim ve geri cekme', () => {
    const demo = createPlanRequestsDemo();
    const now = new Date('2026-11-28T09:00:00.000Z');
    const req = (method: string, path: string, body?: unknown) => demo({ method, path, query: {}, body, now, claims: {} as never });
    expect((req('GET', '/api/portal/plan-requests/options')?.body as { accounts: { eligible: boolean }[] }).accounts[0]?.eligible).toBe(true);
    const created = req('POST', '/api/portal/plan-requests', { idempotencyKey: 'k-1', installments: 3 });
    expect(created?.status).toBe(201);
    expect(req('POST', '/api/portal/plan-requests', { idempotencyKey: 'k-1', installments: 3 })?.status).toBe(200);
    expect(req('POST', '/api/portal/plan-requests', { idempotencyKey: 'k-2', installments: 2 })?.status).toBe(409);
    const id = (created?.body as { request: { requestId: string } }).request.requestId;
    expect(req('POST', `/api/portal/plan-requests/${id}/withdraw`)?.status).toBe(200);
    expect((req('GET', '/api/portal/plan-requests')?.body as { items: { status: string }[] }).items.map((r) => r.status)).toEqual(['withdrawn', 'rejected']);
    expect(req('GET', '/api/portal/tenders')).toBeUndefined();
  });
});
