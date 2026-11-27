import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, type PDFFont, type PDFPage, rgb } from 'pdf-lib';
import { PDF_PRODUCER } from './brand.js';
import { type PdfFonts, loadPdfFonts } from './fonts.js';
import { formatDateTR, formatTRY } from './receiptPdf.js';

/**
 * Faz B3.5 - Donemsel banka mutabakat raporu (A4 dikey, cok sayfali). Saf: ayni girdi ayni
 * icerigi uretir (olusturma zamani girdiden gelir); S3'te veri ozetiyle onbelleklenir.
 * Yalnizca gomulu fontta bulunan karakterler kullanilir (eksi icin '-', aralik icin ' - ').
 * Karsi taraf IBAN'i yazilmaz (yalnizca maskeli banka hesabi IBAN'i).
 */
export type BankReconLine = {
  date: string;
  direction: 'in' | 'out';
  amount: number;
  description: string;
  counterpartyName?: string;
  /** Yoksayilan satirin gerekcesi. */
  reason?: string;
};

export type BankReconPdfData = {
  apartmentName: string;
  bankAccountName: string;
  ibanMasked?: string;
  period: { from?: string; to?: string };
  openingBalance?: number;
  openingDate?: string;
  ledgerBalanceAtStart?: number;
  closingBalance?: number;
  asOf?: string;
  ledgerBalanceAtEnd?: number;
  difference?: number;
  pendingNet?: number;
  unexplainedDiff?: number;
  breakdown: { label: string; count: number; amount: number }[];
  pending: BankReconLine[];
  ignored: BankReconLine[];
  /** Listeye sigmayan satir sayilari (rapor sinirlari). */
  pendingOmitted?: number;
  ignoredOmitted?: number;
  generatedAt: string;
  dataHash: string;
};

/** Sablon surumu: duzen degisince artirilir (onbellek anahtarina girer). */
export const BANK_RECON_TEMPLATE_VERSION = 1;

const A4: [number, number] = [595.28, 841.89];
const M = 40;
const INK = rgb(0.09, 0.09, 0.11);
const MUTED = rgb(0.44, 0.44, 0.48);
const LINE = rgb(0.85, 0.85, 0.87);
const ACCENT = rgb(0.15, 0.39, 0.92);
const DANGER = rgb(0.86, 0.15, 0.15);
const SUCCESS = rgb(0.09, 0.55, 0.3);

const signed = (k: number) => (k < 0 ? `-${formatTRY(-k)}` : formatTRY(k));

function fit(text: string, font: PDFFont, size: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && font.widthOfTextAtSize(`${t}…`, size) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

export async function renderBankReconPdf(data: BankReconPdfData, fonts?: PdfFonts): Promise<Uint8Array> {
  const { regular, bold } = fonts ?? (await loadPdfFonts());
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const f = await doc.embedFont(regular, { subset: false });
  const fb = await doc.embedFont(bold, { subset: false });

  const generated = new Date(data.generatedAt);
  const periodText = `${data.period.from ? formatDateTR(data.period.from) : 'Başlangıç'} - ${data.period.to ? formatDateTR(data.period.to) : data.asOf ? formatDateTR(data.asOf) : 'Bugün'}`;
  doc.setTitle(`Banka Mutabakat Raporu ${data.bankAccountName} ${periodText}`);
  doc.setSubject(`${data.apartmentName} - ${data.bankAccountName}`);
  doc.setAuthor(data.apartmentName);
  doc.setCreator(PDF_PRODUCER);
  doc.setProducer(PDF_PRODUCER);
  doc.setLanguage('tr-TR');
  doc.setCreationDate(generated);
  doc.setModificationDate(generated);

  const [W, H] = A4;
  const contentW = W - 2 * M;
  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;

  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    page.drawRectangle({ x: 0, y: H - 5, width: W, height: 5, color: ACCENT });
    y = H - M;
    if (pages.length > 1) {
      page.drawText(fit(`${data.apartmentName} · ${data.bankAccountName} · ${periodText}`, f, 8, contentW), { x: M, y: y - 8, size: 8, font: f, color: MUTED });
      y -= 24;
    }
  };
  const ensure = (h: number) => {
    if (y - h < M + 30) newPage();
  };
  const text = (t: string, x: number, size: number, font: PDFFont = f, color = INK) => page.drawText(t, { x, y, size, font, color });
  const right = (t: string, xRight: number, size: number, font: PDFFont = f, color = INK) =>
    page.drawText(t, { x: xRight - font.widthOfTextAtSize(t, size), y, size, font, color });
  const rule = (thickness = 0.5) => page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness, color: LINE });

  // --- Baslik ---
  newPage();
  page.drawText(fit(data.apartmentName, fb, 15, contentW * 0.6), { x: M, y: y - 15, size: 15, font: fb, color: INK });
  const title = 'BANKA MUTABAKAT RAPORU';
  page.drawText(title, { x: W - M - fb.widthOfTextAtSize(title, 10), y: y - 12, size: 10, font: fb, color: ACCENT });
  y -= 34;
  text(fit(`${data.bankAccountName}${data.ibanMasked ? ` · ${data.ibanMasked}` : ''}`, f, 10, contentW), M, 10);
  y -= 15;
  text(`Dönem: ${periodText}`, M, 10, fb);
  y -= 14;
  rule(0.8);
  y -= 22;

  // --- Bakiye ozeti ---
  const summary: [string, string, ReturnType<typeof rgb>?][] = [
    ['Açılış bakiyesi (ekstre)', data.openingBalance !== undefined ? `${signed(data.openingBalance)}${data.openingDate ? `  (${formatDateTR(data.openingDate)} başı)` : ''}` : '-'],
    ['Açılıştaki defter bakiyesi', data.ledgerBalanceAtStart !== undefined ? signed(data.ledgerBalanceAtStart) : '-'],
    ['Kapanış bakiyesi (ekstre)', data.closingBalance !== undefined ? `${signed(data.closingBalance)}${data.asOf ? `  (${formatDateTR(data.asOf)} sonu)` : ''}` : '-'],
    ['Kapanıştaki defter bakiyesi', data.ledgerBalanceAtEnd !== undefined ? signed(data.ledgerBalanceAtEnd) : '-'],
    ['Banka - defter farkı', data.difference !== undefined ? signed(data.difference) : '-', data.difference === 0 ? SUCCESS : undefined],
    ['Bekleyen satırların net etkisi', data.pendingNet !== undefined ? signed(data.pendingNet) : '-'],
    [
      'Açıklanamayan fark',
      data.unexplainedDiff !== undefined ? signed(data.unexplainedDiff) : '-',
      data.unexplainedDiff === undefined ? undefined : data.unexplainedDiff === 0 ? SUCCESS : DANGER,
    ],
  ];
  for (const [label, value, color] of summary) {
    text(label, M, 9.5, f, MUTED);
    right(value, W - M, 10, fb, color ?? INK);
    y -= 7;
    rule();
    y -= 13;
  }
  y -= 4;
  const note =
    data.unexplainedDiff === undefined
      ? 'Kapanış bakiyeli ekstre olmadığı için fark hesaplanamadı.'
      : data.unexplainedDiff === 0
        ? 'Banka ile defter arasındaki fark, henüz eşleştirilmemiş banka satırlarıyla tamamen açıklanmaktadır.'
        : 'Açıklanamayan fark: yoksayılıp deftere işlenmemiş hareketler, bankaya yansımamış elle kayıtlar veya eksik ekstreler kontrol edilmelidir.';
  text(fit(note, f, 8.5, contentW), M, 8.5, f, data.unexplainedDiff ? DANGER : MUTED);
  y -= 26;

  // --- Satir dokumu ---
  text('Banka satırı dökümü', M, 11, fb);
  y -= 16;
  text('Durum', M, 8.5, fb, MUTED);
  right('Adet', W - M - 120, 8.5, fb, MUTED);
  right('Tutar', W - M, 8.5, fb, MUTED);
  y -= 6;
  rule();
  y -= 13;
  for (const row of data.breakdown) {
    text(row.label, M, 9.5);
    right(String(row.count), W - M - 120, 9.5);
    right(formatTRY(row.amount), W - M, 9.5);
    y -= 6;
    rule();
    y -= 13;
  }
  y -= 12;

  // --- Satir listeleri ---
  const table = (heading: string, rows: BankReconLine[], omitted: number | undefined, withReason: boolean) => {
    ensure(60);
    text(`${heading} (${rows.length + (omitted ?? 0)})`, M, 11, fb);
    y -= 16;
    if (rows.length === 0) {
      text('Satır yok.', M, 9, f, MUTED);
      y -= 22;
      return;
    }
    const header = () => {
      text('Tarih', M, 8.5, fb, MUTED);
      text('Açıklama', M + 70, 8.5, fb, MUTED);
      right('Tutar', W - M, 8.5, fb, MUTED);
      y -= 6;
      rule();
      y -= 12;
    };
    header();
    for (const r of rows) {
      const h = withReason && r.reason ? 26 : 16;
      if (y - h < M + 30) {
        newPage();
        header();
      }
      text(r.date.split('-').reverse().join('.'), M, 8.5);
      const desc = [r.counterpartyName, r.description].filter(Boolean).join(' · ');
      text(fit(desc, f, 8.5, contentW - 70 - 95), M + 70, 8.5);
      right(`${r.direction === 'in' ? '+' : '-'}${formatTRY(r.amount)}`, W - M, 8.5, fb, r.direction === 'in' ? SUCCESS : INK);
      if (withReason && r.reason) {
        y -= 11;
        text(fit(`Gerekçe: ${r.reason}`, f, 7.5, contentW - 70), M + 70, 7.5, f, MUTED);
      }
      y -= 5;
      rule(0.3);
      y -= 11;
    }
    if (omitted) {
      text(`… ve ${omitted} satır daha (rapor sınırı). Tam liste için Finans > Banka kuyruğunu kullanın.`, M, 8, f, MUTED);
      y -= 14;
    }
    y -= 10;
  };
  table('Bekleyen (eşleşmemiş) satırlar', data.pending, data.pendingOmitted, false);
  table('Yoksayılan satırlar', data.ignored, data.ignoredOmitted, true);

  // --- Imza alani ---
  ensure(90);
  y -= 10;
  const colW = (contentW - 20) / 2;
  for (const [i, label] of ['Yönetici', 'Denetim kurulu / denetçi'].entries()) {
    const x = M + i * (colW + 20);
    page.drawText(label, { x, y, size: 9, font: fb, color: INK });
    page.drawLine({ start: { x, y: y - 40 }, end: { x: x + colW, y: y - 40 }, thickness: 0.6, color: LINE });
    page.drawText('Ad Soyad / İmza / Tarih', { x, y: y - 52, size: 7.5, font: f, color: MUTED });
  }

  // --- Alt bilgi (her sayfa) ---
  const stamp = generated.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  pages.forEach((p, i) => {
    const foot = `Oluşturulma: ${stamp} · Veri özeti: ${data.dataHash.slice(0, 12)} · Sayfa ${i + 1} / ${pages.length}`;
    p.drawText(fit(foot, f, 7.5, contentW), { x: M, y: M - 12, size: 7.5, font: f, color: MUTED });
  });

  return doc.save({ useObjectStreams: false });
}
