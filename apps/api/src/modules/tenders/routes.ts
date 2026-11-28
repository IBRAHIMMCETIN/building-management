import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { type SiteFeatureReader, featureAllowed, featureDisabledBody, requireFeature } from '../features/guard.js';
import { TenderError } from './errors.js';
import type { TenderContext, TenderService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

/** `features`: site ozellik anahtari `admin.tenders` kapaliysa tum uclar 403 `feature_disabled` (verilmezse kontrol yok). */
export type TenderRoutesDeps = { authenticate: Authenticator; service: TenderService; features?: SiteFeatureReader };

/** Modul hatasi + ortak hata eslemesi (paylasilan `handleError`'a dokunmadan). */
function onError(err: Error, c: Context) {
  if (err instanceof TenderError) return c.json({ error: err.code, message: err.message, ...err.details }, err.httpStatus);
  return handleError(err, c);
}

function base(authenticate: Authenticator, features?: SiteFeatureReader) {
  const r = new Hono<Env>();
  r.onError(onError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
    // Imzali belge linkleri ve teklif bilgisi onbelleklenmez.
    c.header('Cache-Control', 'no-store');
  });
  r.use('*', requireFeature(features, 'admin.tenders'));
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
 *   GET   /assembly-decisions                ayni apartmanin guncel genel kurul kararlari (karar baglantisi secicisi)
 *   POST  /:id/decide                        { version, quoteId, reason, reference?, assemblyDecision?: { assemblyId, itemId } }
 *   POST  /:id/assembly-decision             { version, assemblyDecision: { assemblyId, itemId } | null }  karar bagi
 *   GET   /:id/supplier-accounts             eslestirme icin Finans tedarikci hesaplari (firma adina benzeyenler once)
 *   POST  /:id/supplier                      { version, accountId | null }  kazanan firma -> tedarikci hesabi
 *   POST  /:id/comments/:commentId/hide      { reason }  sakin sorusunu gizle (moderasyon; `tender.comment_hide`)
 *   POST  /:id/cancel                        { version, reason }
 *   POST  /:id/quotes                        { idempotencyKey, supplierName, amountKurus, vatIncluded, vatRate, validUntil?,
 *                                              deliveryDays?, warrantyMonths?, notes?, document?: { uploadId, fileName } }
 *   PATCH /:id/quotes/:quoteId               { version, ...teklif alanlari, document? }
 *   POST  /:id/quotes/:quoteId/withdraw      { version, reason }
 *   GET   /:id/quotes/:quoteId/document      ?history=<sira>  5 dk imzali link (denetci: yalnizca yayinlanmis ihale;
 *                                              `history`: degistirilmis onceki belge, yalnizca yonetim)
 *   POST  /:id/comments                      { idempotencyKey, body, replyTo? }   yonetim yaniti (yalnizca yayinda; `tender.comment`
 *                                              denetimi; `replyTo`: belirli soruya yanit, bildirim yalnizca o sorunun yazarina)
 *   POST  /:id/expense                       { idempotencyKey, expenseAccountId?, creditAccountId?, amount?, date?, description?,
 *                                              supplier?, invoiceNumber?, invoiceUpload?, overrunReason? }  karardan Finans gideri /
 *                                              hakedis (Finans gider servisiyle; birden fazla, gecerli toplam karar tutarini asarsa
 *                                              gerekce zorunlu; tekrar ayni sonuc; `ledger.expense` denetimi)
 * Belge yukleme: `POST /api/documents/invoice-uploads` (gider faturasiyla ayni sinirlar).
 */
export function tenderRoutes({ authenticate, service, features }: TenderRoutesDeps) {
  const r = base(authenticate, features);
  r.get('/', requireRole(READ_ROLES), async (c) => c.json(await service.list(ctxOf(c), { status: c.req.query('status') })));
  r.post('/', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.create(ctxOf(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  // Genel kurul modulu kapaliysa karar bagi kurulamaz; secici bos doner.
  const assembliesOn = (c: Context<Env>) => featureAllowed(features, c.get('claims'), 'admin.assemblies');
  r.get('/assembly-decisions', requireRole(READ_ROLES), async (c) => c.json((await assembliesOn(c)) ? await service.assemblyDecisionOptions(ctxOf(c)) : { items: [] }));
  r.get('/:id', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctxOf(c), id(c))));
  r.post('/:id/assembly-decision', requireRole(WRITE_ROLES), async (c) => {
    const body = await readJson(c);
    if ((body as { assemblyDecision?: unknown } | null)?.assemblyDecision && !(await assembliesOn(c))) return c.json(featureDisabledBody('admin.assemblies'), 403);
    return c.json(await service.linkAssemblyDecision(ctxOf(c), id(c), body));
  });
  r.get('/:id/supplier-accounts', requireRole(WRITE_ROLES), async (c) => c.json(await service.supplierAccounts(ctxOf(c), id(c))));
  r.post('/:id/supplier', requireRole(WRITE_ROLES), async (c) => c.json(await service.linkSupplier(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/comments/:commentId/hide', requireRole(WRITE_ROLES), async (c) => c.json(await service.hideComment(ctxOf(c), id(c), c.req.param('commentId') ?? '', await readJson(c))));
  r.patch('/:id', requireRole(WRITE_ROLES), async (c) => c.json(await service.update(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/collect', requireRole(WRITE_ROLES), async (c) => c.json(await service.collect(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/publish', requireRole(WRITE_ROLES), async (c) => c.json(await service.publish(ctxOf(c), id(c), await readJson(c))));
  r.post('/:id/decide', requireRole(WRITE_ROLES), async (c) => {
    const body = await readJson(c);
    if ((body as { assemblyDecision?: unknown } | null)?.assemblyDecision && !(await assembliesOn(c))) return c.json(featureDisabledBody('admin.assemblies'), 403);
    return c.json(await service.decide(ctxOf(c), id(c), body));
  });
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
export function tenderPortalRoutes({ authenticate, service, features }: TenderRoutesDeps) {
  const r = base(authenticate, features);
  r.use('*', requireRole(['resident']));
  r.get('/', async (c) => c.json(await service.portalList(ctxOf(c))));
  r.get('/:id', async (c) => {
    const out = await service.portalGet(ctxOf(c), id(c));
    // Genel kurul modulu sitede kapaliysa karar baglantisi acilamaz (portal 403 doner): baglanti yok.
    const ad = out.tender.assemblyDecision as { portalLink?: boolean } | undefined;
    if (ad?.portalLink && !(await featureAllowed(features, c.get('claims'), 'admin.assemblies'))) ad.portalLink = false;
    return c.json(out);
  });
  r.get('/:id/quotes/:quoteId/document', async (c) => c.json(await service.portalQuoteDocument(ctxOf(c), id(c), quoteId(c))));
  r.post('/:id/comments', async (c) => {
    const result = await service.comment(ctxOf(c), id(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  return r;
}
