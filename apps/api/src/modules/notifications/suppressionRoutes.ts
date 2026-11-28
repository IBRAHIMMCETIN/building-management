import { type Context, Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { SuppressionError, type SuppressionService } from './suppressions.js';

/**
 * Platform ekibi: SES geri donus / sikayet e-posta engelleri (`/api/admin/email-suppressions`,
 * yalnizca dogrudan `platform_admin`; destek oturumu kullanamaz). Adres URL'de tasinmaz.
 *   GET   /?status=active|all&cursor=   engel listesi (maskeli adres, neden, tarih, gecici engelin bitisi)
 *   POST  /lookup                        { email } -> { emailHash, suppression | null }
 *   POST  /:emailHash/clear              { reason } -> engel kaldirildi (platform denetim zinciri)
 */
export function emailSuppressionRoutes({ authenticate, service }: { authenticate: Authenticator; service: SuppressionService }) {
  const r = new Hono<Env>();
  r.onError((err, c) => (err instanceof SuppressionError ? c.json({ error: err.code, message: err.message }, err.httpStatus as ContentfulStatusCode) : handleError(err, c)));
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['platform_admin']));
  r.use('*', async (c, next) => {
    if (c.get('claims').supportSessionId) return c.json({ error: 'forbidden', message: 'Destek oturumunda platform ayarlari kullanilamaz' }, 403);
    await next();
    c.header('Cache-Control', 'no-store');
  });
  const actor = (c: Context<Env>) => c.get('claims').userId;

  r.get('/', async (c) =>
    c.json(await service.list({ ...(c.req.query('cursor') ? { cursor: c.req.query('cursor') } : {}), ...(c.req.query('status') ? { status: c.req.query('status') } : {}) })),
  );
  r.post('/lookup', async (c) => c.json(await service.lookup(await readJson(c))));
  r.post('/:emailHash/clear', async (c) => c.json(await service.clear(actor(c), c.req.param('emailHash'), await readJson(c))));
  return r;
}
