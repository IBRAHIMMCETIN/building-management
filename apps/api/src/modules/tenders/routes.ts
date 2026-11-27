import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { TenderError } from './errors.js';
import type { TenderContext, TenderService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type TenderRoutesDeps = { authenticate: Authenticator; service: TenderService };

/** Modul hatasi + ortak hata eslemesi (paylasilan `handleError`'a dokunmadan). */
function onError(err: Error, c: Context) {
  if (err instanceof TenderError) return c.json({ error: err.code, message: err.message, ...err.details }, err.httpStatus);
  return handleError(err, c);
}

function base(authenticate: Authenticator) {
  const r = new Hono<Env>();
  r.onError(onError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
    // Imzali belge linkleri ve teklif bilgisi onbelleklenmez.
    c.header('Cache-Control', 'no-store');
  });
  return r;
}

const ctxOf = (c: Context<Env>): TenderContext => {
  const claims = c.get('claims');
  return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
};
const id = (c: Context<Env>) => c.req.param('id') ?? '';
const quoteId = (c: Context<Env>) => c.req.param('quoteId') ?? '';

/**
 * `/api/tenders` - ihale / teklif toplama (yazma: yonetici + yonetim firmasi; okuma: + denetci,
 * denetci yalnizca yayinlanmis ihaleleri gorur).
 *
 *   GET   /                                  ?status=   ihaleler (ozet + en dusuk teklif)
 *   POST  /                                  { idempotencyKey, title, description, category, deadline, minQuotes?, ticketId? }
 *   GET   /:id                               ayrinti: teklifler (KDV normalize), karsilastirma, yorumlar, yayin hazirligi
 *   PATCH /:id                               { version, title?, description?, category?, deadline?, minQuotes?, ticketId? }  (taslak / toplama)
 *   POST  /:id/collect                       { version }                          taslak -> teklif toplama
 *   POST  /:id/publish                       { version, shortfallReason? }        -> yayinda (sakinlerle paylasilir)
 *   POST  /:id/decide                        { version, quoteId, reason, reference? }
 *   POST  /:id/cancel                        { version, reason }
 *   POST  /:id/quotes                        { idempotencyKey, supplierName, amountKurus, vatIncluded, vatRate, validUntil?,
 *                                              deliveryDays?, warrantyMonths?, notes?, document?: { uploadId, fileName } }
 *   PATCH /:id/quotes/:quoteId               { version, ...teklif alanlari, document? }
 *   POST  /:id/quotes/:quoteId/withdraw      { version, reason }
 *   GET   /:id/quotes/:quoteId/document      ?history=<sira>  5 dk imzali link (denetci: yalnizca yayinlanmis ihale;
 *                                              `history`: degistirilmis onceki belge, yalnizca yonetim)
 *   POST  /:id/comments                      { idempotencyKey, body }   yonetim yaniti (yalnizca yayinda; `tender.comment` denetimi)
 *   POST  /:id/expense                       { idempotencyKey, expenseAccountId?, creditAccountId?, amount?, date?, description?,
 *                                              supplier?, invoiceNumber?, invoiceUpload? }  karardan Finans gideri (Finans gider
 *                                              servisiyle; ihale basina bir gider, tekrar ayni sonuc; `ledger.expense` denetimi)
 * Belge yukleme: `POST /api/documents/invoice-uploads` (gider faturasiyla ayni sinirlar).
 */
export function tenderRoutes({ authenticate, service }: TenderRoutesDeps) {
  const r = base(authenticate);
  r.get('/', requireRole(READ_ROLES), async (c) => c.json(await service.list(ctxOf(c), { status: c.req.query('status') })));
  r.post('/', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.create(ctxOf(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctxOf(c), id(c))));
  r.patch('/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.update(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/collect', requireRole(WRITE_ROLES), async (c) => c.json(await service.collect(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/publish', requireRole(WRITE_ROLES), async (c) => c.json(await service.publish(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/decide', requireRole(WRITE_ROLES), async (c) => c.json(await service.decide(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/cancel', requireRole(WRITE_ROLES), async (c) => c.json(await service.cancel(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/quotes', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.addQuote(ctxOf(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.patch('/:id/quotes/:quoteId', requireRole(WRITE_ROLES), async (c) => c.json(await service.updateQuote(ctxOf(c), id(c), quoteId(c), await readJson(c))));
  r.post('/:id/quotes/:quoteId/withdraw', requireRole(WRITE_ROLES), async (c) => c.json(await service.withdrawQuote(ctxOf(c), id(c), quoteId(c), await readJson(c))));
  r.get('/:id/quotes/:quoteId/document', requireRole(READ_ROLES), async (c) => c.json(await service.quoteDocument(ctxOf(c), id(c), quoteId(c), { history: c.req.query('history') })));
  r.post('/:id/comments', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.comment(ctxOf(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/:id/expense', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.createExpense(ctxOf(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  return r;
}

/**
 * `/api/portal/tenders` - sakin (yalnizca `resident`, bu sitede guncel uyeligi olan). Yalnizca
 * yayinlanmis ihaleler; teklifler yan yana (KDV dahil toplam), belgeler 5 dk imzali linkle.
 *
 *   GET   /                                  yayinlanmis / karara baglanmis / yayindan sonra iptal edilmis ihaleler
 *   GET   /:id                               ayrinti + karsilastirma + sorular (sakin kimlikleri donmez)
 *   GET   /:id/quotes/:quoteId/document      imzali link
 *   POST  /:id/comments                      { idempotencyKey, body }   soru (yalnizca yayinda)
 */
export function tenderPortalRoutes({ authenticate, service }: TenderRoutesDeps) {
  const r = base(authenticate);
  r.use('*', requireRole(['resident']));
  r.get('/', async (c) => c.json(await service.portalList(ctxOf(c))));
  r.get('/:id', async (c) => c.json(await service.portalGet(ctxOf(c), id(c))));
  r.get('/:id/quotes/:quoteId/document', async (c) => c.json(await service.portalQuoteDocument(ctxOf(c), id(c), quoteId(c))));
  r.post('/:id/comments', async (c) => {
    const result = await service.comment(ctxOf(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  return r;
}
