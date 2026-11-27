// @vitest-environment happy-dom
/**
 * QR okuma motoru secimi (yerlesik BarcodeDetector / jsqr yedegi), kare kucultme ve yedek cozucunun
 * gercek bir QR goruntusunu cozmesi. Goruntu `qrcode` paketiyle (uygulamanin sakin QR'ini ureten
 * kutuphane) testte uretilir; ag yok.
 */
import QRCode from 'qrcode';
import { describe, expect, it, vi } from 'vitest';
import { scanEngine } from './camera';
import { FALLBACK_MAX_SIDE, createFrameDecoder, createFrameScanner, downscaledSize, loadJsQr } from './qrDecode';

/** QR modullerini RGBA piksel dizisine cizer (koyu modul siyah, sessiz bolge beyaz). */
function qrImage(text: string, scale = 4, margin = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const side = (n + margin * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const i = (((r + margin) * scale + y) * side + (c + margin) * scale + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
      }
    }
  }
  return { data, width: side, height: side };
}

describe('QR motoru secimi', () => {
  it('BarcodeDetector yoksa yedek; QR bicimini bildirmeyen / hata veren yerlesik motorda yedek; aksi halde yerlesik', async () => {
    expect(await scanEngine({})).toBe('fallback');
    expect(await scanEngine({ BarcodeDetector: class {} })).toBe('native');
    expect(await scanEngine({ BarcodeDetector: Object.assign(class {}, { getSupportedFormats: async () => ['qr_code', 'ean_13'] }) })).toBe('native');
    expect(await scanEngine({ BarcodeDetector: Object.assign(class {}, { getSupportedFormats: async () => ['ean_13'] }) })).toBe('fallback');
    expect(
      await scanEngine({
        BarcodeDetector: Object.assign(class {}, {
          getSupportedFormats: async () => {
            throw new Error('yok');
          },
        }),
      }),
    ).toBe('fallback');
  });

  it('yerlesik motor ek kutuphane yuklemez; yedek motor cozucuyu yalnizca kendisi yukler', async () => {
    const loadDecoder = vi.fn(async () => () => 'x');
    const native = await createFrameScanner('native', { detector: () => ({ detect: async () => [{ rawValue: '' }, { rawValue: 'tok' }] }), loadDecoder });
    expect(await native({} as HTMLVideoElement)).toBe('tok');
    expect(loadDecoder).not.toHaveBeenCalled();
    await createFrameScanner('fallback', { loadDecoder });
    expect(loadDecoder).toHaveBeenCalledTimes(1);
  });
});

describe('kare kucultme', () => {
  it('uzun kenar en fazla 480 px, oran korunur; kucuk kare buyutulmez; bos kare 0', () => {
    expect(downscaledSize(1920, 1080)).toEqual({ width: FALLBACK_MAX_SIDE, height: 270 });
    expect(downscaledSize(1080, 1920)).toEqual({ width: 270, height: FALLBACK_MAX_SIDE });
    expect(downscaledSize(320, 240)).toEqual({ width: 320, height: 240 });
    expect(downscaledSize(0, 0)).toEqual({ width: 0, height: 0 });
  });

  it('kare kucultulmus tuvale cizilir ve cozucuya o boyutta verilir; kare hazir degilse cozum yok', () => {
    const drawImage = vi.fn();
    const getImageData = vi.fn((_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }));
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage, getImageData }) } as unknown as HTMLCanvasElement;
    const decode = vi.fn(() => 'kod');
    const frame = createFrameDecoder(decode, canvas);
    const video = { videoWidth: 1280, videoHeight: 720 } as unknown as HTMLVideoElement;
    expect(frame(video)).toBe('kod');
    expect(drawImage).toHaveBeenCalledWith(video, 0, 0, 480, 270);
    expect(decode).toHaveBeenCalledWith(expect.any(Uint8ClampedArray), 480, 270);
    expect(frame({ videoWidth: 0, videoHeight: 0 } as unknown as HTMLVideoElement)).toBeUndefined();
    expect(decode).toHaveBeenCalledTimes(1);
  });
});

describe('yedek cozucu (jsqr)', () => {
  it('uygulamanin urettigi QR goruntusunu (gecis baglantisi) cozer; bos goruntude sonuc yok', async () => {
    const decode = await loadJsQr();
    const url = 'https://site.example/gecis/AbCdEfGhIjKlMnOpQrStUvWx';
    const img = qrImage(url);
    expect(decode(img.data, img.width, img.height)).toBe(url);
    const blank = new Uint8ClampedArray(img.width * img.height * 4).fill(255);
    expect(decode(blank, img.width, img.height)).toBeUndefined();
  });
});
