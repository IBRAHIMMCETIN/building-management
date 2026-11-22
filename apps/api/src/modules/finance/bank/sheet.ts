import { inflateRawSync } from 'node:zlib';
import { BankError } from './errors.js';
import type { SourceFormat } from './types.js';

/*
 * Banka ekstresi dosya okuyucu (saf, bagimliliksiz). Cikti: ilk sayfanin hucreleri METIN olarak
 * (satir x sutun). Yorumlama (tarih, tutar, yon) parse.ts'tedir.
 *
 * Desteklenen bicimler (icerikten tespit edilir, uzanti/icerik turune guvenilmez):
 *   - CSV / TXT: ayirici ; , TAB | otomatik; RFC 4180 tirnaklari; UTF-8 (BOM'lu/BOM'suz) veya
 *     Windows-1254 (Turkce Windows) kodlamasi.
 *   - XLSX (Office Open XML): ZIP + XML; yalnizca ilk calisma sayfasi. ZIP64 ve sifreli dosya yok.
 *   - "XLS" adiyla indirilen HTML tablosu (bir cok internet subesinin Excel ciktisi).
 * Desteklenmeyen: eski ikili Excel 97-2003 (BIFF, OLE2) ve PDF -> acik hata mesaji.
 */

/**
 * `numeric`: XLSX'te sayi olarak saklanan hucreler (`<satir>:<sutun>`, 0 tabanli). Bu hucreler
 * makine bicimindedir ("1500.5", "46023.58"): tutar okurken nokta ondalik ayiricidir, binlik degil.
 */
export type Sheet = { format: SourceFormat; rows: string[][]; numeric?: Set<string> };

/** ZIP acilirken toplam acilmis boyut siniri (sikistirma bombasi korumasi). */
const MAX_INFLATED_BYTES = 60 * 1024 * 1024;
const MAX_ROWS = 20_000;
const MAX_COLS = 60;

export function readSheet(bytes: Uint8Array): Sheet {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length === 0) throw new BankError('unprocessable', 'Dosya bos');

  if (buf.length >= 8 && buf.readUInt32BE(0) === 0xd0cf11e0 && buf.readUInt32BE(4) === 0xa1b11ae1) {
    throw new BankError(
      'unsupported_format',
      "Eski Excel 97-2003 (.xls) bicimi desteklenmiyor. Dosyayi Excel'de acip 'Excel Calisma Kitabi (.xlsx)' veya CSV olarak kaydedip yukleyin",
    );
  }
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    throw new BankError('unsupported_format', 'PDF ekstre okunamaz. Internet subesinden Excel (.xlsx) veya CSV olarak indirin');
  }
  if (buf.readUInt32LE(0) === 0x04034b50) {
    const numeric = new Set<string>();
    return { format: 'xlsx', rows: clampRows(readXlsx(buf, numeric)), numeric };
  }

  const text = decodeText(buf);
  if (/^\s*</.test(text) && /<table[\s>]/i.test(text)) return { format: 'html', rows: clampRows(readHtmlTable(text)) };
  return { format: 'csv', rows: clampRows(readCsv(text)) };
}

function clampRows(rows: string[][]): string[][] {
  if (rows.length > MAX_ROWS) throw new BankError('too_large', `Dosya en fazla ${MAX_ROWS} satir icerebilir`);
  return rows.map((r) => r.slice(0, MAX_COLS).map((c) => c.replace(/\s+/g, ' ').trim()));
}

// ---------------------------------------------------------------------------
// Metin kodlamasi
// ---------------------------------------------------------------------------

/** UTF-8 (gecerliyse) yoksa Windows-1254. BOM atilir. */
export function decodeText(buf: Buffer): string {
  let b = buf;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return new TextDecoder('windows-1254').decode(b);
  }
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

const DELIMITERS = [';', ',', '\t', '|'] as const;

/** Ilk dolu satirlarda (tirnak disinda) en tutarli ayirici. */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best: string = ';';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const max = Math.max(0, ...counts);
    if (max === 0) continue;
    // En sik gorulen (sifirdan buyuk) sayinin tekrar sayisi * sutun sayisi
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    const [mode, times] = [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? [0, 0];
    const score = times * 100 + mode;
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (const ch of line) {
    if (ch === '"') q = !q;
    else if (!q && ch === d) n++;
  }
  return n;
}

export function readCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell.trim() === '') {
      cell = '';
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// XML/HTML yardimcilari
// ---------------------------------------------------------------------------

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return NAMED_ENTITIES[e.toLowerCase()] ?? m;
  });
}

const attr = (attrs: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1];

// ---------------------------------------------------------------------------
// HTML tablosu (".xls" olarak indirilen)
// ---------------------------------------------------------------------------

export function readHtmlTable(html: string): string[][] {
  const rows: string[][] = [];
  const body = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
  for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)(?=<tr\b|<\/table>|$)/gi)) {
    const cells: string[] = [];
    for (const td of (tr[1] ?? '').matchAll(/<t([dh])\b([^>]*)>([\s\S]*?)(?=<t[dh]\b|<\/tr>|$)/gi)) {
      const inner = (td[3] ?? '').replace(/<\/t[dh]>[\s\S]*$/i, '');
      const value = decodeEntities(inner.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ''));
      cells.push(value);
      const span = Number(attr(td[2] ?? '', 'colspan') ?? '1');
      for (let k = 1; k < Math.min(span, MAX_COLS); k++) cells.push('');
    }
    rows.push(cells);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// XLSX: ZIP merkezi dizini + XML
// ---------------------------------------------------------------------------

type ZipEntry = { name: string; method: number; compressedSize: number; localOffset: number };

function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: son 64 KB + 22 bayt icinde geriye dogru aranir.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new BankError('unsupported_format', 'Excel dosyasi bozuk veya desteklenmeyen ZIP bicimi');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new BankError('unsupported_format', 'Excel dosyasi bozuk (ZIP merkezi dizini okunamadi)');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    if (flags & 0x1) throw new BankError('unsupported_format', 'Sifreli Excel dosyasi okunamaz; sifreyi kaldirip tekrar kaydedin');
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new BankError('unsupported_format', 'Cok buyuk (ZIP64) Excel dosyasi desteklenmiyor');
    }
    entries.set(name, { name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function zipRead(buf: Buffer, entries: Map<string, ZipEntry>, name: string, budget: { left: number }): string | undefined {
  const e = entries.get(name);
  if (!e) return undefined;
  const lp = e.localOffset;
  if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) {
    throw new BankError('unsupported_format', 'Excel dosyasi bozuk (yerel baslik)');
  }
  const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  let out: Buffer;
  if (e.method === 0) out = data;
  else if (e.method === 8) {
    try {
      out = inflateRawSync(data, { maxOutputLength: budget.left });
    } catch (err) {
      throw new BankError('too_large', 'Excel dosyasi acilamadi veya acilmis boyutu cok buyuk', undefined, { cause: err });
    }
  } else throw new BankError('unsupported_format', `Desteklenmeyen ZIP sikistirma yontemi (${e.method})`);
  budget.left -= out.length;
  if (budget.left < 0) throw new BankError('too_large', 'Excel dosyasinin acilmis boyutu cok buyuk');
  return out.toString('utf8');
}

/** "AB12" -> 27 (0 tabanli sutun). */
export function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx(buf: Buffer, numeric: Set<string>): string[][] {
  const entries = zipEntries(buf);
  const budget = { left: MAX_INFLATED_BYTES };
  const sheetPath = firstSheetPath(buf, entries, budget);
  const sheetXml = zipRead(buf, entries, sheetPath, budget);
  if (!sheetXml) throw new BankError('unsupported_format', 'Excel dosyasinda calisma sayfasi bulunamadi');

  const shared: string[] = [];
  const sst = zipRead(buf, entries, 'xl/sharedStrings.xml', budget);
  if (sst) {
    for (const si of sst.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      // Fonetik (rPh) metinler atilir; zengin metin parcalari (r/t) birlestirilir.
      const body = (si[1] ?? '').replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      shared.push(decodeEntities([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? '').join('')));
    }
  }

  const rows: string[][] = [];
  for (const rm of sheetXml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const rowNo = Number(attr(rm[1] ?? '', 'r') ?? rows.length + 1);
    if (!Number.isSafeInteger(rowNo) || rowNo < 1 || rowNo > MAX_ROWS) {
      throw new BankError('too_large', `Dosya en fazla ${MAX_ROWS} satir icerebilir`);
    }
    const cells: string[] = [];
    let nextCol = 0;
    for (const cm of (rm[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = cm[1] ?? '';
      const ref = attr(a, 'r');
      const col = ref ? columnIndex(ref) : nextCol;
      nextCol = col + 1;
      if (col < 0 || col >= MAX_COLS) continue;
      const type = attr(a, 't');
      const inner = cm[2] ?? '';
      let value = '';
      if (type === 'inlineStr') {
        value = decodeEntities([...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? '').join(''));
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
        if (v !== undefined) {
          if (type === 's') value = shared[Number(v)] ?? '';
          else if (type === 'b') value = v === '1' ? 'TRUE' : 'FALSE';
          else {
            value = decodeEntities(v);
            if ((type === undefined || type === 'n') && value.trim()) numeric.add(`${rowNo - 1}:${col}`);
          }
        }
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    while (rows.length < rowNo - 1) rows.push([]);
    rows[rowNo - 1] = cells;
  }
  return rows;
}

function firstSheetPath(buf: Buffer, entries: Map<string, ZipEntry>, budget: { left: number }): string {
  const fallback = 'xl/worksheets/sheet1.xml';
  const wb = zipRead(buf, entries, 'xl/workbook.xml', budget);
  const rels = zipRead(buf, entries, 'xl/_rels/workbook.xml.rels', budget);
  if (!wb || !rels) {
    if (entries.has(fallback)) return fallback;
    throw new BankError('unsupported_format', 'Excel calisma kitabi okunamadi');
  }
  const sheet = /<sheet\b([^>]*)\/?>/.exec(wb)?.[1] ?? '';
  const rid = /\br:id="([^"]+)"/.exec(sheet)?.[1] ?? /\bid="([^"]+)"/.exec(sheet)?.[1];
  for (const rel of rels.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    if (attr(rel[1] ?? '', 'Id') !== rid) continue;
    const target = attr(rel[1] ?? '', 'Target') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    if (entries.has(path)) return path;
  }
  if (entries.has(fallback)) return fallback;
  throw new BankError('unsupported_format', 'Excel dosyasinda calisma sayfasi bulunamadi');
}
