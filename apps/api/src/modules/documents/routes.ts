import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { DocumentsService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];
const RESIDENT_ROLES: readonly Role[] = ['resident'];

export type DocumentRoutesDeps = { authenticate: Authenticator; service: DocumentsService };

/**
 * `/api/documents` - dosyalar yalnizca kisa omurlu (5 dk) imzali S3 linkiyle verilir.
 *   GET  /receipts/by-transaction/:transactionId   yonetici/denetci: tahsilat makbuzu PDF
 *   GET  /invoices/by-transaction/:transactionId   yonetici/denetci: gider faturasi
 *   POST /invoice-uploads                          yonetici: fatura yukleme linki
 *   GET  /my-receipts/:paymentId?unitId=           sakin: kendi makbuzu
 * Yanit: { url, fileName, contentType, expiresAt } (yukleme: { uploadId, uploadUrl, headers, ... }).
 * Linkler kisisel veri tasidigi icin yanitlar onbelleklenmez.
 */
export function documentRoutes({ authenticate, service }: DocumentRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const apt = (c: Context<Env>) => c.get('claims').apartmentId as string;
  const id = (c: Context<Env>) => c.req.param('transactionId') ?? '';

  r.get('/receipts/by-transaction/:transactionId', requireRole(READ_ROLES), async (c) =>
    c.json(await service.receiptForTransaction(apt(c), id(c))),
  );

  r.get('/invoices/by-transaction/:transactionId', requireRole(READ_ROLES), async (c) =>
    c.json(await service.invoiceForTransaction(apt(c), id(c))),
  );

  r.post('/invoice-uploads', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.createInvoiceUpload(apt(c), await readJson(c)), 201),
  );

  r.get('/my-receipts/:paymentId', requireRole(RESIDENT_ROLES), async (c) => {
    const { apartmentId, userId, role } = c.get('claims');
    return c.json(
      await service.residentReceipt({ apartmentId: apartmentId as string, userId, role }, c.req.param('paymentId') ?? '', c.req.query('unitId')),
    );
  });

  return r;
}
