import { createHash } from 'node:crypto';
import { REPORT_TEMPLATE_VERSION, type ReportPdfData } from '../documents/reportPdf.js';
import type { SubscriptionInvoice } from './types.js';

/**
 * Abonelik faturasi PDF icerigi (SAF): mevcut tablo rapor sablonu (`renderReportPdf`, gomulu Noto
 * Sans) kullanilir. Bu belge platformun bilgi / tahsilat belgesidir; resmi e-Fatura / e-Arsiv
 * sirket kurulduktan sonra entegratorle kesilir (README "Abonelik").
 *
 * S3: apartments/{apt}/billing/{yyyy}/{mm}/subscription-invoice-{numara}-{hash}.pdf (icerik ozetiyle
 * onbellek; odeme veya iptal yeni dosya uretir, eskisi kayit olarak kalir).
 */

export const INVOICE_PDF_TEMPLATE = 1;

const tl = (kurus: number) =>
  `${(kurus / 100).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₺`;
const date = (d: string) => `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
const vatText = (bps: number) => `%${(bps / 100).toLocaleString('tr-TR', { maximumFractionDigits: 2 })}`;

const STATUS: Record<SubscriptionInvoice['status'], string> = { issued: 'Ödeme bekliyor', paid: 'Ödendi', void: 'İptal edildi' };
const METHOD: Record<string, string> = { bank_transfer: 'Havale / EFT', cash: 'Nakit', online: 'Online ödeme', other: 'Diğer' };

export function invoicePdfContent(inv: SubscriptionInvoice): Omit<ReportPdfData, 'generatedAt' | 'dataHash'> {
  const info: [string, string][] = [
    ['Fatura no', inv.invoiceNumber],
    ['Düzenleme tarihi', date(inv.issueDate)],
    ['Son ödeme tarihi', date(inv.dueDate)],
    ['Dönem', `${date(inv.periodStart)} - ${date(inv.periodEnd)}`],
    ['Plan', `${inv.planName} (sürüm ${inv.planVersion})`],
    ['Bağımsız bölüm sayısı', String(inv.unitCount)],
    ['Durum', STATUS[inv.status]],
    ...(inv.status === 'paid' && inv.paidOn
      ? ([
          ['Ödeme tarihi', date(inv.paidOn)],
          ['Ödeme', `${METHOD[inv.paymentMethod ?? 'other'] ?? 'Diğer'}${inv.paymentReference ? ` · ${inv.paymentReference}` : ''}`],
        ] as [string, string][])
      : []),
  ];
  return {
    apartmentName: inv.siteName,
    title: 'Abonelik faturası',
    subtitle: `YÖNESİST kullanım bedeli · ${inv.invoiceNumber}`,
    sections: [
      { columns: [{ header: 'Bilgi', width: 1 }, { header: '', width: 2 }], rows: info.map(([k, v]) => ({ cells: [k, v] })) },
      {
        title: 'Kalemler',
        columns: [
          { header: 'Açıklama', width: 4 },
          { header: 'Miktar', width: 1, align: 'right' },
          { header: 'Birim fiyat', width: 1.5, align: 'right' },
          { header: 'Tutar', width: 1.5, align: 'right' },
        ],
        rows: [
          ...inv.lines.map((l) => ({ cells: [l.description, String(l.quantity), tl(l.unitPriceKurus), tl(l.amountKurus)] })),
          { cells: ['Ara toplam (KDV hariç)', '', '', tl(inv.netKurus)], rule: true },
          { cells: [`KDV ${vatText(inv.vatRateBps)}`, '', '', tl(inv.vatKurus)] },
          { cells: ['Genel toplam', '', '', tl(inv.totalKurus)], bold: true },
        ],
      },
    ],
    notes: [
      'Tutarlar Türk lirasıdır; KDV toplam matrah üzerinden hesaplanır.',
      'Bu belge bilgilendirme ve tahsilat amaçlıdır; resmi e-Fatura / e-Arşiv faturası ayrıca düzenlenir.',
      ...(inv.status === 'void' && inv.voidReason ? [`İptal gerekçesi: ${inv.voidReason}`] : []),
    ],
  };
}

export function invoicePdfHash(inv: SubscriptionInvoice): string {
  return createHash('sha256')
    .update(JSON.stringify({ t: INVOICE_PDF_TEMPLATE, r: REPORT_TEMPLATE_VERSION, c: invoicePdfContent(inv) }))
    .digest('hex');
}

export function invoicePdfKey(inv: SubscriptionInvoice, hash: string): string {
  const safe = inv.invoiceNumber.replace(/[^A-Za-z0-9_-]/g, '-');
  return `apartments/${inv.apartmentId}/billing/${inv.issueDate.slice(0, 4)}/${inv.issueDate.slice(5, 7)}/subscription-invoice-${safe}-${hash.slice(0, 16)}.pdf`;
}
