import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import { PDF_PRODUCER } from './brand.js';
import { type PdfFonts, loadPdfFonts } from './fonts.js';

/**
 * Finans 2.4-3 - Genel tablo raporu PDF'i (mizan, gelir-gider, butce-gerceklesen, kesin hesap,
 * borclu listesi, kasa/banka dokumu). A4 yatay, cok sayfali: sutun basliklari her sayfada
 * tekrarlanir, alt bilgide sayfa numarasi ve dogrulama ozeti. Saf: ayni girdi ayni icerik
 * (olusturma zamani girdiden gelir); S3'te veri ozetiyle onbelleklenir.
 * Yalnizca gomulu fontta bulunan karakterler kullanilir (Noto Sans alt kumesi).
 */
export type ReportColumn = { header: string; /** Goreli genislik. */ width: number; align?: 'left' | 'right' };
export type ReportRow = { cells: string[]; bold?: boolean; muted?: boolean; /** Ustunde ayirici cizgi (toplam satiri). */ rule?: boolean };
export type ReportSection = {
  title?: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** Veri satiri yuksekligi (pt; varsayilan 15). Y1 hazirun cetveli imza payi icin daha yuksek satir kullanir. */
  rowHeight?: number;
  /** Her veri satirinin altina ince cizgi (elle doldurulan cizelgeler). */
  ruled?: boolean;
  /**
   * Basliktan sonra, tablodan once satir kaydirmali metin paragraflari (genel kurul tutanagindaki
   * gorusme notlari). `columns` bos ise yalnizca paragraflar basilir.
   */
  paragraphs?: string[];
};

export type ReportPdfData = {
  apartmentName: string;
  title: string;
  subtitle?: string;
  sections: ReportSection[];
  notes?: string[];
  generatedAt: string;
  dataHash: string;
};

/** Sablon surumu: duzen degisince artirilir (onbellek anahtarina girer). */
export const REPORT_TEMPLATE_VERSION = 1;

const PAGE: [number, number] = [841.89, 595.28];
const M = 36;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.44, 0.44, 0.48);
const LINE = rgb(0.85, 0.85, 0.87);
const HEAD_BG = rgb(0.95, 0.95, 0.96);
const ACCENT = rgb(0.15, 0.39, 0.92);
const ROW_H = 15;
const SIZE = 8.5;

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Metni genislige gore satirlara boler (satir sonlari korunur; sigmayan uzun kelime bolunur). */
export function wrapText(text: string, font: Pick<PDFFont, 'widthOfTextAtSize'>, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  const width = (s: string) => font.widthOfTextAtSize(s, size);
  for (const para of text.split(/\r?\n/)) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= maxWidth) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      let rest = word;
      while (rest.length > 1 && width(rest) > maxWidth) {
        let k = rest.length - 1;
        while (k > 1 && width(rest.slice(0, k)) > maxWidth) k -= 1;
        out.push(rest.slice(0, k));
        rest = rest.slice(k);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

export async function renderReportPdf(data: ReportPdfData, fonts?: PdfFonts): Promise<Uint8Array> {
  const { regular, bold } = fonts ?? (await loadPdfFonts());
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await doc.embedFont(regular, { subset: false });
  const fb = await doc.embedFont(bold, { subset: false });
  const generated = new Date(data.generatedAt);
  doc.setTitle(`${data.title} - ${data.apartmentName}`);
  doc.setAuthor(data.apartmentName);
  doc.setCreator(PDF_PRODUCER);
  doc.setProducer(PDF_PRODUCER);
  doc.setLanguage('tr-TR');
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const [W, H] = PAGE;
  const contentW = W - 2 * M;
  let page!: PDFPage;
  let y = 0;

  const header = () => {
    page = doc.addPage(PAGE);
    page.drawRectangle({ x: 0, y: H - 4, width: W, height: 4, color: ACCENT });
    y = H - M;
    // Site adi ve rapor basligi ayni taban cizgisinde.
    const baseline = y - 14;
    page.drawText(fit(data.apartmentName, fb, 14, contentW * 0.55), { x: M, y: baseline, size: 14, font: fb, color: INK });
    const title = fit(data.title.toLocaleUpperCase('tr-TR'), fb, 10, contentW * 0.42);
    page.drawText(title, { x: W - M - fb.widthOfTextAtSize(title, 10), y: baseline, size: 10, font: fb, color: ACCENT });
    y = baseline - 16;
    if (data.subtitle) {
      page.drawText(fit(data.subtitle, f, 9, contentW), { x: M, y, size: 9, font: f, color: MUTED });
      y -= 14;
    }
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINE });
    y -= 14;
  };

  const columnsX = (cols: ReportColumn[]) => {
    const total = cols.reduce((s, c) => s + c.width, 0);
    let x = M;
    return cols.map((c) => {
      const w = (c.width / total) * contentW;
      const start = x;
      x += w;
      return { start, end: x, w };
    });
  };

  const drawRow = (cols: ReportColumn[], cells: string[], opts: { font: PDFFont; color?: ReturnType<typeof rgb>; bg?: boolean; height?: number; ruled?: boolean }) => {
    const h = opts.height ?? ROW_H;
    const xs = columnsX(cols);
    if (opts.bg) page.drawRectangle({ x: M, y: y - 4, width: contentW, height: ROW_H, color: HEAD_BG });
    cols.forEach((c, i) => {
      const box = xs[i]!;
      const text = fit(cells[i] ?? '', opts.font, SIZE, box.w - 6);
      const x = c.align === 'right' ? box.end - 3 - opts.font.widthOfTextAtSize(text, SIZE) : box.start + 3;
      page.drawText(text, { x, y, size: SIZE, font: opts.font, color: opts.color ?? INK });
    });
    if (opts.ruled) page.drawLine({ start: { x: M, y: y + ROW_H - 4 - h }, end: { x: W - M, y: y + ROW_H - 4 - h }, thickness: 0.4, color: LINE });
    y -= h;
  };

  header();
  for (const section of data.sections) {
    const headerRow = () => drawRow(section.columns, section.columns.map((c) => c.header), { font: fb, color: MUTED, bg: true });
    if (y < M + 40 + ROW_H * 3) header();
    if (section.title) {
      page.drawText(fit(section.title, fb, 10.5, contentW), { x: M, y, size: 10.5, font: fb, color: INK });
      y -= 16;
    }
    for (const p of section.paragraphs ?? []) {
      for (const line of wrapText(p, f, 9, contentW)) {
        if (y < M + 20) header();
        if (line) page.drawText(line, { x: M, y, size: 9, font: f, color: INK });
        y -= 12;
      }
      y -= 4;
    }
    if (section.columns.length === 0) {
      y -= 6;
      continue;
    }
    if (y < M + 15 + ROW_H * 2) header();
    headerRow();
    const rowH = section.rowHeight ?? ROW_H;
    for (const row of section.rows) {
      if (y < M + 15 + rowH) {
        header();
        if (section.title) {
          page.drawText(fit(`${section.title} (devam)`, fb, 10.5, contentW), { x: M, y, size: 10.5, font: fb, color: INK });
          y -= 16;
        }
        headerRow();
      }
      if (row.rule) page.drawLine({ start: { x: M, y: y + ROW_H - 4 }, end: { x: W - M, y: y + ROW_H - 4 }, thickness: 0.6, color: LINE });
      drawRow(section.columns, row.cells, { font: row.bold ? fb : f, height: rowH, ruled: Boolean(section.ruled), ...(row.muted ? { color: MUTED } : {}) });
    }
    y -= 10;
  }
  for (const n of data.notes ?? []) {
    if (y < M + 30) header();
    page.drawText(fit(n, f, 8, contentW), { x: M, y, size: 8, font: f, color: MUTED });
    y -= 12;
  }

  const pages = doc.getPages();
  const stampText = `Oluşturma: ${generated.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })} · Doğrulama: ${data.dataHash.slice(0, 16)}`;
  pages.forEach((p, i) => {
    p.drawText(fit(stampText, f, 7.5, contentW * 0.75), { x: M, y: M - 14, size: 7.5, font: f, color: MUTED });
    const num = `Sayfa ${i + 1} / ${pages.length}`;
    p.drawText(num, { x: W - M - f.widthOfTextAtSize(num, 7.5), y: M - 14, size: 7.5, font: f, color: MUTED });
  });
  return doc.save();
}
