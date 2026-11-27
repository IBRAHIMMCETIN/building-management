/*
 * Kamera ile QR okuma. Iki motor:
 *  - `native`: tarayicinin yerlesik `BarcodeDetector` API'si (Chrome / Edge / Samsung Internet,
 *    Android). Ek kod yuklenmez.
 *  - `fallback`: `BarcodeDetector` yoksa veya QR bicimini desteklemiyorsa (iPhone / iPad Safari,
 *    Firefox) kamera kareleri kucultulmus bir tuvale cizilip `jsqr` (Apache-2.0, bagimliliksiz) ile
 *    cozulur. Kutuphane yalnizca tarama ekraninda, ilk kullanimda ayri parca olarak yuklenir
 *    (`qrDecode.ts`).
 * Kamera yalnizca guvenli baglantida (https / localhost) acilir; okunamayan durumda gorevli kisa
 * kodu elle girer.
 */

export type DetectedBarcode = { rawValue: string };
export type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = (new (opts?: { formats?: string[] }) => BarcodeDetectorLike) & { getSupportedFormats?: () => Promise<string[]> };

export type ScannerSupport = 'ok' | 'insecure' | 'no_camera';
export type ScanEngine = 'native' | 'fallback';

type Env = { isSecureContext?: boolean; navigator?: { mediaDevices?: { getUserMedia?: unknown } }; BarcodeDetector?: unknown };

/** Kamera acilabilir mi? QR cozumu her durumda vardir (yerlesik veya yedek motor). */
export function scannerSupport(env: Env = globalThis as unknown as Env): ScannerSupport {
  if (env.isSecureContext === false) return 'insecure';
  if (typeof env.navigator?.mediaDevices?.getUserMedia !== 'function') return 'no_camera';
  return 'ok';
}

/**
 * Motor secimi: yerlesik `BarcodeDetector` varsa ve (bildiriyorsa) `qr_code` bicimini destekliyorsa
 * `native`, aksi halde `fallback`. Destek listesi sorgusu hata verirse yedek motor guvenli taraftir.
 */
export async function scanEngine(env: Env = globalThis as unknown as Env): Promise<ScanEngine> {
  const Ctor = env.BarcodeDetector as BarcodeDetectorCtor | undefined;
  if (typeof Ctor !== 'function') return 'fallback';
  if (typeof Ctor.getSupportedFormats !== 'function') return 'native';
  try {
    const formats = await Ctor.getSupportedFormats();
    return Array.isArray(formats) && formats.includes('qr_code') ? 'native' : 'fallback';
  } catch {
    return 'fallback';
  }
}

export function createDetector(): BarcodeDetectorLike {
  const Ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  return new Ctor({ formats: ['qr_code'] });
}

export const SUPPORT_TEXT: Record<Exclude<ScannerSupport, 'ok'>, string> = {
  insecure: 'Kamera yalnızca güvenli (https) bağlantıda açılır. Kısa kodu aşağıya yazın.',
  no_camera: 'Bu cihazda kamera erişimi yok. Kısa kodu aşağıya yazın.',
};

/** Yedek QR okuyucu (ayri parca) yuklenemedi: ag kesintisi veya eski surum onbellegi. */
export const DECODER_LOAD_ERROR = 'QR okuyucu yüklenemedi. Bağlantınızı kontrol edip kamerayı yeniden açın veya kısa kodu aşağıya yazın.';

/** getUserMedia hatasi -> gorevliye ne yapacagini soyleyen metin. */
export function cameraErrorMessage(err: unknown): string {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name: unknown }).name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return 'Kamera izni verilmedi. Adres çubuğundaki kamera simgesinden izin verin veya kısa kodu aşağıya yazın.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Kamera bulunamadı. Kısa kodu aşağıya yazın.';
  if (name === 'NotReadableError') return 'Kamera başka bir uygulama tarafından kullanılıyor. Uygulamayı kapatıp tekrar deneyin veya kısa kodu yazın.';
  return 'Kamera açılamadı. Kısa kodu aşağıya yazın.';
}
