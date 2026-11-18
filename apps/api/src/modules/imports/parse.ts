import type { IsoDate, LiableParty, UnitType } from '../core/types.js';
import { isIsoDate } from '../core/validation.js';

/*
 * Toplu aktarim satir ayristirici (saf). Web, Excel/CSV hucrelerini METIN olarak gonderir
 * (sayi/tarih hucreleri dahil); tum yorumlama ve dogrulama burada, tek yerde yapilir.
 * Turkce yazimlar kabul edilir: "Malik", "Kiracı", "Evet/Hayır", "85,5", "1.500,50", "12/480",
 * "2026-11-05" / "05.11.2026". Excel'in bozdugu tarihler (seri numara, 1012026) kurtarilir.
 */

export type Cell = string | undefined;
export type RowError = { field: string; message: string };
export type Parsed<T> = { ok: true; value: T } | { ok: false; errors: RowError[] };

export const MAX_ROWS = 1000;
export const MAX_CHUNK = 25;

export type UnitRowInput = { row: number; block: Cell; number: Cell; floor?: Cell; type?: Cell; area: Cell; landShare?: Cell };
export type PersonRowInput = {
  row: number;
  block: Cell;
  number: Cell;
  fullName: Cell;
  email: Cell;
  relation: Cell;
  residesInUnit?: Cell;
  startDate?: Cell;
  share?: Cell;
};
export type BalanceRowInput = { row: number; block: Cell; number: Cell; party: Cell; amount: Cell; dueDate?: Cell; description?: Cell };

export type UnitRow = {
  row: number;
  key: string;
  block: string;
  number: string;
  floor?: number;
  type: UnitType;
  grossAreaM2: number;
  landShare?: { numerator: number; denominator: number };
};
export type PersonRow = {
  row: number;
  key: string;
  unitKey: string;
  block: string;
  number: string;
  fullName: string;
  email: string;
  relation: 'owner' | 'tenant';
  residesInUnit: boolean;
  startDate: IsoDate;
  ownershipShare?: { numerator: number; denominator: number };
};
export type BalanceRow = {
  row: number;
  key: string;
  unitKey: string;
  block: string;
  number: string;
  party: LiableParty;
  amount: number;
  dueDate: IsoDate;
  description: string;
};

// ---------------------------------------------------------------------------
// Hucre yorumlayicilar
// ---------------------------------------------------------------------------

const text = (v: Cell) => (v ?? '').replace(/\s+/g, ' ').trim();
const fold = (v: string) => v.toLocaleLowerCase('tr-TR').normalize('NFC');

/** Blok + daire no ile dosya ici ve veritabani eslestirme anahtari (buyuk/kucuk harf duyarsiz). */
export const unitKeyOf = (block: string, number: string) => `${fold(block)}|${fold(number)}`;

const UNIT_TYPE_WORDS: Record<string, UnitType> = {
  daire: 'flat', konut: 'flat', flat: 'flat',
  dubleks: 'duplex', duplex: 'duplex',
  dükkan: 'shop', dükkân: 'shop', dukkan: 'shop', işyeri: 'shop', shop: 'shop',
  ofis: 'office', büro: 'office', office: 'office',
  otopark: 'parking', parking: 'parking',
  depo: 'storage', storage: 'storage',
  diğer: 'other', other: 'other',
};

export function parseUnitType(v: Cell): UnitType | null {
  const t = fold(text(v));
  if (!t) return 'flat';
  return UNIT_TYPE_WORDS[t] ?? null;
}

/** "85,5" | "85.5" | "85" -> 85.5 (en fazla 1 ondalik). */
export function parseArea(v: Cell): number | null {
  const t = text(v).replace(/\s|m²|m2/gi, '').replace(',', '.');
  if (!/^\d{1,5}(\.\d)?$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/**
 * Web istemcisi, Excel'in kesir sutununa TARIH olarak kaydettigi hucreyi (1/1 -> "1.Oca")
 * bu isaretle gonderir (apps/web/src/lib/import/sheetModel.ts ile ayni deger).
 */
export const DATE_IN_FRACTION = '#TARIH#';

const MONTH_WORD = /^\d{1,2}[.\-\s/]?\p{L}{3,}\.?$|^\p{L}{3,}[.\-\s/]?\d{1,2}$/u;

export type FractionResult =
  | { ok: true; value: { numerator: number; denominator: number } | undefined }
  | { ok: false; message: string };

/**
 * "12/480" | "'1/2" -> { pay, payda }; bos -> undefined. Excel'in tarihe/ondaliga cevirdigi
 * degerler (1.Oca, 2026-01-01, 0,5) acik bir mesajla reddedilir.
 */
export function parseFractionCell(v: Cell, label: string): FractionResult {
  const t = text(v).replace(/^'/, '').replace(/\s/g, '');
  if (!t) return { ok: true, value: undefined };
  const asDate =
    t === DATE_IN_FRACTION || MONTH_WORD.test(t) || /^\d{4}-\d{2}-\d{2}/.test(t) || /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(t);
  if (asDate) return { ok: false, message: `${label} bir tarih olamaz. Lütfen '1/1 biçiminde (başında tek tırnakla) giriniz` };
  if (/^\d+([.,]\d+)?$/.test(t)) {
    return { ok: false, message: `${label} ondalık sayı değil oran olarak yazılmalı (örn. '1/2; başına tek tırnak koyun)` };
  }
  const m = /^(\d{1,9})\/(\d{1,9})$/.exec(t);
  if (!m) return { ok: false, message: `${label} "pay/payda" biçiminde olmalı (örn. '1/2)` };
  const numerator = Number(m[1]);
  const denominator = Number(m[2]);
  if (numerator < 1 || denominator < 1 || numerator > denominator) {
    return { ok: false, message: `${label} geçersiz: pay 1 ile payda arasında olmalı (örn. '1/2)` };
  }
  return { ok: true, value: { numerator, denominator } };
}

/** Kisa yol: gecersiz -> null. */
export function parseFraction(v: Cell): { numerator: number; denominator: number } | null | undefined {
  const r = parseFractionCell(v, 'Oran');
  return r.ok ? r.value : null;
}

const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Excel seri tarihi (1900 sistemi; 46023 = 2026-01-01) -> ISO tarih. Kesirli kisim (saat)
 * atilir. Makul aralik disi (1954 oncesi / 2119 sonrasi) -> null.
 */
export function parseExcelDate(serial: number): IsoDate | null {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const d = new Date(EXCEL_EPOCH_MS + Math.floor(serial) * 86_400_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

function isoOf(y: number, m: number, d: number): IsoDate | null {
  const iso = `${y}-${pad2(m)}-${pad2(d)}`;
  return y >= 1950 && y <= 2150 && isIsoDate(iso) ? iso : null;
}

/**
 * Excel'in binlik ayraci sanip sayiya cevirdigi tarih: "01.01.2026" -> 1012026 / "1.012.026".
 * 8 hane: ggaayyyy (olmazsa yyyyaagg).
 * 7 hane: sayi olunca yalnizca gunun bastaki sifiri duser ("01.01.2026" -> 1012026), bu yuzden
 * once g|aa|yyyy denenir; gecersizse gg|a|yyyy ("31.3.2026" -> 3132026).
 */
export function recoverDigitDate(digits: string): IsoDate | null {
  if (!/^\d{7,8}$/.test(digits)) return null;
  const year = Number(digits.slice(-4));
  if (digits.length === 8) {
    return (
      isoOf(year, Number(digits.slice(2, 4)), Number(digits.slice(0, 2))) ??
      isoOf(Number(digits.slice(0, 4)), Number(digits.slice(4, 6)), Number(digits.slice(6, 8)))
    );
  }
  return isoOf(year, Number(digits.slice(1, 3)), Number(digits.slice(0, 1))) ?? isoOf(year, Number(digits.slice(2, 3)), Number(digits.slice(0, 2)));
}

export const INVALID_DATE_HINT = 'Lütfen YYYY-AA-GG biçiminde giriniz (örn. 2026-01-01)';

/**
 * Kabul edilen: "2026-11-05", "05.11.2026", "5/11/2026", Excel seri tarihi (46023) ve Excel'in
 * sayiya cevirdigi tarih (1012026, "1.012.026"). Bos -> undefined, gecersiz -> null.
 */
export function parseDate(v: Cell): IsoDate | null | undefined {
  const t = text(v);
  if (!t) return undefined;
  const tr = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(t);
  if (tr) return isoOf(Number(tr[3]), Number(tr[2]), Number(tr[1]));
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/.exec(t);
  if (iso) return isoOf(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (/^\d{5}(\.\d+)?$/.test(t)) return parseExcelDate(Number(t));
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return recoverDigitDate(t.replaceAll('.', ''));
  if (/^\d{7,8}$/.test(t)) return recoverDigitDate(t);
  return null;
}

/**
 * Isaretli tutar -> kurus. "1.500,50" | "-250" | "1500.5" | "₺1.500" ; kayan nokta kullanilmaz.
 * Virgul varsa ondaliktir (nokta binlik); yoksa 1-2 haneli son nokta ondaliktir.
 */
export function parseSignedKurus(v: Cell): number | null {
  let t = text(v).replace(/\s|₺|TL/gi, '');
  let sign = 1;
  if (/^[-−]/.test(t)) {
    sign = -1;
    t = t.slice(1);
  } else if (/^\(.*\)$/.test(t)) {
    sign = -1;
    t = t.slice(1, -1);
  }
  if (!t || !/^[\d.,]+$/.test(t)) return null;
  let integer: string;
  let fraction = '';
  if (t.includes(',')) {
    const parts = t.split(',');
    if (parts.length !== 2) return null;
    [integer, fraction] = [parts[0] ?? '', parts[1] ?? ''];
    if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(integer)) return null;
    integer = integer.replaceAll('.', '');
  } else {
    const m = /^(\d+)\.(\d{1,2})$/.exec(t);
    if (m) [integer, fraction] = [m[1] ?? '', m[2] ?? ''];
    else {
      if (!/^\d{1,3}(\.\d{3})*$|^\d+$/.test(t)) return null;
      integer = t.replaceAll('.', '');
    }
  }
  if (fraction.length > 2 || integer === '') return null;
  const kurus = Number(integer) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(kurus) || kurus > 99_999_999_999) return null;
  return sign * kurus;
}

export function parseRelation(v: Cell): 'owner' | 'tenant' | null {
  const t = fold(text(v));
  if (['malik', 'kat maliki', 'ev sahibi', 'owner'].includes(t)) return 'owner';
  if (['kiracı', 'kiraci', 'tenant'].includes(t)) return 'tenant';
  return null;
}

export function parseParty(v: Cell): LiableParty | null {
  const t = fold(text(v));
  if (['malik', 'kat maliki', 'ev sahibi', 'owner'].includes(t)) return 'owner';
  if (['oturan', 'kiracı', 'kiraci', 'sakin', 'occupant'].includes(t)) return 'occupant';
  return null;
}

export function parseBool(v: Cell): boolean | null | undefined {
  const t = fold(text(v));
  if (!t) return undefined;
  if (['e', 'evet', 'var', 'x', '1', 'true'].includes(t)) return true;
  if (['h', 'hayır', 'hayir', 'yok', '0', 'false'].includes(t)) return false;
  return null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ---------------------------------------------------------------------------
// Satir ayristiricilar
// ---------------------------------------------------------------------------

function unitRef(r: { block: Cell; number: Cell }, errors: RowError[]) {
  const block = text(r.block);
  const number = text(r.number);
  if (!block) errors.push({ field: 'block', message: 'Blok boş olamaz' });
  else if (block.length > 60) errors.push({ field: 'block', message: 'Blok adı en fazla 60 karakter' });
  if (!number) errors.push({ field: 'number', message: 'Daire no boş olamaz' });
  else if (number.length > 20) errors.push({ field: 'number', message: 'Daire no en fazla 20 karakter' });
  return { block, number, unitKey: unitKeyOf(block, number) };
}

export function parseUnitRow(r: UnitRowInput): Parsed<UnitRow> {
  const errors: RowError[] = [];
  const { block, number, unitKey } = unitRef(r, errors);
  const type = parseUnitType(r.type);
  if (!type) errors.push({ field: 'type', message: 'Tip tanınmadı (Daire, Dubleks, Dükkan, Ofis, Otopark, Depo, Diğer)' });
  const area = parseArea(r.area);
  if (area === null) errors.push({ field: 'area', message: 'Brüt m² geçersiz (örn. 85 veya 85,5)' });
  let floor: number | undefined;
  const floorText = text(r.floor);
  if (floorText) {
    if (!/^-?\d{1,3}$/.test(floorText) || Number(floorText) < -5 || Number(floorText) > 200) {
      errors.push({ field: 'floor', message: 'Kat -5 ile 200 arasında tam sayı olmalı' });
    } else floor = Number(floorText);
  }
  const landShareCell = parseFractionCell(r.landShare, 'Arsa payı');
  if (!landShareCell.ok) errors.push({ field: 'landShare', message: landShareCell.message });
  const landShare = landShareCell.ok ? landShareCell.value : undefined;
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: { row: r.row, key: `unit:${unitKey}`, block, number, floor, type: type as UnitType, grossAreaM2: area as number, landShare },
  };
}

export function parsePersonRow(r: PersonRowInput, asOf: IsoDate): Parsed<PersonRow> {
  const errors: RowError[] = [];
  const { block, number, unitKey } = unitRef(r, errors);
  const fullName = text(r.fullName);
  if (fullName.length < 2 || fullName.length > 100) errors.push({ field: 'fullName', message: 'Ad soyad 2-100 karakter olmalı' });
  const email = text(r.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) errors.push({ field: 'email', message: 'E-posta geçersiz' });
  const relation = parseRelation(r.relation);
  if (!relation) errors.push({ field: 'relation', message: 'İlişki "Malik" veya "Kiracı" olmalı' });
  const resides = parseBool(r.residesInUnit);
  if (resides === null) errors.push({ field: 'residesInUnit', message: 'Dairede oturuyor "E" veya "H" olmalı' });
  const startDate = parseDate(r.startDate);
  if (startDate === null) errors.push({ field: 'startDate', message: `Geçersiz başlangıç tarihi: ${INVALID_DATE_HINT}` });
  const shareCell = parseFractionCell(r.share, 'Hisse');
  if (!shareCell.ok) errors.push({ field: 'share', message: shareCell.message });
  const share = shareCell.ok ? shareCell.value : undefined;
  if (share && relation === 'tenant') errors.push({ field: 'share', message: 'Kiracı için hisse girilmez' });
  if (relation === 'tenant' && resides === false) errors.push({ field: 'residesInUnit', message: 'Kiracı dairede oturuyor sayılır' });
  if (errors.length) return { ok: false, errors };
  const rel = relation as 'owner' | 'tenant';
  return {
    ok: true,
    value: {
      row: r.row,
      key: `person:${email}|${unitKey}`,
      unitKey,
      block,
      number,
      fullName,
      email,
      relation: rel,
      residesInUnit: resides ?? rel === 'tenant',
      startDate: startDate ?? asOf,
      ownershipShare: share,
    },
  };
}

export function parseBalanceRow(r: BalanceRowInput, asOf: IsoDate): Parsed<BalanceRow> {
  const errors: RowError[] = [];
  const { block, number, unitKey } = unitRef(r, errors);
  const party = parseParty(r.party);
  if (!party) errors.push({ field: 'party', message: 'Cari "Malik" veya "Oturan" olmalı' });
  const amount = parseSignedKurus(r.amount);
  if (amount === null || amount === 0) errors.push({ field: 'amount', message: 'Tutar geçersiz veya sıfır (borç pozitif, avans negatif; örn. 1.500,50 veya -250)' });
  const dueDate = parseDate(r.dueDate);
  if (dueDate === null) errors.push({ field: 'dueDate', message: `Geçersiz vade tarihi: ${INVALID_DATE_HINT}` });
  const description = text(r.description) || 'Devir bakiyesi';
  if (description.length > 200) errors.push({ field: 'description', message: 'Açıklama en fazla 200 karakter' });
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      row: r.row,
      key: `balance:${unitKey}|${party}`,
      unitKey,
      block,
      number,
      party: party as LiableParty,
      amount: amount as number,
      // Karar 2a: vade yoksa devir tarihi; kistelyevm ertesi gunden isler.
      dueDate: dueDate ?? asOf,
      description,
    },
  };
}
