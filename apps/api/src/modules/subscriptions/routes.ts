import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { SubscriptionService } from './service.js';

export type SubscriptionRoutesDeps = { authenticate: Authenticator; service: SubscriptionService };

/** Banner / salt okunur bildirimi: yonetim panelindeki tum apartman rolleri. */
const STATUS_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer', 'building_staff', 'security_guard'];
/** Plan, kullanim ve faturalar: yonetim (+ denetci / destek oturumu salt okur). */
const DETAIL_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

const noStore: MiddlewareHandler<Env> = async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
};

/**
 * Aktif apartmanin aboneligi (`/api/subscription`; apartman YALNIZCA JWT'den):
 *   GET /status                       { status, legacy, readOnly, trialEndsAt?, daysLeft?, pastDueSince?, suspendOn?, suspendedAt? }
 *   GET /                             + plan, donem, ozellikler, limitler, kullanim, faturalar
 *   GET /invoices/:invoiceId/pdf      5 dk imzali link
 */
export function subscriptionRoutes({ authenticate, service }: SubscriptionRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  r.use('*', noStore);
  const apt = (c: Context<Env>) => c.get('claims').apartmentId as string;

  r.get('/status', requireRole(STATUS_ROLES), async (c) => c.json(await service.statusView(apt(c))));
  r.get('/', requireRole(DETAIL_ROLES), async (c) => c.json(await service.managerView(apt(c))));
  r.get('/invoices/:invoiceId/pdf', requireRole(DETAIL_ROLES), async (c) => c.json(await service.invoicePdf(apt(c), c.req.param('invoiceId'))));
  return r;
}

/**
 * Platform (`/api/admin/billing`, yalnizca dogrudan `platform_admin`; destek oturumu kullanamaz):
 *   GET    /plans                                  plan katalogu
 *   POST   /plans                                  { idempotencyKey, code, name, description?, pricing, features, limits, trialDays? }
 *   POST   /plans/seed                             ornek (yer tutucu) planlari ekle
 *   GET    /plans/:code                            plan + surum gecmisi
 *   PUT    /plans/:code                            { version, reason, ...icerik } -> yeni surum
 *   POST   /plans/:code/status                     { version, status: active|archived, reason }
 *   GET    /subscriptions?status=                  tum apartmanlar (aboneligi olmayan: legacy)
 *   GET    /subscriptions/:apartmentId             abonelik + kullanim + faturalar
 *   POST   /subscriptions/:apartmentId             { idempotencyKey, planCode, billingPeriod?, trialDays?, graceDays?, paymentTermDays?, reason? }
 *   POST   /subscriptions/:apartmentId/plan        { version, planCode, billingPeriod?, reason }
 *   POST   /subscriptions/:apartmentId/status      { version, action: extend_trial|activate|suspend|cancel|reactivate, reason, trialEndsAt? }
 *   POST   /subscriptions/:apartmentId/sync        gunluk adimi simdi calistir (idempotent)
 *   GET    /invoices?status=&apartmentId=&cursor=&limit=
 *   POST   /invoices/:apartmentId/:invoiceId/paid  { version, method, reference, paidOn?, note? }
 *   POST   /invoices/:apartmentId/:invoiceId/void  { version, reason }
 *   GET    /invoices/:apartmentId/:invoiceId/pdf
 */
export function platformBillingRoutes({ authenticate, service }: SubscriptionRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['platform_admin']));
  r.use('*', async (c, next) => {
    if (c.get('claims').supportSessionId) return c.json({ error: 'forbidden', message: 'Destek oturumunda platform ayarlari kullanilamaz' }, 403);
    await next();
  });
  r.use('*', noStore);
  const ctx = (c: Context<Env>) => ({ userId: c.get('claims').userId });
  const p = (c: Context<Env>, name: string) => c.req.param(name) ?? '';

  r.get('/plans', async (c) => c.json({ items: await service.listPlans() }));
  r.post('/plans', async (c) => {
    const out = await service.createPlan(ctx(c), await readJson(c));
    return c.json(out, out.created ? 201 : 200);
  });
  r.post('/plans/seed', async (c) => c.json(await service.seedPlaceholderPlans(ctx(c))));
  r.get('/plans/:code', async (c) => c.json(await service.getPlan(p(c, 'code'))));
  r.put('/plans/:code', async (c) => c.json(await service.updatePlan(ctx(c), p(c, 'code'), await readJson(c))));
  r.post('/plans/:code/status', async (c) => c.json(await service.setPlanStatus(ctx(c), p(c, 'code'), await readJson(c))));

  r.get('/subscriptions', async (c) => c.json(await service.listSubscriptions({ ...(c.req.query('status') ? { status: c.req.query('status') } : {}) })));
  r.get('/subscriptions/:apartmentId', async (c) => c.json(await service.subscriptionDetail(p(c, 'apartmentId'))));
  r.post('/subscriptions/:apartmentId', async (c) => {
    const out = await service.startSubscription(ctx(c), p(c, 'apartmentId'), await readJson(c));
    return c.json(out, out.created ? 201 : 200);
  });
  r.post('/subscriptions/:apartmentId/plan', async (c) => c.json(await service.changePlan(ctx(c), p(c, 'apartmentId'), await readJson(c))));
  r.post('/subscriptions/:apartmentId/status', async (c) => c.json(await service.changeStatus(ctx(c), p(c, 'apartmentId'), await readJson(c))));
  r.post('/subscriptions/:apartmentId/sync', async (c) => c.json(await service.runDaily(p(c, 'apartmentId'), undefined, ctx(c).userId)));

  r.get('/invoices', async (c) => {
    const limit = Number(c.req.query('limit') ?? '50');
    return c.json(
      await service.listAllInvoices({
        ...(c.req.query('status') ? { status: c.req.query('status') } : {}),
        ...(c.req.query('apartmentId') ? { apartmentId: c.req.query('apartmentId') } : {}),
        ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}),
        limit: Number.isFinite(limit) ? limit : 50,
      }),
    );
  });
  r.post('/invoices/:apartmentId/:invoiceId/paid', async (c) => c.json(await service.markPaid(ctx(c), p(c, 'apartmentId'), p(c, 'invoiceId'), await readJson(c))));
  r.post('/invoices/:apartmentId/:invoiceId/void', async (c) => c.json(await service.voidInvoice(ctx(c), p(c, 'apartmentId'), p(c, 'invoiceId'), await readJson(c))));
  r.get('/invoices/:apartmentId/:invoiceId/pdf', async (c) => c.json(await service.invoicePdf(p(c, 'apartmentId'), p(c, 'invoiceId'))));
  return r;
}
