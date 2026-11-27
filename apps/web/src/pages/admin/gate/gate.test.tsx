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
let rotated: unknown;
let myPasses: unknown[] = [];
const portal = { respondCourier: mutation(), createPass: mutation(), revokePass: mutation(), rotatePass: mutation(() => rotated), createVehicle: mutation(), updateVehicle: mutation() };

vi.mock('@/hooks/useGate', () => ({
  useGatePermissions: () => perms,
  useDeskActions: () => desk,
  useDeskCouriers: () => ({ data: { items: [], pollSeconds: 15 }, isPending: false, isError: false }),
  usePlateLookup: () => ({ isPending: true }),
  useGateUnits: () => ({ data: [{ unitId: 'u1', label: 'A Blok · Daire 5' }] }),
  useUnitResidents: (unitId: string) => ({ isPending: false, data: unitId ? [{ userId: 'tenant-u1', name: 'Ayşe Kiracı' }] : [] }),
  useGateLog: () => ({ isPending: false, isError: false, data: { pages: [] }, hasNextPage: false }),
  useAllVehicles: () => ({ isPending: false, isError: false, data: { items: [], maxPerUnit: 4 } }),
  useManagerPasses: () => ({ isPending: false, isError: false, data: [] }),
  useMyGate: () => ({ isPending: false, isError: false, data: { units: [{ unitId: 'u1', label: 'A Blok · Daire 5' }], limits: { maxVehiclesPerUnit: 4, maxPassDays: 31, maxPassLeadDays: 90, courierResponseMinutes: 60 } } }),
  useMyCouriers: () => ({ data: myCouriers }),
  useMyPasses: () => ({ isPending: false, isError: false, data: myPasses }),
  useMyVehicles: () => ({ isPending: false, isError: false, data: { items: [] } }),
  useMyGateActions: () => portal,
}));
vi.mock('react-router', () => ({ useSearchParams: () => [new URLSearchParams(), vi.fn()] }));

vi.mock('@/hooks/useQrDataUrl', () => ({ useQrDataUrl: (text?: string) => (text ? 'data:image/png;base64,QR' : undefined) }));
const { GatePage } = await import('./GatePage');
const { QrScanner } = await import('./QrScanner');
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
  it('yanit kaybolsa da "Yeni gecis okut" sonraki misafir icin yeni idempotency anahtari uretir', async () => {
    perms = { canUseDesk: true, canManage: false, isGuard: true };
    verifyResult = { pass: pass() };
    // Giris yaniti kayboldu (ag hatasi): onSuccess hic cagrilmaz.
    desk.passEntry.mutate.mockImplementationOnce(() => undefined);
    await render(<GatePage />);
    await submitCode('K7M2PQ4X');
    await click(button('Giriş kaydet'));
    await click(button('Yeni geçiş okut'));
    verifyResult = { pass: pass({ passId: 'p2', guestName: 'İkinci Misafir' }) };
    await submitCode('ABCD2345');
    await click(button('Giriş kaydet'));
    const keys = desk.passEntry.mutate.mock.calls.map((c) => (c[0] as { key: string }).key);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('kamera: play() reddedilirse akis durdurulur ve elle kod girisine yonlendirilir', async () => {
    const stopTrack = vi.fn();
    const g = globalThis as unknown as { BarcodeDetector?: unknown; isSecureContext?: boolean };
    const nav = navigator as unknown as { mediaDevices?: unknown };
    const prev = { detector: g.BarcodeDetector, media: nav.mediaDevices, play: HTMLMediaElement.prototype.play, src: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject') };
    // happy-dom gercek MediaStream bekler: sahte akisi kabul eden ayarlayici.
    Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get: () => null, set: () => undefined });
    g.BarcodeDetector = class {
      detect = async () => [];
    };
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) } });
    HTMLMediaElement.prototype.play = vi.fn(async () => {
      throw Object.assign(new Error('izin'), { name: 'NotAllowedError' });
    });
    try {
      await render(<QrScanner onResult={vi.fn()} onClose={vi.fn()} />);
      await act(async () => new Promise((r) => setTimeout(r, 0)));
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      expect(stopTrack).toHaveBeenCalled();
      expect(container.textContent).toContain('Kamera izni verilmedi');
    } finally {
      g.BarcodeDetector = prev.detector;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: prev.media });
      HTMLMediaElement.prototype.play = prev.play;
      if (prev.src) Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', prev.src);
      else delete (HTMLMediaElement.prototype as unknown as { srcObject?: unknown }).srcObject;
    }
  });
  it('yonetici araci bolumde oturan sakin adina kaydeder (sahip secimi zorunlu)', async () => {
    perms = { canUseDesk: true, canManage: true, isGuard: false };
    await render(<GatePage />);
    await click(button('Araçlar'));
    const save = () => button('Aracı kaydet') as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    const selects = () => [...container.querySelectorAll('select')] as HTMLSelectElement[];
    const choose = async (el: HTMLSelectElement | undefined, value: string) => {
      if (!el) throw new Error('secici yok');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
      await act(async () => {
        setter?.call(el, value);
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
    };
    await choose(selects()[0], 'u1');
    expect(container.textContent).toContain('Aracın sahibi');
    expect(save().disabled).toBe(true);
    await choose(selects()[1], 'tenant-u1');
    const plateInput = [...container.querySelectorAll('input')].find((i) => i.className.includes('font-mono')) ?? null;
    await type(plateInput, '34 abc 123');
    await click(save());
    expect(desk.createVehicle.mutate).toHaveBeenCalledWith({ unitId: 'u1', ownerUserId: 'tenant-u1', plate: '34ABC123' }, expect.anything());
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
  it('listede QR yeniden gosterilmez; "Yeni QR olustur" onayla yenilenir ve yeni QR acilir', async () => {
    myCouriers = [];
    const base = {
      passId: 'p1', unitId: 'u1', unitLabel: 'A Blok · Daire 5', guestName: 'Can', validFrom: '2026-11-27', validUntil: '2026-11-27', entryMode: 'single', status: 'active',
      verdict: 'valid', entryCount: 0, inside: false, createdAt: '2026-11-27T08:00:00.000Z', mine: true, canRevoke: true, canRotate: true, version: 1,
    };
    myPasses = [base];
    rotated = { pass: { ...base, version: 2, token: 'AbCdEfGhIjKlMnOpQrStUv_-', shortCode: 'ABCD2345' } };
    await render(<MyGatePage />);
    expect(container.textContent).not.toContain('ABCD-2345');
    await click(button('Yeni QR oluştur'));
    expect(container.textContent).toContain('daha önce paylaştığınız QR ve kod çalışmaz');
    expect(portal.rotatePass.mutate).not.toHaveBeenCalled();
    await click(button('Evet, yeni QR oluştur'));
    expect(portal.rotatePass.mutate).toHaveBeenCalledWith({ id: 'p1', version: 1 }, expect.anything());
    expect(document.body.textContent).toContain('ABCD-2345');
    myPasses = [];
  });
});
