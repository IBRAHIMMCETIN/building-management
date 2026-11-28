import { type Context, Hono } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { OffsetService } from '../finance/offsets.js';
import type { PlanService } from '../finance/plans.js';
import type { PlanRequestService } from '../finance/planRequests.js';
import { PORTAL_ROLES, type PortalContext, type PortalService } from './service.js';
import { type SiteFeatureReader, requireFeature } from '../features/guard.js';
import type { ExpenseBreakdown } from './expenseBreakdown.js';

export type PortalRoutesDeps = {
  authenticate: Authenticator;
  service: PortalService;
  /** Faz B2: apartman IBAN'i + alt cari odeme referans kodu (banka modulu). */
  paymentReference?: (ctx: PortalContext, unitId?: string) => Promise<Record<string, unknown>>;
  /** Finans 2.2: avans mahsubu talepleri. */
  offsets?: Pick<OffsetService, 'portalOptions' | 'createRequest' | 'myRequests'>;
  /** Finans 2.2: aktif taksit planlari. */
  plans?: Pick<PlanService, 'portalPlans'>;
  /** Adim 1: site ozellik anahtarlari (verilmezse kontrol yok). */
  features?: SiteFeatureReader;
  /** Adim 3: aylik gider dagilimi (sitenin toplam giderleri; kisi / tedarikci adi yok). */
  expenseBreakdown?: (ctx: PortalContext, month?: string) => Promise<ExpenseBreakdown>;
  /** Finans 2.2 sonrasi: sakin yapilandirma (taksit) talebi. */
  planRequests?: Pick<PlanRequestService, 'portalOptions' | 'myRequests' | 'createRequest' | 'withdraw'>;
};

/**
 * Sakin portali: `/api/portal/*` (salt okunur).
 *   GET /my-unit, /my-summary, /my-statement?from&to, /my-dues, /my-receipts, /announcements,
 *       /my-payment-reference (Faz B2: IBAN + odeme referans kodu)
 *       /my-plans (Finans 2.2: taksit planlari), /offset-options, /offset-requests
 *   POST /offset-requests (Finans 2.2: avans mahsubu talebi; yonetici onaylar/reddeder)
 *   GET  /plan-requests/options, /plan-requests; POST /plan-requests, /plan-requests/:id/withdraw
 *        (yapilandirma talebi; `resident.restructure` kapaliysa 403)
 *   (hepsi opsiyonel `?unitId=`; birden fazla dairesi olan sakin icin zorunlu)
 *
 *  - Rol: yalnizca `resident` (JWT `role` claim'i). Yonetici/denetci kendi modullerini kullanir.
 *  - Apartman: yalnizca JWT `apartmentId` claim'i; URL/govdeden apartman kabul edilmez.
 *  - Daire: `?unitId=` opsiyoneldir ve servis katmaninda kullanicinin AKTIF uyelikleriyle
 *    eslestirilir; eslesmezse 403. Tek dairesi olan sakin parametre gondermez.
 *  - Kisisel finansal veri: yanitlar onbelleklenmez (`Cache-Control: no-store`).
 */
export function portalRoutes({ authenticate, service, paymentReference, offsets, plans, features, expenseBreakdown, planRequests }: PortalRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);

  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(PORTAL_ROLES));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): PortalContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const unitId = (c: Context<Env>) => c.req.query('unitId');

  r.get('/my-unit', async (c) => c.json(await service.getMyUnit(ctx(c), unitId(c))));

  r.get('/my-summary', async (c) => c.json(await service.getMySummary(ctx(c), unitId(c))));

  r.get('/my-dues', async (c) => c.json(await service.getMyDues(ctx(c), unitId(c))));

  r.get('/my-statement', async (c) =>
    c.json(
      await service.getMyStatement(ctx(c), {
        unitId: unitId(c),
        from: c.req.query('from'),
        to: c.req.query('to'),
      }),
    ),
  );

  r.get('/my-receipts', async (c) => c.json(await service.getMyReceipts(ctx(c), unitId(c))));

  r.get('/announcements', async (c) => c.json(await service.getAnnouncements(ctx(c), unitId(c))));

  // Havale/EFT: apartmanin tahsilat IBAN'i ve sakinin alt cari referans kodu (yoksa olusturulur).
  if (paymentReference) {
    r.get('/my-payment-reference', async (c) => c.json(await paymentReference(ctx(c), unitId(c))));
  }

  // Adim 3: `resident.expenseChart` kapaliysa 403 feature_disabled. Yanit site geneli toplamdir
  // (sade kategori adlari, ikon anahtari, kurus ve yuzde); kisi, tedarikci veya hesap adi donmez.
  if (expenseBreakdown) {
    r.get('/expense-breakdown', requireFeature(features, 'resident.expenseChart'), async (c) => c.json(await expenseBreakdown(ctx(c), c.req.query('month'))));
  }

  if (plans) {
    r.get('/my-plans', requireFeature(features, 'resident.restructure'), async (c) => c.json(await plans.portalPlans(ctx(c), unitId(c))));
  }

  if (planRequests) {
    const gate = requireFeature(features, 'resident.restructure');
    r.use('/plan-requests', gate);
    r.use('/plan-requests/*', gate);
    r.get('/plan-requests/options', async (c) => c.json(await planRequests.portalOptions(ctx(c), unitId(c))));
    r.get('/plan-requests', async (c) => c.json(await planRequests.myRequests(ctx(c))));
    r.post('/plan-requests', async (c) => {
      const result = await planRequests.createRequest(ctx(c), await readJson(c));
      return c.json(result, result.replayed ? 200 : 201);
    });
    r.post('/plan-requests/:requestId/withdraw', async (c) => c.json({ request: await planRequests.withdraw(ctx(c), c.req.param('requestId'), await readJson(c).catch(() => ({}))) }));
  }

  if (offsets) {
    const offsetGate = requireFeature(features, 'resident.advanceOffset');
    r.use('/offset-options', offsetGate);
    r.use('/offset-requests', offsetGate);
    r.get('/offset-options', async (c) => c.json(await offsets.portalOptions(ctx(c), unitId(c))));
    r.get('/offset-requests', async (c) => c.json({ items: (await offsets.myRequests(ctx(c))).map(publicView) }));
    r.post('/offset-requests', async (c) => {
      const result = await offsets.createRequest(ctx(c), await readJson(c));
      return c.json({ replayed: result.replayed, request: publicView(result.request) }, result.replayed ? 200 : 201);
    });
  }

  return r;
}
