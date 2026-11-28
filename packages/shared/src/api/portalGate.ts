import { z } from 'zod';
import { formatDate } from '../dates';

/*
 * Sakin portali guvenlik kapisi - /api/portal/gate (yalnizca `resident`; apps/api/src/modules/gate/routes.ts):
 * oturdugu bolumlerin araclari, misafir gecisleri (QR + kisa kod), kapidaki kuryeye onay ve kapi
 * kayitlari. Web karsiligi: apps/web/src/lib/api/gate.ts (sakin semalari) ve lib/gate/plate.ts,
 * pass.ts (saf yardimcilar); sozlesme ve metinler aynidir. QR jetonu kayitta tutulmaz: yalnizca
 * olusturma ve "Yeni QR oluştur" yanitinda gelir.
 */

export const PASS_VERDICTS = ['valid', 'not_yet_valid', 'expired', 'used', 'revoked', 'host_left'] as const;
export type PassVerdict = (typeof PASS_VERDICTS)[number];

export const gateUnitSchema = z.object({ unitId: z.string(), label: z.string() });
export type GateUnit = z.infer<typeof gateUnitSchema>;

export const portalGateOverviewSchema = z.object({
  units: z.array(gateUnitSchema),
  limits: z.object({ maxVehiclesPerUnit: z.number(), maxPassDays: z.number(), maxPassLeadDays: z.number(), courierResponseMinutes: z.number() }),
});
export type PortalGateOverview = z.infer<typeof portalGateOverviewSchema>;

export const vehicleSchema = z.object({
  vehicleId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  plate: z.string(),
  plateDisplay: z.string(),
  note: z.string().optional(),
  status: z.enum(['active', 'inactive']),
  /** Sahibi bolumden tasindi: gorevliye pasif gorunur. */
  ownerLeft: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  createdByRole: z.string(),
  version: z.number(),
});
export type Vehicle = z.infer<typeof vehicleSchema>;
export const vehicleListSchema = z.object({ items: z.array(vehicleSchema), maxPerUnit: z.number() });
export const vehicleOneSchema = z.object({ vehicle: vehicleSchema });

export const myPassSchema = z.object({
  passId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  guestName: z.string(),
  validFrom: z.string(),
  validUntil: z.string(),
  entryMode: z.enum(['single', 'multi']),
  plate: z.string().optional(),
  plateDisplay: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['active', 'used', 'revoked']),
  verdict: z.enum(PASS_VERDICTS),
  token: z.string().optional(),
  shortCode: z.string().optional(),
  entryCount: z.number(),
  inside: z.boolean(),
  lastEntryAt: z.string().optional(),
  lastExitAt: z.string().optional(),
  revokedAt: z.string().optional(),
  createdAt: z.string(),
  mine: z.boolean(),
  canRevoke: z.boolean(),
  /** "Yeni QR olustur" (eski QR / kod gecersiz olur). */
  canRotate: z.boolean(),
  version: z.number(),
});
export type MyPass = z.infer<typeof myPassSchema>;
export const myPassListSchema = z.object({ items: z.array(myPassSchema) });
export const myPassOneSchema = z.object({ pass: myPassSchema });
export const createdPassSchema = z.object({ pass: myPassSchema, replayed: z.boolean() });

export const courierSchema = z.object({
  courierId: z.string(),
  unitId: z.string(),
  unitLabel: z.string(),
  company: z.string().optional(),
  note: z.string().optional(),
  status: z.enum(['waiting', 'approved', 'declined', 'cancelled']),
  expired: z.boolean(),
  respondBy: z.string(),
  respondedAt: z.string().optional(),
  responseNote: z.string().optional(),
  enteredAt: z.string().optional(),
  exitedAt: z.string().optional(),
  enterBy: z.string().optional(),
  approvalExpired: z.boolean().optional(),
  createdAt: z.string(),
  canRespond: z.boolean(),
  canEnter: z.boolean(),
  canExit: z.boolean(),
  canCancel: z.boolean(),
  version: z.number(),
});
export type Courier = z.infer<typeof courierSchema>;
export const courierListSchema = z.object({ items: z.array(courierSchema), pollSeconds: z.number() });

export const gateLogSchema = z.object({
  logId: z.string(),
  at: z.string(),
  direction: z.enum(['entry', 'exit']),
  kind: z.enum(['guest', 'courier', 'manual']),
  unitId: z.string().optional(),
  unitLabel: z.string().optional(),
  passId: z.string().optional(),
  courierId: z.string().optional(),
  visitorName: z.string().optional(),
  company: z.string().optional(),
  plate: z.string().optional(),
  plateDisplay: z.string().optional(),
  note: z.string().optional(),
  recordedBy: z.string().optional(),
  recordedByName: z.string().optional(),
});
export type GateLogEntry = z.infer<typeof gateLogSchema>;
export const gateLogPageSchema = z.object({ items: z.array(gateLogSchema), from: z.string(), to: z.string(), nextCursor: z.string().optional() });
export type GateLogPage = z.infer<typeof gateLogPageSchema>;
export const courierOneSchema = z.object({ courier: courierSchema, replayed: z.boolean().optional(), log: gateLogSchema.optional() });

export type CreatePassInput = {
  idempotencyKey: string;
  unitId: string;
  guestName: string;
  validFrom: string;
  validUntil?: string;
  entryMode: 'single' | 'multi';
  plate?: string;
  note?: string;
};
export type CreateVehicleInput = { unitId: string; plate: string; note?: string };
export type UpdateVehicleInput = { version: number; status?: 'active' | 'inactive'; note?: string | null };

// --- Plaka (API ile ayni kurallar: apps/api/src/modules/gate/model.ts) ------

/** Bosluk / tire / nokta atilir, buyuk harf; Turkce `i` / `ı` / `İ` plakadaki Latin `I`. */
export function normalizePlate(input: string): string {
  return input
    .replace(/[ıİi]/g, 'I')
    .toUpperCase()
    .replace(/[\s.\-_/]/g, '');
}

const PLATE_RE = /^(0[1-9]|[1-7][0-9]|8[01])([ABCDEFGHIJKLMNOPRSTUVYZ]{1,3})([0-9]{2,5})$/;
const DIGITS_BY_LETTERS: Record<number, [number, number]> = { 1: [4, 5], 2: [3, 4], 3: [2, 3] };

/** Il kodu 01-81; 1 harf 4-5, 2 harf 3-4, 3 harf 2-3 rakam; Q, W, X ve Turkce harf yok. */
export function isTurkishPlate(plate: string): boolean {
  const m = PLATE_RE.exec(plate);
  if (!m) return false;
  const [min, max] = DIGITS_BY_LETTERS[(m[2] ?? '').length] ?? [0, -1];
  const digits = (m[3] ?? '').length;
  return digits >= min && digits <= max;
}

/** `34ABC123` -> `34 ABC 123`; Turk plakasi degilse oldugu gibi. */
export function formatPlate(plate: string): string {
  const m = PLATE_RE.exec(plate);
  return m ? `${m[1]} ${m[2]} ${m[3]}` : plate;
}

/** Form dogrulamasi: hata metni veya `undefined`. */
export function plateError(input: string): string | undefined {
  const plate = normalizePlate(input);
  if (!plate) return 'Plaka girin';
  return isTurkishPlate(plate) ? undefined : 'Plaka Türkiye plaka biçiminde olmalıdır (örnek: 34 ABC 123)';
}

// --- Gecis paylasimi -----------------------------------------------------

/** `K7M2PQ4X` -> `K7M2-PQ4X` (okumasi ve yazmasi kolay). */
export const formatShortCode = (code: string) => (code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code);

/**
 * Misafire gonderilen baglanti: `<web>/gecis/<jeton>#<kod>`. Web sayfasi sunucuya bir sey sormaz; QR'i
 * tarayicida cizer. Kod parca (#) icinde: sunucu loglarina gitmez.
 */
export const passLink = (origin: string, token: string, shortCode?: string) => `${origin.replace(/\/$/, '')}/gecis/${encodeURIComponent(token)}${shortCode ? `#${shortCode}` : ''}`;

/** Paylasim metni (web PassShareDialog ile ayni). */
export const passShareText = (code: string, validFrom: string, validUntil: string) =>
  `Site girişi için geçiş kodunuz: ${code} (${validityText(validFrom, validUntil)}). Güvenliğe QR'ı veya kodu gösterin.`;

// --- Etiketler -----------------------------------------------------------

export type GateTone = 'success' | 'warning' | 'danger' | 'neutral' | 'accent';

export const VERDICT_TEXT: Record<PassVerdict, { label: string; tone: GateTone }> = {
  valid: { label: 'Geçerli', tone: 'success' },
  not_yet_valid: { label: 'Henüz başlamadı', tone: 'warning' },
  expired: { label: 'Süresi doldu', tone: 'danger' },
  used: { label: 'Kullanıldı', tone: 'neutral' },
  revoked: { label: 'İptal edildi', tone: 'danger' },
  host_left: { label: 'Ev sahibi taşındı', tone: 'danger' },
};

export const LOG_KIND_TEXT: Record<string, string> = { guest: 'Misafir', courier: 'Kurye', manual: 'Elle kayıt' };
export const DIRECTION_TEXT: Record<string, string> = { entry: 'Giriş', exit: 'Çıkış' };
export const ENTRY_MODE_TEXT = { single: 'Tek giriş', multi: 'Çoklu giriş' } as const;

/** "27 Kas 2026" veya "27 Kas 2026 – 29 Kas 2026". */
export const validityText = (from: string, until: string) => (from === until ? formatDate(from) : `${formatDate(from)} – ${formatDate(until)}`);

/** Saat:dakika (Istanbul). */
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Istanbul' });

// --- Misafir gecisi formu (API kurallarinin istemci kopyasi; asil dogrulama API'de) ---

const DAY_MS = 86_400_000;
const daySpan = (from: string, until: string) => Math.round((Date.parse(`${until}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

export type PassFormInput = {
  guestName: string;
  validFrom: string;
  /** Bos: yalnizca gelis gunu. */
  validUntil: string;
  /** Istanbul bugunu (YYYY-MM-DD). */
  today: string;
  maxPassDays: number;
  maxPassLeadDays: number;
};

export type PassFormIssue = { field: 'guestName' | 'validFrom' | 'validUntil'; message: string };

/** Ilk hata ve ait oldugu alan (mobil hatayi alanin altinda gosterir); gecerliyse `undefined`. */
export function passFormIssue(f: PassFormInput): PassFormIssue | undefined {
  if (f.guestName.trim().length < 2) return { field: 'guestName', message: 'Misafirin adını yazın (en az 2 karakter).' };
  if (!f.validFrom) return { field: 'validFrom', message: 'Geliş tarihini seçin.' };
  if (f.validFrom < f.today) return { field: 'validFrom', message: 'Geçiş bugünden önce başlayamaz.' };
  if (daySpan(f.today, f.validFrom) - 1 > f.maxPassLeadDays) return { field: 'validFrom', message: `Geçiş en fazla ${f.maxPassLeadDays} gün sonrası için oluşturulabilir.` };
  if (f.validUntil && f.validUntil < f.validFrom) return { field: 'validUntil', message: 'Son gün geliş tarihinden önce olamaz.' };
  if (f.validUntil && daySpan(f.validFrom, f.validUntil) > f.maxPassDays) return { field: 'validUntil', message: `Bir geçiş en fazla ${f.maxPassDays} gün geçerli olabilir.` };
  return undefined;
}

/** Ilk hata metni; gecerliyse `undefined` (web lib/gate/pass.ts ile ayni). */
export const passFormError = (f: PassFormInput): string | undefined => passFormIssue(f)?.message;
