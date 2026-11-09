/** Hafif, bagimliliksiz girdi dogrulama yardimcilari (JSON govdeleri `unknown` gelir). */

export class ValidationError extends Error {
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

export type Obj = Record<string, unknown>;

export function asObject(value: unknown, field = 'govde'): Obj {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} bir nesne olmalidir`, field);
  }
  return value as Obj;
}

function readString(value: unknown, key: string, max: number, min: number): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${key} metin olmalidir`, key);
  }
  const text = value.trim();
  if (text.length < min || text.length > max) {
    throw new ValidationError(`${key} ${min}-${max} karakter olmalidir`, key);
  }
  return text;
}

export function reqString(o: Obj, key: string, max: number, min = 1): string {
  return readString(o[key], key, max, min);
}

export function optString(o: Obj, key: string, max: number): string | undefined {
  return o[key] === undefined ? undefined : readString(o[key], key, max, 1);
}

function readInt(value: unknown, key: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${key} ${min}-${max} araliginda tam sayi olmalidir`, key);
  }
  return value;
}

export function reqInt(o: Obj, key: string, min: number, max: number): number {
  return readInt(o[key], key, min, max);
}

export function optInt(o: Obj, key: string, min: number, max: number): number | undefined {
  return o[key] === undefined ? undefined : readInt(o[key], key, min, max);
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${key} true/false olmalidir`, key);
  }
  return value;
}

function readEnum<T extends string>(value: unknown, key: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !(values as readonly string[]).includes(value)) {
    throw new ValidationError(`${key} su degerlerden biri olmalidir: ${values.join(', ')}`, key);
  }
  return value as T;
}

export function reqEnum<T extends string>(o: Obj, key: string, values: readonly T[]): T {
  return readEnum(o[key], key, values);
}

export function optEnum<T extends string>(o: Obj, key: string, values: readonly T[]): T | undefined {
  return o[key] === undefined ? undefined : readEnum(o[key], key, values);
}

export function optStringArray(
  o: Obj,
  key: string,
  maxItems: number,
  maxLength: number,
): string[] | undefined {
  const value = o[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new ValidationError(`${key} en fazla ${maxItems} ogeli bir dizi olmalidir`, key);
  }
  return value.map((item, i) => readString(item, `${key}[${i}]`, maxLength, 1));
}

/** URL ve kayit kimlikleri; DynamoDB anahtar ayiraci '#' icermez. */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new ValidationError(`${field} gecersiz`, field);
  }
  return value;
}

/** Gercek bir takvim tarihi mi (YYYY-MM-DD)? */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
