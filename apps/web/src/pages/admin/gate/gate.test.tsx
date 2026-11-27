// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/lib/api/client', () => ({ apiClient: {} }));
import type { Courier, DeskPass } from '@/lib/api/gate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Opts = { onSuccess?: (r: unknown) => void; onError?: (e: unknown) => void; onSettled?: () => void };
let verifyResult: { pass: DeskPass } | undefined;
const mutation = (result?: () => unknown) => ({
  isPending: false,
  error: null,
  variables: undefined,
  reset: vi.fn(),
  mutate: vi.fn((_v: unknown, o?: Opts) => o?.onSuccess?.(result?.())),
});
const desk = {
  verify: mutation(() => verifyResult),
  passEntry: mutation(() => ({ pass: { ...verifyResult?.pass, canEnter: false, canExit: true, verdict: 'used' } })),
  passExit: mutation(),
  revokePass: mutation(),
  createCourier: mutation(),
  courierEntry: mutation(),
  courierExit: mutation(),
  cancelCourier: mutation(),
  manualEntry: mutation(),
  createVehicle: mutation(),
  updateVehicle: mutation(),
};
let perms = { canUseDesk: true, canManage: false, isGuard: true };
let myCouriers: Courier[] = [];
const portal = { respondCourier: mutation(), createPass: mutation(), revokePass: mutation(), createVehicle: mutation(), updateVehicle: mutation() };

vi.mock('@/hooks/useGate', () => ({
  useGatePermissions: () => perms,
  useDeskActions: () => desk,
  useDeskCouriers: () => ({ data: { items: [], pollSeconds: 15 }, isPending: false, isError: false }),
  usePlateLookup: () => ({ isPending: true }),
  useGateUnits: () => ({ data: [] }),
  useGateLog: () => ({ isPending: false, isError: false, data: { pages: [] }, hasNextPage: false }),
  useAllVehicles: () => ({ isPending: false, isError: false, data: { items: [], maxPerUnit: 4 } }),
  useManagerPasses: () => ({ isPending: false, isError: false, data: [] }),
  useMyGate: () => ({ isPending: false, isError: false, data: { units: [{ unitId: 'u1', label: 'A Blok · Daire 5' }], limits: { maxVehiclesPerUnit: 4, maxPassDays: 31, maxPassLeadDays: 90, courierResponseMinutes: 60 } } }),
  useMyCouriers: () => ({ data: myCouriers }),
  useMyPasses: () => ({ isPending: false, isError: false, data: [] }),
  useMyVehicles: () => ({ isPending: false, isError: false, data: { items: [] } }),
  useMyGateActions: () => portal,
}));
vi.mock('react-router', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));

const { GatePage } = await import('./GatePage');
const { MyGatePage } = await import('@/pages/resident/gate/MyGatePage');

const pass = (over: Partial<DeskPass> = {}): DeskPass => ({
  passId: 'p1',
  unitId: 'u1',
  unitLabel: 'A Blok · Daire 5',
  guestName: 'Mehmet Misafir',
  validFrom: '2026-11-27',
  validUntil: '2026-11-27',
  entryMode: 'single',
  verdict: 'valid',
  entryCount: 0,
  inside: false,
  canEnter: true,
  canExit: false,
  version: 1,
  ...over,
});

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
const click = async (el: Element | null | undefined) => {
  if (!el) throw new Error('eleman yok');
  await act(async () => (el as HTMLElement).click());
};
const type = async (el: Element | null, value: string) => {
  const input = el as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submitCode = async (code: string) => {
  await type(container.querySelector('#gate-code'), code);
  await act(async () => container.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

describe('guvenlik kapisi ekrani', () => {
  it('gorevli: arac / gecis yonetimi sekmeleri yok; yonetici gorur', async () => {
    perms = { canUseDesk: true, canManage: false, isGuard: true };
    await render(<GatePage />);
    expect(button('Plaka sorgu')).toBeTruthy();
    expect(button('Kurye')).toBeTruthy();
    expect(button('Araçlar')).toBeUndefined();
    expect(button('Misafir geçişleri')).toBeUndefined();
    container.remove();
    perms = { canUseDesk: true, canManage: true, isGuard: false };
    await render(<GatePage />);
    expect(button('Araçlar')).toBeTruthy();
    expect(button('Misafir geçişleri')).toBeTruthy();
  });

  it('kisa kodla gecerli gecis: misafir ve ev sahibi bolum; giris kaydi idempotency anahtariyla', async () => {
    perms = { canUseDesk: true, canManage: false, isGuard: true };
    verifyResult = { pass: pass() };
    await render(<GatePage />);
    await submitCode('k7m2-pq4x');
    expect(desk.verify.mutate).toHaveBeenCalledWith({ code: 'K7M2PQ4X' }, expect.anything());
    expect(container.textContent).toContain('Geçiş geçerli');
    expect(container.textContent).toContain('Mehmet Misafir');
    expect(container.textContent).toContain('A Blok · Daire 5');
    await click(button('Giriş kaydet'));
    const [arg] = desk.passEntry.mutate.mock.calls[0] as [{ id: string; key: string }];
    expect(arg.id).toBe('p1');
    expect(arg.key).toMatch(/^[0-9a-f-]{36}$/);
    expect(container.textContent).toContain('Mehmet Misafir için giriş kaydedildi.');
    expect(button('Giriş kaydet')).toBeUndefined();
    expect(button('Çıkış kaydet')).toBeTruthy();
  });

  it('suresi dolmus / kullanilmis gecis acikca reddedilir; giris dugmesi yok', async () => {
    perms = { canUseDesk: true, canManage: false, isGuard: true };
    verifyResult = { pass: pass({ verdict: 'expired', message: 'Bu geçişin süresi doldu', canEnter: false }) };
    await render(<GatePage />);
    await submitCode('K7M2PQ4X');
    expect(container.textContent).toContain('Geçiş reddedildi');
    expect(container.textContent).toContain('Bu geçişin süresi doldu');
    expect(button('Giriş kaydet')).toBeUndefined();
  });

  it('tanınmayan kod sunucuya gitmez; kamera yoksa elle girise yonlendirilir', async () => {
    perms = { canUseDesk: true, canManage: false, isGuard: true };
    await render(<GatePage />);
    await submitCode('12');
    expect(desk.verify.mutate).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Kod tanınmadı');
    // happy-dom'da BarcodeDetector yok: aciklama gosterilir, kod alani kalir.
    await click(button('QR okut'));
    expect(container.textContent).toMatch(/QR okumayı desteklemiyor|kamera erişimi yok|güvenli \(https\)/);
    expect(container.querySelector('#gate-code')).toBeTruthy();
  });
});

describe('sakin ziyaretci ekrani', () => {
  it('kapidaki kurye icin onay / red', async () => {
    myCouriers = [
      {
        courierId: 'c1', unitId: 'u1', unitLabel: 'A Blok · Daire 5', company: 'Trendyol', status: 'waiting', expired: false, respondBy: '2026-11-27T10:00:00.000Z',
        createdAt: '2026-11-27T09:00:00.000Z', canRespond: true, canEnter: false, canExit: false, canCancel: false, version: 1,
      },
    ];
    await render(<MyGatePage />);
    expect(container.textContent).toContain('Kapıda kurye var');
    expect(container.textContent).toContain('Trendyol');
    await click(button('İçeri alınsın'));
    expect(portal.respondCourier.mutate).toHaveBeenCalledWith({ id: 'c1', version: 1, decision: 'approve' });
  });

  it('bekleyen kurye yoksa uyari karti yok', async () => {
    myCouriers = [];
    await render(<MyGatePage />);
    expect(container.textContent).not.toContain('Kapıda kurye var');
    expect(button('Misafir geçişi oluştur')).toBeTruthy();
  });
});
