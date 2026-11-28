/*
 * Guvenlik kapisi - saf yardimcilar. Plaka kurallari API ile aynidir
 * (apps/api/src/modules/gate/model.ts); yetkinin ve dogrulamanin asli API'dedir.
 *
 * Web + mobil ortak (tek kaynak): plaka, kisa kod gosterimi, gecis baglantisi, karar / gunluk
 * etiketleri packages/shared/src/api/portalGate.ts; okutma (QR / kisa kod ayristirma) ve kurye durumu
 * packages/shared/src/gate/plate.ts. Bu dosya eski import yollari icin yeniden disa aktarir.
 */
import type { GateTone } from '@bm/shared/api/portalGate';

export {
  DIRECTION_TEXT,
  LOG_KIND_TEXT,
  type PassVerdict,
  VERDICT_TEXT,
  formatPlate,
  formatShortCode,
  isTurkishPlate,
  normalizePlate,
  passLink,
  plateError,
  validityText,
} from '@bm/shared/api/portalGate';
export { COURIER_TEXT, type CourierState, SHORT_CODE_ALPHABET, type ScanResult, courierState, normalizeShortCode, parseScan } from '@bm/shared/gate/plate';

export type Tone = GateTone;
