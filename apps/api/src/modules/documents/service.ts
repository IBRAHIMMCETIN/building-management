import { randomUUID } from 'node:crypto';
import { type CoreRepository, coreRepository } from '../core/repository.js';
import type { IsoDate, LiableParty } from '../core/types.js';
import { asObject, assertId, reqInt, reqString } from '../core/validation.js';
import { type FinanceRepository, financeRepository } from '../finance/repository.js';
import type { Payment, PaymentMethod } from '../finance/types.js';
import { type PortalRepository, portalRepository } from '../portal/repository.js';
import type { PortalContext, PortalService } from '../portal/service.js';
import { DocumentError } from './errors.js';
import {
  INVOICE_CONTENT_TYPES,
  MAX_INVOICE_BYTES,
  contentDisposition,
  invoiceKey,
  isInvoiceContentType,
  pendingUploadKey,
  receiptKey,
  safeFileName,
} from './keys.js';
import { renderReceiptPdf } from './receiptPdf.js';
import { type DocumentStore, URL_TTL_SECONDS, createDocumentStoreFromEnv } from './store.js';

/**
 * Belgeler: tahsilat makbuzu PDF'i (ilk istekte uretilir, S3'te onbelleklenir) ve gider
 * faturasi yukleme / indirme. Tum erisim kisa omurlu imzali URL ile; yetki API'de kontrol edilir.
 */

export type SignedDownload = { url: string; fileName: string; contentType: string; expiresAt: string };

export type InvoiceAttachment = { key: string; fileName: string; contentType: string; size: number };

export type DocumentsServiceDeps = {
  /** Yoksa (DOCUMENTS_BUCKET tanimsiz) belge uclari 503 doner. */
  store: DocumentStore | undefined;
  finance: Pick<FinanceRepository, 'getTransaction' | 'getPayment' | 'getExpense' | 'getIdempotency'>;
  payments: Pick<PortalRepository, 'listUnitPayments'>;
  core: Pick<CoreRepository, 'getSite' | 'getUnit' | 'getBlock'>;
  /** Sakin makbuzu yetkisi: portalin makbuz listesi (uyelik penceresi + gorulebilir cariler). */
  portal?: Pick<PortalService, 'getMyReceipts'>;
  now: () => Date;
  newId: () => string;
};

const METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: 'Nakit',
  bank_transfer: 'Banka havalesi / EFT',
  card: 'Kredi kartı',
};
const PARTY_LABEL: Record<LiableParty, string> = {
  owner: 'Kat Maliki',
  occupant: 'Oturan (Kiracı/Sakin)',
};

export function createDocumentsService(overrides: Partial<DocumentsServiceDeps> = {}) {
  const deps: DocumentsServiceDeps = {
    finance: financeRepository,
    payments: portalRepository,
    core: coreRepository,
    now: () => new Date(),
    newId: () => randomUUID(),
    ...overrides,
    // `store: undefined` acikca verilirse (test) ortamdan okunmaz.
    store: 'store' in overrides ? overrides.store : createDocumentStoreFromEnv(),
  };

  function requireStore(): DocumentStore {
    if (!deps.store) throw new DocumentError('unavailable', 'Belge deposu yapilandirilmamis (DOCUMENTS_BUCKET)');
    return deps.store;
  }

  const expiresAt = () => new Date(deps.now().getTime() + URL_TTL_SECONDS * 1000).toISOString();

  async function sign(key: string, fileName: string, contentType: string): Promise<SignedDownload> {
    const url = await requireStore().presignGet(key, {
      contentDisposition: contentDisposition(fileName, 'inline'),
      contentType,
      expiresIn: URL_TTL_SECONDS,
    });
    return { url, fileName, contentType, expiresAt: expiresAt() };
  }

  // -------------------------------------------------------------------------
  // Makbuz
  // -------------------------------------------------------------------------

  async function isReversed(apartmentId: string, transactionId: string): Promise<boolean> {
    // Ters kayit `REV_<transactionId>` idempotency kaydi ile tekil yazilir (finance service).
    return Boolean(await deps.finance.getIdempotency(apartmentId, `REV_${transactionId}`));
  }

  /**
   * Makbuz PDF'i yoksa uretip S3'e yazar, imzali indirme linki doner. Iptal edilen tahsilat
   * ayri anahtarla (`-iptal`) yeniden uretilir: onceden onbelleklenmis gecerli makbuz
   * iptalden sonra asla verilmez.
   */
  async function receiptForPayment(apartmentId: string, payment: Payment): Promise<SignedDownload & { status: 'valid' | 'reversed' }> {
    const store = requireStore();
    if (payment.siteId !== apartmentId) throw new DocumentError('not_found', 'Makbuz bulunamadi');
    const reversed = await isReversed(apartmentId, payment.transactionId);
    const key = receiptKey(apartmentId, payment.paidAt, payment.paymentId, reversed);

    if (!(await store.head(key))) {
      const [site, unit] = await Promise.all([deps.core.getSite(apartmentId), deps.core.getUnit(apartmentId, payment.unitId)]);
      const block = unit ? await deps.core.getBlock(apartmentId, unit.blockId) : undefined;
      const address = site
        ? [site.address.line1, site.address.line2, `${site.address.district} / ${site.address.city}`].filter(Boolean).join(', ')
        : undefined;
      const pdf = await renderReceiptPdf({
        receiptNumber: payment.receiptNumber,
        apartmentName: site?.name ?? 'Apartman Yönetimi',
        apartmentAddress: address,
        unitLabel: unit ? (block ? `${block.name} · Daire ${unit.number}` : `Daire ${unit.number}`) : payment.unitId,
        partyLabel: PARTY_LABEL[payment.liableParty],
        payerName: payment.payerName,
        methodLabel: METHOD_LABEL[payment.method],
        paidAt: payment.paidAt,
        amount: payment.amount,
        description: 'Aidat ve ortak gider tahsilatı',
        issuedAt: payment.createdAt,
        reversed,
      });
      await store.put(key, pdf, 'application/pdf');
    }

    const fileName = `Makbuz-${payment.receiptNumber}${reversed ? '-IPTAL' : ''}.pdf`;
    return { ...(await sign(key, fileName, 'application/pdf')), status: reversed ? 'reversed' : 'valid' };
  }

  /** Yonetici/denetci: defter hareketinden (tahsilat islemi) makbuz. */
  async function receiptForTransaction(apartmentId: string, transactionId: string) {
    assertId(transactionId, 'transactionId');
    requireStore();
    const tx = await deps.finance.getTransaction(apartmentId, transactionId);
    if (!tx || tx.siteId !== apartmentId || tx.kind !== 'payment') throw new DocumentError('not_found', 'Tahsilat islemi bulunamadi');
    const unitId = tx.lines.find((l) => l.unitId)?.unitId;
    const payment = unitId
      ? (await deps.payments.listUnitPayments(apartmentId, unitId)).find((p) => p.transactionId === transactionId)
      : undefined;
    if (!payment) throw new DocumentError('not_found', 'Bu islemin makbuz kaydi bulunamadi');
    return receiptForPayment(apartmentId, payment);
  }

  /** Yonetici/denetci: makbuz kaydindan (online odeme listesi `paymentIds`). */
  async function receiptForPaymentId(apartmentId: string, paymentId: string) {
    assertId(paymentId, 'paymentId');
    requireStore();
    const payment = await deps.finance.getPayment(apartmentId, paymentId);
    if (!payment || payment.siteId !== apartmentId) throw new DocumentError('not_found', 'Makbuz bulunamadi');
    return receiptForPayment(apartmentId, payment);
  }

  /**
   * Sakin: yalnizca portalin "makbuzlarim" listesinde gorunen makbuz (kendi dairesi, gorebildigi
   * cari, uyelik donemi). Listede yoksa 404 (baska makbuzun varligi sizdirilmaz).
   */
  async function residentReceipt(ctx: PortalContext, paymentId: string, unitId?: string) {
    assertId(paymentId, 'paymentId');
    requireStore();
    if (!deps.portal) throw new DocumentError('unavailable', 'Portal servisi yapilandirilmamis');
    const mine = await deps.portal.getMyReceipts(ctx, unitId);
    if (!mine.items.some((r) => r.paymentId === paymentId)) throw new DocumentError('not_found', 'Makbuz bulunamadi');
    const payment = await deps.finance.getPayment(ctx.apartmentId, paymentId);
    if (!payment) throw new DocumentError('not_found', 'Makbuz bulunamadi');
    return receiptForPayment(ctx.apartmentId, payment);
  }

  // -------------------------------------------------------------------------
  // Gider faturasi
  // -------------------------------------------------------------------------

  /**
   * 1. adim: tarayicinin dosyayi dogrudan S3'e yuklemesi icin imzali PUT linki. Dosya once
   * gecici alana (`tmp/`) gider; gider kaydedilmezse S3 yasam dongusu 1 gunde siler.
   */
  async function createInvoiceUpload(apartmentId: string, body: unknown) {
    const store = requireStore();
    const o = asObject(body);
    const fileName = safeFileName(reqString(o, 'fileName', 255));
    const contentType = o.contentType;
    if (!isInvoiceContentType(contentType)) {
      throw new DocumentError('unprocessable', `Desteklenmeyen dosya turu. Izin verilenler: PDF, JPEG, PNG, WEBP, HEIC`);
    }
    const size = reqInt(o, 'size', 1, Number.MAX_SAFE_INTEGER);
    if (size > MAX_INVOICE_BYTES) throw new DocumentError('unprocessable', 'Dosya en fazla 10 MB olabilir');

    const uploadId = deps.newId();
    const url = await store.presignPut(pendingUploadKey(apartmentId, uploadId), {
      contentType,
      contentLength: size,
      expiresIn: URL_TTL_SECONDS,
    });
    return {
      uploadId,
      fileName,
      uploadUrl: url,
      method: 'PUT' as const,
      headers: { 'Content-Type': contentType },
      maxBytes: MAX_INVOICE_BYTES,
      expiresAt: expiresAt(),
    };
  }

  /**
   * 2. adim (gider kaydi sirasinda, finance service cagirir): gecici dosya dogrulanir ve kalici
   * `invoices/` anahtarina kopyalanir. Boyut ve tur S3'teki gercek nesneden kontrol edilir.
   */
  async function promoteInvoice(
    apartmentId: string,
    upload: { uploadId: string; fileName: string },
    target: { expenseId: string; date: IsoDate },
  ): Promise<InvoiceAttachment> {
    const store = requireStore();
    const uploadId = assertId(upload.uploadId, 'invoiceUpload.uploadId');
    const tmp = pendingUploadKey(apartmentId, uploadId);
    const head = await store.head(tmp);
    if (!head) throw new DocumentError('unprocessable', 'Fatura dosyasi bulunamadi (yukleme tamamlanmamis veya suresi dolmus); tekrar yukleyin');
    if (head.size > MAX_INVOICE_BYTES) throw new DocumentError('unprocessable', 'Dosya en fazla 10 MB olabilir');
    if (!isInvoiceContentType(head.contentType)) throw new DocumentError('unprocessable', 'Desteklenmeyen dosya turu');

    const key = invoiceKey(apartmentId, target.date, target.expenseId, INVOICE_CONTENT_TYPES[head.contentType]);
    await store.copy(tmp, key);
    return { key, fileName: safeFileName(upload.fileName, 'fatura'), contentType: head.contentType, size: head.size };
  }

  /** Yonetici/denetci: gider hareketinin faturasi. */
  async function invoiceForTransaction(apartmentId: string, transactionId: string) {
    assertId(transactionId, 'transactionId');
    requireStore();
    const tx = await deps.finance.getTransaction(apartmentId, transactionId);
    const expenseId = tx?.siteId === apartmentId ? tx.invoice?.expenseId : undefined;
    const expense = expenseId ? await deps.finance.getExpense(apartmentId, expenseId) : undefined;
    if (!expense?.invoice) throw new DocumentError('not_found', 'Bu harekete bagli fatura yok');
    return sign(expense.invoice.key, expense.invoice.fileName, expense.invoice.contentType);
  }

  return { receiptForPayment, receiptForTransaction, receiptForPaymentId, residentReceipt, createInvoiceUpload, promoteInvoice, invoiceForTransaction };
}

export type DocumentsService = ReturnType<typeof createDocumentsService>;
