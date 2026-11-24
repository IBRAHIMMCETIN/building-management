/**
 * Finans 2.3 - Sayac modulu ortak yardimcilari: roller, girdi dogrulama, endeks metni ayristirma,
 * fotograf anahtarlari ve parmak izi.
 */
import { createHash } from 'node:crypto';
import type { Role } from '../../auth/claims.js';
import type { IsoDate } from '../core/types.js';
import { type Obj, ValidationError, isIsoDate } from '../core/validation.js';
import { canonical } from './engine/hash.js';
import { MAX_SCALE, type Rational } from './engine/types.js';

/** Sayac sicili, degisim, sablon ve donem yonetimi. */
export const MANAGE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];
export const READ_ROLES: readonly Role[] = [...MANAGE_ROLES, 'observer'];
/** Okuma girisi ve toplu endeks aktarimi (bina gorevlisi dahil). */
export const READING_WRITE_ROLES: readonly Role[] = [...MANAGE_ROLES, 'building_staff'];
export const READING_READ_ROLES: readonly Role[] = [...READ_ROLES, 'building_staff'];

export const isManager = (role: Role) => MANAGE_ROLES.includes(role);

export type MeterContext = { apartmentId: string; userId: string; role: Role };

/** Endeks ust siniri (olcekli tam sayi). */
export const MAX_INDEX = Number.MAX_SAFE_INTEGER;
export const MAX_FACTOR_TERM = 1_000_000;

export function reqDate(o: Obj, key: string): IsoDate {
  const v = o[key];
  if (typeof v !== 'string' || !isIsoDate(v)) throw new ValidationError(`${key} YYYY-AA-GG biçiminde tarih olmalı`, key);
  return v;
}

export function optDate(o: Obj, key: string): IsoDate | undefined {
  return o[key] === undefined ? undefined : reqDate(o, key);
}

export function reqIndex(o: Obj, key: string): number {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new ValidationError(`${key} negatif olmayan tam sayı (ölçekli endeks) olmalı`, key);
  }
  return v;
}

export function optIndex(o: Obj, key: string): number | undefined {
  return o[key] === undefined || o[key] === null ? undefined : reqIndex(o, key);
}

export function parseScale(v: unknown, key = 'scale'): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > MAX_SCALE) {
    throw new ValidationError(`${key} 0-${MAX_SCALE} arası tam sayı olmalı`, key);
  }
  return v;
}

export function parseFactor(v: unknown, key = 'factor'): Rational {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new ValidationError(`${key} { num, den } olmalı`, key);
  const { num, den } = v as Obj;
  const ok = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 1 && x <= MAX_FACTOR_TERM;
  if (!ok(num) || !ok(den)) throw new ValidationError(`${key} pay ve paydası 1-${MAX_FACTOR_TERM} arası tam sayı olmalı`, key);
  return { num, den };
}

/** Europe/Istanbul takvim gunu. */
export function istanbulDate(now: Date): IsoDate {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Istegin ozeti (idempotency anahtarinin farkli istekle kullanilmasini yakalar). */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 32);
}

/**
 * Excel/CSV hucresindeki endeks metnini sayacin olcegine gore olcekli tam sayiya cevirir.
 * Kabul: "1234", "1234,5", "1.234,567", "1234.5" (olcek > 0 iken nokta ondalik), "1.234" (olcek 0
 * iken binlik ayirici). Olcekten fazla ondalik hane reddedilir (yuvarlama yapilmaz).
 */
export function parseIndexText(text: string | undefined, scale: number): { ok: true; value: number } | { ok: false; message: string } {
  const raw = (text ?? '').trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, message: 'Endeks boş' };
  if (!/^[0-9.,]+$/.test(raw)) return { ok: false, message: 'Endeks yalnızca rakam, nokta ve virgül içerebilir' };
  let intPart: string;
  let frac = '';
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  if (hasDot && hasComma) {
    // Turkce bicim: nokta binlik, virgul ondalik.
    if (raw.lastIndexOf('.') > raw.indexOf(',') || raw.split(',').length > 2) return { ok: false, message: 'Endeks biçimi geçersiz' };
    const [i, f] = raw.split(',');
    if (!/^\d{1,3}(\.\d{3})+$/.test(i ?? '')) return { ok: false, message: 'Binlik ayırıcı biçimi geçersiz' };
    intPart = (i ?? '').replaceAll('.', '');
    frac = f ?? '';
  } else if (hasComma) {
    const parts = raw.split(',');
    if (parts.length > 2) return { ok: false, message: 'Endeks biçimi geçersiz' };
    intPart = parts[0] ?? '';
    frac = parts[1] ?? '';
  } else if (hasDot) {
    const parts = raw.split('.');
    if (scale > 0 && parts.length === 2) {
      intPart = parts[0] ?? '';
      frac = parts[1] ?? '';
    } else if (/^\d{1,3}(\.\d{3})+$/.test(raw)) {
      intPart = raw.replaceAll('.', '');
    } else {
      return { ok: false, message: 'Endeks biçimi geçersiz' };
    }
  } else {
    intPart = raw;
  }
  if (!/^\d+$/.test(intPart)) return { ok: false, message: 'Endeks biçimi geçersiz' };
  if (frac && !/^\d+$/.test(frac)) return { ok: false, message: 'Endeks biçimi geçersiz' };
  if (frac.length > scale) return { ok: false, message: `Bu sayaç en fazla ${scale} ondalık hane kabul eder` };
  const digits = `${intPart}${frac.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'Endeks çok büyük' };
  return { ok: true, value };
}

/** Olcekli endeksin gosterimi (123456, 3 -> "123,456"). */
export function formatIndex(value: number, scale: number): string {
  if (scale === 0) return String(value);
  const s = String(value).padStart(scale + 1, '0');
  return `${s.slice(0, -scale)},${s.slice(-scale)}`;
}

// ---------------------------------------------------------------------------
// Fotograf kaniti (S3, private; yalnizca kisa omurlu imzali URL)
// ---------------------------------------------------------------------------

export const PHOTO_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
} as const;
export type PhotoContentType = keyof typeof PHOTO_CONTENT_TYPES;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
export const isPhotoContentType = (v: unknown): v is PhotoContentType => typeof v === 'string' && Object.hasOwn(PHOTO_CONTENT_TYPES, v);

/** Proje S3 duzeni: apartments/{apartmentId}/meters/{yyyy}/{mm}/{unitId}/ */
export function meterPhotoPrefix(apartmentId: string, date: IsoDate, unitId: string): string {
  return `apartments/${apartmentId}/meters/${date.slice(0, 4)}/${date.slice(5, 7)}/${unitId}/`;
}

export function meterPhotoKey(apartmentId: string, date: IsoDate, unitId: string, name: string, contentType: PhotoContentType): string {
  return `${meterPhotoPrefix(apartmentId, date, unitId)}${name}.${PHOTO_CONTENT_TYPES[contentType]}`;
}

export function photoContentTypeOf(key: string): string {
  const ext = key.slice(key.lastIndexOf('.') + 1);
  const hit = Object.entries(PHOTO_CONTENT_TYPES).find(([, e]) => e === ext);
  return hit ? hit[0] : 'application/octet-stream';
}
