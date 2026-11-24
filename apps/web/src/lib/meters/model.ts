/*
 * Finans 2.3 sayac / endeks dagitimi - istemci tarafi saf yardimcilar (React'siz, test edilebilir).
 * Endeksler API'de OLCEKLI TAM SAYIDIR: gercek deger x 10^scale (ornek scale 3: 1.234,567 -> 1234567).
 * Ayristirma kurallari API'deki `parseIndexText` ile birebir aynidir (apps/api/src/modules/meters/common.ts).
 */

export const METER_KINDS = ['heat_allocator', 'heat_meter', 'hot_water', 'cold_water'] as const;
export type MeterKind = (typeof METER_KINDS)[number];
export const METER_KIND_LABELS: Record<MeterKind, string> = {
  heat_allocator: 'Isı pay ölçer',
  heat_meter: 'Kalorimetre',
  hot_water: 'Sıcak su sayacı',
  cold_water: 'Soğuk su sayacı',
};

export const METER_STATUSES = ['active', 'replaced', 'retired', 'cancelled'] as const;
export type MeterStatus = (typeof METER_STATUSES)[number];
export const METER_STATUS_LABELS: Record<MeterStatus, string> = {
  active: 'Aktif',
  replaced: 'Değiştirildi',
  retired: 'Söküldü',
  cancelled: 'İptal',
};

export const TEMPLATE_CATEGORIES = ['heating', 'hot_water', 'cold_water'] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];
export const CATEGORY_LABELS: Record<TemplateCategory, string> = {
  heating: 'Isınma',
  hot_water: 'Sıcak su',
  cold_water: 'Soğuk su',
};

export const COMMON_KEYS = ['area', 'equal', 'land_share'] as const;
export type CommonKey = (typeof COMMON_KEYS)[number];
export const COMMON_KEY_LABELS: Record<CommonKey, string> = {
  area: 'Kullanım alanı (m²)',
  equal: 'Eşit',
  land_share: 'Arsa payı',
};

export const LEGAL_PROFILES = ['central_heating', 'district_heating', 'none'] as const;
export type LegalProfile = (typeof LEGAL_PROFILES)[number];
export const LEGAL_PROFILE_LABELS: Record<LegalProfile, string> = {
  central_heating: 'Merkezi ısıtma (yönetmelik)',
  district_heating: 'Bölgesel ısıtma',
  none: 'Yönetmelik dışı (su vb.)',
};

export const LIABLE_PARTIES = ['occupant', 'owner'] as const;
export type LiableParty = (typeof LIABLE_PARTIES)[number];
export const LIABLE_PARTY_LABELS: Record<LiableParty, string> = {
  occupant: 'Oturan (kiracı, yoksa malik)',
  owner: 'Kat maliki',
};

export const PERIOD_STATUSES = ['draft', 'calculated', 'posting', 'posted', 'reversing', 'reversed', 'cancelled'] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];
type Tone = 'neutral' | 'success' | 'warning' | 'accent' | 'danger';
export const PERIOD_STATUS_META: Record<PeriodStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Taslak', tone: 'neutral' },
  calculated: { label: 'Hesaplandı', tone: 'accent' },
  posting: { label: 'Tahakkuk sürüyor', tone: 'warning' },
  posted: { label: 'Onaylandı', tone: 'success' },
  reversing: { label: 'Geri alınıyor', tone: 'warning' },
  reversed: { label: 'Geri alındı', tone: 'danger' },
  cancelled: { label: 'İptal', tone: 'neutral' },
};
export const isOpenPeriod = (s: PeriodStatus) => s === 'draft' || s === 'calculated';

export const READING_STATUS_META: Record<'ok' | 'missing' | 'error' | 'auto', { label: string; tone: Tone }> = {
  ok: { label: 'Girildi', tone: 'success' },
  auto: { label: 'Otomatik', tone: 'accent' },
  missing: { label: 'Eksik', tone: 'warning' },
  error: { label: 'Hatalı', tone: 'danger' },
};
export const READING_FLAG_LABELS: Record<string, string> = {
  spike: 'Olağan dışı artış',
  rollover: 'Sayaç başa döndü',
  estimated: 'Tahmini',
};

/** Merkezi isitmada yonetmelik esasi: %30 ortak (kullanim alani) + %70 tuketim. */
export const CENTRAL_HEATING_COMMON_BPS = 3000;
export const BPS_TOTAL = 10_000;

/** API `legalWarnings` ile ayni kural: sapma varsa karar no + gerekce zorunlu. */
export function isLegalDeviation(t: { legalProfile: LegalProfile; commonShareBps: number; commonKey: CommonKey }): boolean {
  return t.legalProfile === 'central_heating' && (t.commonShareBps !== CENTRAL_HEATING_COMMON_BPS || t.commonKey !== 'area');
}

/** "30" / "30,5" / "30.5" -> 3000 / 3050 baz puan; gecersiz veya 0-100 disi -> null. */
export function percentToBps(input: string): number | null {
  const raw = input.trim().replace(',', '.');
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(raw)) return null;
  const bps = Math.round(Number(raw) * 100);
  return bps >= 0 && bps <= BPS_TOTAL ? bps : null;
}

/** 3050 -> "30,5" (Turkce ondalik). */
export function bpsToPercent(bps: number): string {
  const v = bps / 100;
  return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
}

export function splitLabel(commonShareBps: number, commonKey: CommonKey): string {
  const common = bpsToPercent(commonShareBps);
  const usage = bpsToPercent(BPS_TOTAL - commonShareBps);
  if (commonShareBps === 0) return '%100 tüketim';
  return `%${common} ortak (${COMMON_KEY_LABELS[commonKey]}) + %${usage} tüketim`;
}

export type IndexParse = { ok: true; value: number } | { ok: false; message: string };

/**
 * Endeks metnini olcekli tam sayiya cevirir. Kabul: "1234", "1234,5", "1.234,567", "1234.5"
 * (olcek > 0 iken nokta ondalik), "1.234" (olcek 0 iken binlik). Fazla ondalik hane reddedilir.
 */
export function parseIndexText(text: string | undefined, scale: number): IndexParse {
  const raw = (text ?? '').trim().replace(/\s+/g, '');
  if (!raw) return { ok: false, message: 'Endeks boş' };
  if (!/^[0-9.,]+$/.test(raw)) return { ok: false, message: 'Endeks yalnızca rakam, nokta ve virgül içerebilir' };
  let intPart: string;
  let frac = '';
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  if (hasDot && hasComma) {
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
  if (frac.length > scale) {
    return { ok: false, message: scale === 0 ? 'Bu sayaç ondalık kabul etmez' : `Bu sayaç en fazla ${scale} ondalık hane kabul eder` };
  }
  const digits = `${intPart}${frac.padEnd(scale, '0')}`.replace(/^0+(?=\d)/, '');
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) return { ok: false, message: 'Endeks çok büyük' };
  return { ok: true, value };
}

/** Olcekli endeks gosterimi, binlik ayiriciyla: (1234567, 3) -> "1.234,567". */
export function formatIndex(value: number, scale: number): string {
  const s = String(Math.abs(value)).padStart(scale + 1, '0');
  const int = scale === 0 ? s : s.slice(0, -scale);
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const sign = value < 0 ? '-' : '';
  return scale === 0 ? `${sign}${grouped}` : `${sign}${grouped},${s.slice(-scale)}`;
}

/** Ondalik metin tuketimi ("12.5" / "12,5") Turkce gosterime cevirir. */
export function formatConsumption(value: string | number, maxFraction = 3): string {
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) return String(value);
  return new Intl.NumberFormat('tr-TR', { maximumFractionDigits: maxFraction }).format(n);
}

// ---------------------------------------------------------------------------
// Fotograf kaniti
// ---------------------------------------------------------------------------
export const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'] as const;
export const PHOTO_ACCEPT = PHOTO_TYPES.join(',');
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export function photoFileError(file: Pick<File, 'type' | 'size'>): string | null {
  if (!(PHOTO_TYPES as readonly string[]).includes(file.type)) return 'Fotoğraf JPEG, PNG, WEBP veya HEIC olmalı.';
  if (file.size <= 0) return 'Dosya boş.';
  if (file.size > MAX_PHOTO_BYTES) return 'Fotoğraf en fazla 10 MB olabilir.';
  return null;
}

// ---------------------------------------------------------------------------
// Excel / CSV toplu endeks aktarimi
// ---------------------------------------------------------------------------
export type ImportRow = { row: number; meter: string; index: string; note?: string };
export type ImportParse = { rows: ImportRow[]; errors: string[] };
export const MAX_IMPORT_ROWS = 2000;

const norm = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/\u0307/g, '');

const METER_HEADERS = ['sayac', 'sayaç', 'seri', 'seri no', 'sayac no', 'sayaç no', 'meter', 'serial', 'meterid', 'sayac id'];
const INDEX_HEADERS = ['endeks', 'son endeks', 'index', 'okuma', 'deger', 'değer'];
const NOTE_HEADERS = ['not', 'aciklama', 'açıklama', 'note'];

function findCol(header: string[], names: string[]): number {
  const wanted = names.map(norm);
  return header.findIndex((h) => wanted.includes(h) || wanted.some((w) => h.startsWith(w)));
}

/** Hucre degeri metne: sayilar Turkce ondalikla (Excel 1234.5 -> "1234,5"), bos -> "". */
export function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v).replace('.', ',') : '';
  if (v instanceof Date) return '';
  return String(v).trim();
}

/**
 * Tablo satirlari -> API aktarim satirlari. Ilk satir baslik ise sutunlar addan bulunur
 * ("Sayaç / Seri No", "Endeks", "Not"); degilse sira: sayac, endeks, not. Satir numarasi
 * dosyadaki gercek satirdir (hata mesajlari kullaniciya bu numarayla doner).
 */
export function parseImportTable(table: unknown[][]): ImportParse {
  const errors: string[] = [];
  const rows: ImportRow[] = [];
  const nonEmpty = table.findIndex((r) => r.some((c) => cellText(c) !== ''));
  if (nonEmpty < 0) return { rows, errors: ['Dosyada satır yok.'] };
  const header = (table[nonEmpty] ?? []).map(norm);
  let meterCol = findCol(header, METER_HEADERS);
  let indexCol = findCol(header, INDEX_HEADERS);
  let noteCol = findCol(header, NOTE_HEADERS);
  let start = nonEmpty + 1;
  if (meterCol < 0 || indexCol < 0) {
    // Basliksiz dosya: ilk satir veridir.
    meterCol = 0;
    indexCol = 1;
    noteCol = 2;
    start = nonEmpty;
  }
  for (let i = start; i < table.length; i++) {
    const r = table[i] ?? [];
    const meter = cellText(r[meterCol]);
    const index = cellText(r[indexCol]);
    const note = noteCol >= 0 ? cellText(r[noteCol]) : '';
    if (!meter && !index && !note) continue;
    if (!meter) {
      errors.push(`Satır ${i + 1}: sayaç (seri no) boş`);
      continue;
    }
    rows.push({ row: i + 1, meter, index, ...(note ? { note: note.slice(0, 200) } : {}) });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return { rows: [], errors: [`Bir dosyada en fazla ${MAX_IMPORT_ROWS} satır aktarılabilir.`] };
  }
  if (rows.length === 0 && errors.length === 0) errors.push('Aktarılacak satır bulunamadı.');
  return { rows, errors };
}

/** Yuzde degisim metni: 12.3 -> "+%12,3", -5 -> "-%5". */
export function formatPercentChange(p: number): string {
  const s = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 1 }).format(Math.abs(p));
  return `${p > 0 ? '+' : p < 0 ? '-' : ''}%${s}`;
}

/** Okuma girisi icin yerel takvim gunu (Europe/Istanbul). */
export function todayIstanbul(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
