/*
 * Kamera ile QR okuma: tarayicinin yerlesik `BarcodeDetector` API'si (Chrome / Edge / Samsung
 * Internet, Android). Ek kutuphane yok; desteklenmeyen tarayicida (ornek iOS Safari, Firefox)
 * gorevli kisa kodu elle girer. Kamera yalnizca guvenli baglantida (https / localhost) acilir.
 */

export type DetectedBarcode = { rawValue: string };
export type BarcodeDetectorLike = { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

export type ScannerSupport = 'ok' | 'insecure' | 'no_camera' | 'no_detector';

type Env = { isSecureContext?: boolean; navigator?: { mediaDevices?: { getUserMedia?: unknown } }; BarcodeDetector?: unknown };

export function scannerSupport(env: Env = globalThis as unknown as Env): ScannerSupport {
  if (env.isSecureContext === false) return 'insecure';
  if (typeof env.navigator?.mediaDevices?.getUserMedia !== 'function') return 'no_camera';
  if (typeof env.BarcodeDetector !== 'function') return 'no_detector';
  return 'ok';
}

export function createDetector(): BarcodeDetectorLike {
  const Ctor = (globalThis as unknown as { BarcodeDetector: BarcodeDetectorCtor }).BarcodeDetector;
  return new Ctor({ formats: ['qr_code'] });
}

export const SUPPORT_TEXT: Record<Exclude<ScannerSupport, 'ok'>, string> = {
  insecure: 'Kamera yalnızca güvenli (https) bağlantıda açılır. Kısa kodu aşağıya yazın.',
  no_camera: 'Bu cihazda kamera erişimi yok. Kısa kodu aşağıya yazın.',
  no_detector: 'Bu tarayıcı QR okumayı desteklemiyor (örneğin iPhone Safari). Kısa kodu aşağıya yazın veya Chrome ile açın.',
};

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
