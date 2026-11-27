import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import { PDF_PRODUCER } from './brand.js';
import { type PdfFonts, loadPdfFonts } from './fonts.js';
import { formatDateTR, formatTRY } from './receiptPdf.js';

/**
 * Finans 2.3-5a - Sayac Dagitim Dokumu (daire basina, A4 dikey, tek sayfa). Saf: ayni girdi ayni
 * icerigi uretir (olusturma zamani girdiden gelir); S3'te veri ozetiyle onbelleklenir.
 * Yalnizca gomulu fontta bulunan karakterler kullanilir (Noto Sans alt kumesi U+00A0-00FF'i icerir:
 * '²' ve '·' guvenli; tire '-').
 */
export type MeterStatementPdfData = {
  apartmentName: string;
  unitLabel: string;
  periodName: string;
  startDate: string;
  endDate: string;
  dueDate: string;
  /** Ornegin "Isınma". */
  categoryLabel: string;
  commonShareBps: number;
  /** Ornegin "Kullanım alanı (m²)". */
  commonKeyLabel: string;
  totalAmount: number;
  commonPool: number;
  consumptionPool: number;
  fallbackToCommon: boolean;
  buildingConsumption: string;
  meters: { label: string; serialNo?: string; startIndex?: string; endIndex: string; delta: string; estimated?: boolean }[];
  unitConsumption: string;
  /** Dairenin tuketim payi, yuzde (iki ondalik, metin). */
  consumptionSharePct: string;
  commonAmount: number;
  consumptionAmount: number;
  amount: number;
  buildingAverage: string;
  blockAverage?: string;
  estimated: boolean;
  generatedAt: string;
  dataHash: string;
};

/** Sablon surumu: duzen degisince artirilir (onbellek anahtarina girer). */
export const METER_STATEMENT_TEMPLATE_VERSION = 2;

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.44, 0.44, 0.48);
const LINE = rgb(0.85, 0.85, 0.87);
const ACCENT = rgb(0.15, 0.39, 0.92);

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export async function renderMeterStatementPdf(data: MeterStatementPdfData, fonts?: PdfFonts): Promise<Uint8Array> {
  const { regular, bold } = fonts ?? (await loadPdfFonts());
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await doc.embedFont(regular, { subset: false });
  const fb = await doc.embedFont(bold, { subset: false });
  const generated = new Date(data.generatedAt);
  doc.setTitle(`Sayaç Dağıtım Dökümü ${data.periodName} ${data.unitLabel}`);
  doc.setSubject(`${data.apartmentName} - ${data.unitLabel}`);
  doc.setAuthor(data.apartmentName);
  doc.setCreator(PDF_PRODUCER);
  doc.setProducer(PDF_PRODUCER);
  doc.setLanguage('tr-TR');
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const [W, H] = A4;
  const contentW = W - 2 * M;
  const page: PDFPage = doc.addPage(A4);
  page.drawRectangle({ x: 0, y: H - 5, width: W, height: 5, color: ACCENT });
  let y = H - M;
  const text = (t: string, x: number, size: number, font: PDFFont = f, color = INK) => page.drawText(t, { x, y, size, font, color });
  const right = (t: string, xRight: number, size: number, font: PDFFont = f, color = INK) =>
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  const rule = (thickness = 0.5) => page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness, color: LINE });
  const row = (label: string, value: string, strong = false) => {
    text(label, M, 9.5, f, MUTED);
    right(value, W - M, 10, strong ? fb : f);
    y -= 7;
    rule();
    y -= 13;
  };

  // Baslik
  // Site adi (sol) ve belge basligi (sag) ayni taban cizgisinde (v2: baslik eskiden 3pt yukaridaydi).
  const headerBaseline = y - 15;
  page.drawText(fit(data.apartmentName, fb, 15, contentW * 0.6), { x: M, y: headerBaseline, size: 15, font: fb, color: INK });
  const title = 'SAYAÇ DAĞITIM DÖKÜMÜ';
  page.drawText(title, { x: W - M - fb.widthOfTextAtSize(title, 10), y: headerBaseline, size: 10, font: fb, color: ACCENT });
  y -= 34;
  text(fit(`${data.categoryLabel} - ${data.periodName}`, fb, 11, contentW), M, 11, fb);
  y -= 15;
  text(`Bağımsız bölüm: ${data.unitLabel}`, M, 10);
  y -= 14;
  text(`Dönem: ${formatDateTR(data.startDate)} - ${formatDateTR(data.endDate)}    Son ödeme: ${formatDateTR(data.dueDate)}`, M, 9.5, f, MUTED);
  y -= 12;
  rule(0.8);
  y -= 22;

  // Dagitim esasi
  text('Dağıtım esası (bina geneli)', M, 11, fb);
  y -= 18;
  const commonPct = (data.commonShareBps / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  const consPct = ((10_000 - data.commonShareBps) / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 });
  row('Fatura tutarı', formatTRY(data.totalAmount), true);
  row(`Ortak pay (%${commonPct}, ${data.commonKeyLabel})`, formatTRY(data.commonPool));
  row(`Tüketim payı (%${consPct}, sayaç okumalarına göre)`, formatTRY(data.consumptionPool));
  row('Bina toplam tüketimi', data.buildingConsumption);
  if (data.fallbackToCommon) {
    text(fit('Toplam tüketim sıfır olduğundan tutarın tamamı ortak anahtarla dağıtılmıştır.', f, 8.5, contentW), M, 8.5, f, MUTED);
    y -= 18;
  }
  y -= 8;

  // Sayaclar
  text('Sayaç okumaları', M, 11, fb);
  y -= 16;
  const cols = { label: M, serial: M + 170, start: W - M - 190, end: W - M - 95, delta: W - M };
  text('Sayaç', cols.label, 8.5, fb, MUTED);
  text('Seri no', cols.serial, 8.5, fb, MUTED);
  right('İlk endeks', cols.start, 8.5, fb, MUTED);
  right('Son endeks', cols.end, 8.5, fb, MUTED);
  right('Tüketim', cols.delta, 8.5, fb, MUTED);
  y -= 6;
  rule();
  y -= 13;
  if (data.meters.length === 0) {
    text('Bu bölümde sayaç yok; yalnızca ortak pay yansıtılmıştır.', M, 9, f, MUTED);
    y -= 20;
  }
  for (const m of data.meters.slice(0, 20)) {
    text(fit(`${m.label}${m.estimated ? ' (tahmini)' : ''}`, f, 9, 160), cols.label, 9);
    text(fit(m.serialNo ?? '-', f, 9, 110), cols.serial, 9);
    right(m.startIndex ?? '-', cols.start, 9);
    right(m.endIndex, cols.end, 9);
    right(m.delta, cols.delta, 9, fb);
    y -= 6;
    rule();
    y -= 13;
  }
  y -= 8;

  // Daire payi
  text('Bölümünüzün payı', M, 11, fb);
  y -= 18;
  row('Bölüm tüketimi', `${data.unitConsumption}  (%${data.consumptionSharePct})`);
  row('Bina ortalaması (sayaçlı bölümler)', data.buildingAverage);
  if (data.blockAverage) row('Blok ortalaması', data.blockAverage);
  row('Ortak pay', formatTRY(data.commonAmount));
  row('Tüketim payı', formatTRY(data.consumptionAmount));
  row('Tahakkuk tutarı', formatTRY(data.amount), true);
  y -= 6;
  const notes = [
    'Tutarlar kuruş hassasiyetinde en büyük kalan yöntemiyle dağıtılmıştır; bölüm tutarlarının toplamı fatura tutarına eşittir.',
    ...(data.estimated ? ['Bu dönemde en az bir okuma, yönetici onayıyla geçmiş tüketim ortalamasından tahmin edilmiştir.'] : []),
  ];
  for (const n of notes) {
    text(fit(n, f, 8.5, contentW), M, 8.5, f, MUTED);
    y -= 13;
  }

  // Alt bilgi
  const footer = `Oluşturma: ${generated.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })} · Doğrulama: ${data.dataHash.slice(0, 16)}`;
  page.drawText(fit(footer, f, 7.5, contentW), { x: M, y: M - 10, size: 7.5, font: f, color: MUTED });
  return doc.save();
}
