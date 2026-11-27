/*
 * Yedek QR cozucu (BarcodeDetector olmayan tarayicilar, ornek iPhone Safari): `jsqr` 1.4.0
 * (Apache-2.0, bagimliliksiz, saf JS). Kamera karesi uzun kenari en fazla `FALLBACK_MAX_SIDE` px olan
 * bir tuvale kucultulerek cizilir (telefon kamerasi 1080p+ kare verir; tam boy cozum yavas ve isitir),
 * cozum en fazla `FALLBACK_SCAN_INTERVAL_MS`'de bir yapilir. Kutuphane yalnizca bu modul dinamik
 * olarak yuklendiginde (tarama ekrani, yedek motor) ayri parca olarak indirilir.
 */
import { type BarcodeDetectorLike, type ScanEngine, createDetector } from './camera';

export const FALLBACK_MAX_SIDE = 480;
/** Yedek motorda kare cozum araligi (ms). Yerlesik motor da ayni aralikla sorgulanir. */
export const SCAN_INTERVAL_MS = 250;

/** RGBA piksel dizisinden QR metni (bulunamazsa `undefined`). */
export type QrDecode = (data: Uint8ClampedArray, width: number, height: number) => string | undefined;

/** Kare kucultme: oran korunur, uzun kenar en fazla `max` px; kucuk kare buyutulmez. */
export function downscaledSize(width: number, height: number, max = FALLBACK_MAX_SIDE): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** `jsqr`'i ilk cagrida yukler (ayri parca). Ters renk denemesi yapilmaz: uygulama QR'i koyu-acik basar. */
export async function loadJsQr(): Promise<QrDecode> {
  const { default: jsQR } = await import('jsqr');
  return (data, width, height) => jsQR(data, width, height, { inversionAttempts: 'dontInvert' })?.data || undefined;
}

type FrameSource = { videoWidth: number; videoHeight: number } & CanvasImageSource;

/** Kareyi kucultulmus tuvale cizip cozer (tuval tekrar kullanilir). */
export function createFrameDecoder(decode: QrDecode, canvas: HTMLCanvasElement = document.createElement('canvas')) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return (source: FrameSource): string | undefined => {
    const { width, height } = downscaledSize(source.videoWidth, source.videoHeight);
    if (!ctx || !width || !height) return undefined;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    ctx.drawImage(source, 0, 0, width, height);
    return decode(ctx.getImageData(0, 0, width, height).data, width, height);
  };
}

/** Motoru ne olursa olsun tek arayuz: karedeki QR metni (yoksa `undefined`). */
export type FrameScanner = (video: HTMLVideoElement) => Promise<string | undefined>;

export async function createFrameScanner(engine: ScanEngine, deps: { detector?: () => BarcodeDetectorLike; loadDecoder?: () => Promise<QrDecode> } = {}): Promise<FrameScanner> {
  if (engine === 'native') {
    const detector = (deps.detector ?? createDetector)();
    return async (video) => (await detector.detect(video)).find((c) => c.rawValue)?.rawValue;
  }
  const frame = createFrameDecoder(await (deps.loadDecoder ?? loadJsQr)());
  return async (video) => frame(video);
}
