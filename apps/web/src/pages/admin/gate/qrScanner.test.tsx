// @vitest-environment happy-dom
/**
 * Gorevli QR tarayicisi: motor secimi (BarcodeDetector yoksa jsqr yedegi), ilk okunan degerde
 * kameranin kapanmasi, sekme arka plana gecince kapanip geri gelince yeniden acilmasi, ekrandan
 * cikinca kapanmasi ve yedek cozucu yuklenemezse elle kod girisine yonlendirme.
 */
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const engines: string[] = [];
let decoded: (string | undefined)[] = [];
let failLoad = false;
vi.mock('@/lib/gate/qrDecode', () => ({
  SCAN_INTERVAL_MS: 1,
  createFrameScanner: vi.fn(async (engine: string) => {
    engines.push(engine);
    if (failLoad) throw new Error('parca yuklenemedi');
    return async () => decoded.shift();
  }),
}));
const { QrScanner } = await import('./QrScanner');

const g = globalThis as unknown as { BarcodeDetector?: unknown };
const nav = navigator as unknown as { mediaDevices?: unknown };
let container: HTMLDivElement;
let root: Root;
let hidden = false;
const stopTrack = vi.fn();
const getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] }));
const prev = { detector: g.BarcodeDetector, media: nav.mediaDevices, play: HTMLMediaElement.prototype.play, src: Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject') };

const wait = (ms = 20) => act(async () => new Promise((r) => setTimeout(r, ms)));

beforeEach(() => {
  engines.length = 0;
  decoded = [];
  failLoad = false;
  hidden = false;
  stopTrack.mockClear();
  getUserMedia.mockClear();
  delete g.BarcodeDetector;
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', { configurable: true, get: () => null, set: () => undefined });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  g.BarcodeDetector = prev.detector;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: prev.media });
  HTMLMediaElement.prototype.play = prev.play;
  if (prev.src) Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', prev.src);
  else delete (HTMLMediaElement.prototype as unknown as { srcObject?: unknown }).srcObject;
  delete (document as unknown as { hidden?: boolean }).hidden;
});

const render = async (onResult = vi.fn()) => {
  await act(async () => root.render(<QrScanner onResult={onResult} onClose={vi.fn()} />));
  await wait();
  return onResult;
};

describe('QR tarayici', () => {
  it('BarcodeDetector yoksa (iPhone Safari) yedek motorla tarar; ilk okunan degerde kamera kapanir', async () => {
    decoded = [undefined, undefined, 'K7M2PQ4X', 'IKINCI'];
    const onResult = await render();
    await wait(40);
    expect(engines).toEqual(['fallback']);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult).toHaveBeenCalledWith('K7M2PQ4X');
    expect(stopTrack).toHaveBeenCalled();
    expect(getUserMedia).toHaveBeenCalledWith({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  });

  it('yerlesik BarcodeDetector varsa onu kullanir (yedek cozucu yuklenmez)', async () => {
    g.BarcodeDetector = class {
      detect = async () => [];
    };
    await render();
    expect(engines).toEqual(['native']);
    expect(container.textContent).toContain('QR kodu çerçeveye getirin');
  });

  it('sekme arka plana gecince kamera kapanir, geri gelince yeniden acilir; ekrandan cikinca kapanir', async () => {
    await render();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    hidden = true;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(stopTrack).toHaveBeenCalledTimes(1);
    hidden = false;
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    await wait();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
    expect(stopTrack).toHaveBeenCalledTimes(2);
    root = createRoot(container);
  });

  it('yedek cozucu yuklenemezse kamera kapanir ve kisa kod girisine yonlendirir', async () => {
    failLoad = true;
    await render();
    expect(stopTrack).toHaveBeenCalled();
    expect(container.textContent).toContain('QR okuyucu yüklenemedi');
  });
});
