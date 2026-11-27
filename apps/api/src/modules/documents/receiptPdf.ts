import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, degrees, rgb } from 'pdf-lib';
import { PDF_PRODUCER } from './brand.js';
import { amountInWordsTR } from './amountWords.js';
import { type PdfFonts, loadPdfFonts } from './fonts.js';

/**
 * Tahsilat makbuzu PDF'i (A5 dikey). Saf: ayni girdi her zaman ayni icerigi uretir
 * (olusturma tarihi girdiden gelir), bu yuzden S3'te onbelleklenebilir.
 * Kisisel veri en azdadir: ic not ve kimlik bilgisi yazilmaz.
 */
export type ReceiptData = {
  receiptNumber: string;
  apartmentName: string;
  apartmentAddress?: string;
  unitLabel: string;
  /** "Kat Maliki" | "Oturan (Kiracı/Sakin)" */
  partyLabel: string;
  payerName?: string;
  /** "Nakit" | "Banka havalesi / EFT" | "Kredi kartı" */
  methodLabel: string;
  paidAt: string; // YYYY-MM-DD
  amount: number; // kurus
  description: string;
  issuedAt: string; // ISO, kaydin olusturulma zamani
  reversed?: boolean;
};

const A5: [number, number] = [419.53, 595.28];
const M = 36;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.44, 0.44, 0.48);
const LINE = rgb(0.85, 0.85, 0.87);
const ACCENT = rgb(0.15, 0.39, 0.92);
const DANGER = rgb(0.86, 0.15, 0.15);

const money = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', minimumFractionDigits: 2 });
export const formatTRY = (kurus: number) => money.format(kurus / 100);

export function formatDateTR(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('tr-TR', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Genisligi asan metni "…" ile kisaltir. */
function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

/** Kelime kaydirmali metin; cizilen satir sayisini doner. */
function wrap(page: PDFPage, text: string, o: { x: number; y: number; width: number; font: PDFFont; size: number; color: ReturnType<typeof rgb>; lineGap?: number; maxLines?: number }): number {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (o.font.widthOfTextAtSize(next, o.size) > o.width && line) {
      lines.push(line);
      line = w;
    } else line = next;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, o.maxLines ?? lines.length);
  shown.forEach((l, i) => {
    page.drawText(l, { x: o.x, y: o.y - i * (o.size + (o.lineGap ?? 3)), size: o.size, font: o.font, color: o.color });
  });
  return shown.length;
}

export async function renderReceiptPdf(data: ReceiptData, fonts?: PdfFonts): Promise<Uint8Array> {
  const { regular, bold } = fonts ?? (await loadPdfFonts());
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  // pdf-lib'in kendi alt kume (subset) uretimi bu fontta glifleri bozuyor; fontlar zaten
  // yalnizca gerekli karakterlerle (~21 KB) hazirlandigi icin tam gomulur (assets/fonts/README.md).
  const f = await doc.embedFont(regular, { subset: false });
  const fb = await doc.embedFont(bold, { subset: false });

  const issued = new Date(data.issuedAt);
  doc.setTitle(`Tahsilat Makbuzu ${data.receiptNumber}`);
  doc.setSubject(`${data.apartmentName} - ${data.unitLabel}`);
  doc.setAuthor(data.apartmentName);
  doc.setCreator(PDF_PRODUCER);
  doc.setProducer(PDF_PRODUCER);
  doc.setLanguage('tr-TR');
  doc.setCreationDate(issued);
  doc.setModificationDate(issued);

  const page = doc.addPage(A5);
  const [W, H] = A5;
  const contentW = W - 2 * M;
  let y = H - M;

  // --- Ust bilgi ---
  page.drawRectangle({ x: 0, y: H - 6, width: W, height: 6, color: ACCENT });
  page.drawText(fit(data.apartmentName, fb, 14, contentW * 0.6), { x: M, y: y - 14, size: 14, font: fb, color: INK });
  if (data.apartmentAddress) {
    wrap(page, data.apartmentAddress, { x: M, y: y - 30, width: contentW * 0.6, font: f, size: 8, color: MUTED, maxLines: 2 });
  }
  const title = 'TAHSİLAT MAKBUZU';
  page.drawText(title, { x: W - M - fb.widthOfTextAtSize(title, 10), y: y - 12, size: 10, font: fb, color: ACCENT });
  const no = data.receiptNumber;
  page.drawText(no, { x: W - M - fb.widthOfTextAtSize(no, 13), y: y - 28, size: 13, font: fb, color: INK });
  const date = formatDateTR(data.paidAt);
  page.drawText(date, { x: W - M - f.widthOfTextAtSize(date, 9), y: y - 42, size: 9, font: f, color: MUTED });

  y -= 64;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.8, color: LINE });

  // --- Tutar kutusu ---
  y -= 16;
  const boxH = 74;
  page.drawRectangle({ x: M, y: y - boxH, width: contentW, height: boxH, borderColor: LINE, borderWidth: 0.8, color: rgb(0.97, 0.97, 0.98) });
  page.drawText('Tahsil edilen tutar', { x: M + 12, y: y - 18, size: 8, font: f, color: MUTED });
  page.drawText(formatTRY(data.amount), { x: M + 12, y: y - 42, size: 22, font: fb, color: INK });
  wrap(page, `Yalnız: ${amountInWordsTR(data.amount)}`, { x: M + 12, y: y - 60, width: contentW - 24, font: f, size: 8.5, color: INK, maxLines: 1 });
  y -= boxH + 22;

  // --- Ayrintilar ---
  const rows: [string, string][] = [
    ['Blok / Daire', data.unitLabel],
    ['Cari hesap', data.partyLabel],
    ...(data.payerName ? ([['Ödeyen', data.payerName]] as [string, string][]) : []),
    ['Ödeme yöntemi', data.methodLabel],
    ['Tahsilat tarihi', date],
    ['Açıklama', data.description],
  ];
  const labelW = 110;
  for (const [label, value] of rows) {
    page.drawText(label, { x: M, y, size: 9, font: f, color: MUTED });
    page.drawText(fit(value, fb, 9.5, contentW - labelW), { x: M + labelW, y, size: 9.5, font: fb, color: INK });
    y -= 8;
    page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.5, color: LINE });
    y -= 14;
  }

  // --- Alt bilgi ---
  const footer = `Bu makbuz ${data.apartmentName} yönetimi adına elektronik ortamda düzenlenmiştir. Kayıt zamanı: ${issued.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}.`;
  wrap(page, footer, { x: M, y: M + 18, width: contentW, font: f, size: 7.5, color: MUTED, maxLines: 3 });

  // --- Iptal damgasi ---
  if (data.reversed) {
    const stamp = 'İPTAL EDİLDİ';
    const size = 44;
    const w = fb.widthOfTextAtSize(stamp, size);
    page.drawText(stamp, {
      x: W / 2 - (w / 2) * Math.cos(Math.PI / 6),
      y: H / 2 - (w / 2) * Math.sin(Math.PI / 6),
      size,
      font: fb,
      color: DANGER,
      opacity: 0.22,
      rotate: degrees(30),
    });
    const note = 'Bu tahsilat ters kayıtla iptal edilmiştir; makbuz geçersizdir.';
    page.drawText(note, { x: M, y: M + 40, size: 8, font: fb, color: DANGER });
  }

  return doc.save({ useObjectStreams: false });
}
