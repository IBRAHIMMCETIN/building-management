/*
 * Toplu aktarim dosya modeli (saf; tarayici/kutuphane bagimliligi yok, test edilebilir).
 *
 * Excel (.xlsx) veya CSV satirlari burada API'nin bekledigi metin hucrelerine cevrilir
 * (apps/api/src/modules/imports/parse.ts). Asil dogrulama sunucudadir: istemci yalnizca
 * basliklari eslestirir, bos satirlari atar ve satir numaralarini korur.
 */

export type SheetKind = 'units' | 'people' | 'balances';
export const SHEET_KINDS: readonly SheetKind[] = ['units', 'people', 'balances'];

export type ImportCell = string | undefined;
/** `row`: dosyadaki satir numarasi; diger alanlar API anahtarlariyla (block, number, email…) metin hucreler. */
export type ImportRow = { row: number; [key: string]: ImportCell | number };
export type ImportSheets = Record<SheetKind, ImportRow[]>;

/** Okunan ham hucre: read-excel-file (string | number | boolean | Date) veya CSV (string). */
export type RawCell = string | number | boolean | Date | null | undefined;

/**
 * Sablondaki hucre bicimi (Excel Web ve Masaustu, bolge ayarindan bagimsiz):
 *  - `numeric`: Sayi (Genel). Kat, m², tutar.
 *  - `date`: Tarih, bicim `yyyy-mm-dd`. ISO yazim her bolge ayarinda tarih olarak taninir.
 *  - digerleri (kesirler dahil): Metin (`@`), tip String. Excel 1/2'yi tarihe, "01"i 1'e cevirmesin.
 * `sample`: sablonun 2. satirindaki ornek (bicimi kullaniciya gosterir; aktarimda atlanir).
 */
type ColumnDef = {
  key: string;
  title: string;
  required?: boolean;
  aliases: string[];
  fraction?: boolean;
  numeric?: boolean;
  date?: boolean;
  width?: number;
  hint: string;
  sample?: string | number;
};
type SheetDef = { kind: SheetKind; title: string; names: string[]; columns: ColumnDef[] };

export const MAX_IMPORT_ROWS = 1000;
export const CHUNK_SIZE = 25;

export const SHEETS: Record<SheetKind, SheetDef> = {
  units: {
    kind: 'units',
    title: 'Daireler',
    names: ['daireler', 'daire', 'bagimsizbolumler', 'units'],
    columns: [
      { key: 'block', title: 'Blok', required: true, aliases: ['blok', 'blokadi', 'block'], width: 14, hint: 'Örn. A Blok. Yoksa otomatik açılır.', sample: 'Örnek' },
      { key: 'number', title: 'Daire No', required: true, aliases: ['daireno', 'daire', 'no', 'bbno', 'number'], width: 10, hint: 'Örn. 5, D1', sample: '1' },
      { key: 'floor', title: 'Kat', numeric: true, aliases: ['kat', 'floor'], width: 6, hint: 'Tam sayı; zemin 0, bodrum -1', sample: 2 },
      { key: 'type', title: 'Tip', aliases: ['tip', 'tur', 'type'], width: 10, hint: 'Daire, Dubleks, Dükkan, Ofis, Otopark, Depo, Diğer (boş: Daire)', sample: 'Daire' },
      { key: 'area', title: 'Brüt m²', required: true, numeric: true, aliases: ['brutm2', 'm2', 'alan', 'brutalan', 'metrekare', 'area'], width: 9, hint: 'Örn. 100 veya 100,5', sample: 120 },
      { key: 'landShare', title: 'Arsa Payı (Örn: 12/480)', aliases: ['arsapayi', 'arsa', 'landshare'], fraction: true, width: 22, hint: "Oran; tarihe dönmemesi için '12/480 yazın", sample: '12/480' },
    ],
  },
  people: {
    kind: 'people',
    title: 'Kişiler',
    names: ['kisiler', 'kisi', 'sakinler', 'maliklerkiracilar', 'people'],
    columns: [
      { key: 'block', title: 'Blok', required: true, aliases: ['blok', 'blokadi', 'block'], width: 14, hint: 'Daireler sayfasındaki ile aynı', sample: 'Örnek' },
      { key: 'number', title: 'Daire No', required: true, aliases: ['daireno', 'daire', 'no', 'bbno', 'number'], width: 10, hint: 'Daireler sayfasındaki ile aynı', sample: '1' },
      { key: 'fullName', title: 'Ad Soyad', required: true, aliases: ['adsoyad', 'adisoyadi', 'isim', 'adsoyadi', 'fullname'], width: 22, hint: '', sample: 'Mehmet Kaya' },
      { key: 'email', title: 'E-posta', required: true, aliases: ['eposta', 'email', 'mail', 'epostaadresi'], width: 26, hint: 'Giriş ve davet bu adrese', sample: 'mehmet@ornek.com' },
      { key: 'relation', title: 'İlişki', required: true, aliases: ['iliski', 'tur', 'relation'], width: 10, hint: 'Malik veya Kiracı', sample: 'Malik' },
      { key: 'residesInUnit', title: 'Dairede Oturuyor', aliases: ['dairedeoturuyor', 'oturuyor', 'oturan', 'residesinunit'], width: 16, hint: 'Evet/Hayır (kiracı için her zaman Evet)', sample: 'Evet' },
      { key: 'startDate', title: 'Başlangıç Tarihi (YYYY-AA-GG)', aliases: ['baslangictarihi', 'baslangic', 'giristarihi', 'startdate'], date: true, width: 28, hint: 'YYYY-AA-GG, örn. 2026-01-01 (boş: devir tarihi)', sample: '2026-01-01' },
      { key: 'share', title: 'Hisse (Örn: 1/1)', aliases: ['hisse', 'mulkiyetpayi', 'share'], fraction: true, width: 16, hint: "Hisseli mülkiyette oran; tarihe dönmemesi için '1/2 yazın", sample: '1/1' },
    ],
  },
  balances: {
    kind: 'balances',
    title: 'Bakiyeler',
    names: ['bakiyeler', 'bakiye', 'acilisbakiyeleri', 'devirbakiyeleri', 'balances'],
    columns: [
      { key: 'block', title: 'Blok', required: true, aliases: ['blok', 'blokadi', 'block'], width: 14, hint: 'Daireler sayfasındaki ile aynı', sample: 'Örnek' },
      { key: 'number', title: 'Daire No', required: true, aliases: ['daireno', 'daire', 'no', 'bbno', 'number'], width: 10, hint: 'Daireler sayfasındaki ile aynı', sample: '1' },
      { key: 'party', title: 'Cari', required: true, aliases: ['cari', 'taraf', 'borclu', 'party'], width: 10, hint: 'Oturan (aidat) veya Malik (demirbaş)', sample: 'Oturan' },
      { key: 'amount', title: 'Tutar', required: true, numeric: true, aliases: ['tutar', 'bakiye', 'borc', 'amount'], width: 12, hint: 'Borç pozitif, alacak (fazla ödeme) negatif. Örn. 1.250,00', sample: 1250 },
      { key: 'dueDate', title: 'Vade Tarihi (YYYY-AA-GG)', aliases: ['vadetarihi', 'vade', 'duedate'], date: true, width: 24, hint: 'YYYY-AA-GG, örn. 2026-01-10; gecikme tazminatı bu tarihten işler (boş: devir tarihi)', sample: '2026-01-10' },
      { key: 'description', title: 'Açıklama', aliases: ['aciklama', 'description'], width: 28, hint: 'Boş: Devir bakiyesi', sample: 'Eylül aidatı' },
    ],
  },
};

/** Baslik/sayfa adi karsilastirmasi: Turkce harfler sadelesir, bosluk ve isaretler atilir. */
export function normalizeHeader(value: string): string {
  return value
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/ş/g, 's')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/²/g, '2')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Excel tarihleri UTC gece yarisi olarak okunur; gun kaymamasi icin UTC bilesenleri kullanilir. */
function dateToIso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Sayi hucresi: kayan nokta gurultusu (1500.1000000002) kuruş hassasiyetinde temizlenir. */
function numberToText(n: number): string {
  if (!Number.isFinite(n)) return '';
  if (Number.isInteger(n)) return String(n);
  const cents = Math.round(n * 100);
  return Math.abs(n * 100 - cents) < 1e-6 ? String(cents / 100) : String(n);
}

/**
 * Excel "1/4" gibi kesirleri tarihe cevirebilir; boyle hucre sunucuya bu isaretle gider ve
 * sunucu "Hisse bir tarih olamaz" der (apps/api/src/modules/imports/parse.ts DATE_IN_FRACTION).
 */
export const FRACTION_AS_DATE = '#TARIH#';

/** Sablonun 2. satirindaki ornek satir bu blok adiyla isaretlidir ve aktarilmaz. */
export const SAMPLE_BLOCK = 'Örnek';
const isSampleBlock = (v: ImportCell | number) => typeof v === 'string' && normalizeHeader(v) === normalizeHeader(SAMPLE_BLOCK);

/** Baslik eslestirmesi: "Hisse (Örn: 1/1)*" -> "hisse". */
export const headerKey = (h: string) => normalizeHeader(h.replace(/\([^)]*\)/g, '').replace(/\*+/g, ''));

export function cellToText(value: RawCell, column?: Pick<ColumnDef, 'fraction'>): ImportCell {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return column?.fraction ? FRACTION_AS_DATE : Number.isNaN(value.getTime()) ? '' : dateToIso(value);
  if (typeof value === 'number') return numberToText(value);
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  const text = value.trim();
  return text === '' ? undefined : text;
}

const isEmptyRow = (row: readonly RawCell[]) => row.every((c) => cellToText(c) === undefined);

/** Sayfa adina gore tur; ad tanidik degilse basliklara bakilir. */
export function detectKind(sheetName: string | undefined, headers: readonly string[]): SheetKind | undefined {
  const name = sheetName ? normalizeHeader(sheetName) : '';
  const byName = SHEET_KINDS.find((k) => SHEETS[k].names.includes(name));
  if (byName) return byName;
  const set = new Set(headers.map(headerKey));
  const has = (kind: SheetKind, key: string) => SHEETS[kind].columns.find((c) => c.key === key)!.aliases.some((a) => set.has(a));
  if (has('people', 'email')) return 'people';
  if (has('balances', 'amount') && has('balances', 'party')) return 'balances';
  if (has('units', 'area')) return 'units';
  return undefined;
}

export type SheetParseResult =
  | { ok: true; kind: SheetKind; rows: ImportRow[]; ignoredColumns: string[] }
  | { ok: false; kind?: SheetKind; message: string };

/**
 * Ham sayfa -> API satirlari. Ilk dolu satir basliktir; satir numaralari dosyadakiyle aynidir
 * (hata raporundaki "Satır 7" Excel'deki 7. satirdir).
 */
export function parseSheet(sheetName: string | undefined, data: readonly (readonly RawCell[])[]): SheetParseResult {
  const headerIndex = data.findIndex((r) => !isEmptyRow(r));
  if (headerIndex < 0) return { ok: false, message: `${sheetName ?? 'Dosya'}: boş sayfa` };
  const headers = data[headerIndex]!.map((c) => cellToText(c) ?? '');
  const kind = detectKind(sheetName, headers);
  if (!kind) return { ok: false, message: `${sheetName ?? 'Dosya'}: sayfa türü anlaşılamadı (Daireler, Kişiler veya Bakiyeler başlıklarını kullanın)` };
  const def = SHEETS[kind];

  const columnOf = new Map<number, ColumnDef>();
  const ignoredColumns: string[] = [];
  headers.forEach((h, i) => {
    const norm = headerKey(h);
    if (!norm) return;
    const col = def.columns.find((c) => c.aliases.includes(norm) || headerKey(c.title) === norm);
    if (col && ![...columnOf.values()].includes(col)) columnOf.set(i, col);
    else ignoredColumns.push(h);
  });
  const missing = def.columns.filter((c) => c.required && ![...columnOf.values()].includes(c));
  if (missing.length) {
    return { ok: false, kind, message: `${def.title}: zorunlu sütun eksik: ${missing.map((c) => c.title).join(', ')}` };
  }

  const rows: ImportRow[] = [];
  for (let i = headerIndex + 1; i < data.length; i++) {
    const raw = data[i]!;
    if (isEmptyRow(raw)) continue;
    const row: ImportRow = { row: i + 1 };
    for (const [index, col] of columnOf) {
      const v = cellToText(raw[index], col);
      if (v !== undefined) row[col.key] = v;
    }
    if (isSampleBlock(row.block)) continue;
    rows.push(row);
  }
  return { ok: true, kind, rows, ignoredColumns };
}

export type WorkbookParseResult = { sheets: ImportSheets; errors: string[]; total: number };

/** Birden cok sayfa/dosya birlesir; ayni turden iki sayfa gelirse hata. */
export function parseWorkbook(input: readonly { name?: string; data: readonly (readonly RawCell[])[] }[]): WorkbookParseResult {
  const sheets: ImportSheets = { units: [], people: [], balances: [] };
  const seen = new Set<SheetKind>();
  const errors: string[] = [];
  for (const s of input) {
    const name = s.name ? normalizeHeader(s.name) : '';
    if (['aciklama', 'aciklamalar', 'ornek', 'ornekler', 'bilgi'].includes(name)) continue;
    const r = parseSheet(s.name, s.data);
    if (!r.ok) {
      // Tamamen bos yardimci sayfalar sorun degil.
      if (!r.message.endsWith('boş sayfa')) errors.push(r.message);
      continue;
    }
    if (seen.has(r.kind)) {
      errors.push(`${SHEETS[r.kind].title} birden fazla sayfada/dosyada var; tek sayfada toplayın`);
      continue;
    }
    seen.add(r.kind);
    sheets[r.kind] = r.rows;
  }
  const total = sheets.units.length + sheets.people.length + sheets.balances.length;
  if (total === 0 && errors.length === 0) errors.push('Dosyada aktarılacak satır bulunamadı');
  if (total > MAX_IMPORT_ROWS) errors.push(`Tek seferde en fazla ${MAX_IMPORT_ROWS} satır aktarılabilir (dosyada ${total} var); dosyayı bölün`);
  return { sheets, errors, total };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 + Excel TR: ayrac `;` veya `,` (ilk satira gore), tirnakli alanlar, BOM. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const count = (c: string) => firstLine.split(c).length - 1;
  const delimiter = [';', ',', '\t'].reduce((best, c) => (count(c) > count(best) ? c : best), ';');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Parcalama ve rapor
// ---------------------------------------------------------------------------

export type ImportChunk = { kind: SheetKind; rows: ImportRow[] };

/** Yazim sirasi onemli: once daireler, sonra kisiler, en son bakiyeler (en fazla 25 satir). */
export function toChunks(sheets: ImportSheets, size = CHUNK_SIZE): ImportChunk[] {
  const out: ImportChunk[] = [];
  for (const kind of SHEET_KINDS) {
    const rows = sheets[kind];
    for (let i = 0; i < rows.length; i += size) out.push({ kind, rows: rows.slice(i, i + size) });
  }
  return out;
}

/** Onizlemede hatali isaretlenen satirlar atlanir (yonetici "hatalilari atla" secerse). */
export function withoutRows(sheets: ImportSheets, skip: readonly { sheet: SheetKind; row: number }[]): ImportSheets {
  const set = new Set(skip.map((s) => `${s.sheet}:${s.row}`));
  const keep = (kind: SheetKind) => sheets[kind].filter((r) => !set.has(`${kind}:${r.row}`));
  return { units: keep('units'), people: keep('people'), balances: keep('balances') };
}

export type ReportLine = { sheet: SheetKind | 'funds' | 'general'; row?: number; label: string; message: string };

export const SHEET_LABEL: Record<ReportLine['sheet'], string> = {
  units: 'Daireler',
  people: 'Kişiler',
  balances: 'Bakiyeler',
  funds: 'Kasa/Banka',
  general: 'Genel',
};

/** Hata raporu tablosu (xlsx veya CSV olarak indirilir). */
export function reportTable(lines: readonly ReportLine[]): string[][] {
  return [
    ['Sayfa', 'Satır', 'Kayıt', 'Hata'],
    ...lines.map((l) => [SHEET_LABEL[l.sheet], l.row ? String(l.row) : '', l.label, l.message]),
  ];
}

export function toCsv(table: readonly (readonly string[])[]): string {
  const esc = (v: string) => (/[;"\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  return `﻿${table.map((r) => r.map(esc).join(';')).join('\r\n')}\r\n`;
}
