import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { ResidentsError } from '../residents/service.js';
import { ImportError, type ImportsContext, type ImportsService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type ImportRoutesDeps = { authenticate: Authenticator; service: ImportsService };

/**
 * `/api/imports` - Excel/CSV toplu aktarim (web dosyayi okur, satirlari METIN olarak gonderir).
 *   POST /preview                { asOfDate, units[], people[], balances[] }  yazmaz, dogrular
 *   POST /                       { importId, asOfDate, fileName, totals }     aktarimi baslatir
 *   POST /:importId/rows         { units? | people? | balances? } (<= 25 satir; idempotent)
 *   POST /:importId/funds        { cash?, bank? }  kasa/banka devir bakiyesi
 *   POST /:importId/complete
 *   POST /:importId/invitations  bekleyen davet e-postalarini gonderir (parca parca; `remaining`)
 *   POST /:importId/rollback     { reason? } geri alir (parca parca; `remaining`)
 *   GET  /, /:importId           gecmis ve ayrinti (denetci okuyabilir)
 */
export function importRoutes({ authenticate, service }: ImportRoutesDeps) {
  const r = new Hono<Env>();
  r.onError((err, c) => {
    if (err instanceof ImportError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
    if (err instanceof ResidentsError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
    return handleError(err, c);
  });
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
    c.header('Cache-Control', 'no-store');
  });

  const ctx = (c: Context<Env>): ImportsContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };
  const id = (c: Context<Env>) => c.req.param('importId') ?? '';

  r.get('/', requireRole(READ_ROLES), async (c) => c.json({ items: await service.list(ctx(c)) }));
  r.post('/preview', requireRole(WRITE_ROLES), async (c) => c.json(await service.preview(ctx(c), await readJson(c))));
  r.post('/', requireRole(WRITE_ROLES), async (c) => c.json(await service.start(ctx(c), await readJson(c)), 201));
  r.get('/:importId', requireRole(READ_ROLES), async (c) => c.json(await service.get(ctx(c), id(c))));
  r.post('/:importId/rows', requireRole(WRITE_ROLES), async (c) => c.json(await service.processRows(ctx(c), id(c), await readJson(c))));
  r.post('/:importId/funds', requireRole(WRITE_ROLES), async (c) => c.json(await service.setFunds(ctx(c), id(c), await readJson(c))));
  r.post('/:importId/complete', requireRole(WRITE_ROLES), async (c) => c.json(await service.complete(ctx(c), id(c))));
  r.post('/:importId/invitations', requireRole(WRITE_ROLES), async (c) => c.json(await service.sendInvitations(ctx(c), id(c))));
  r.post('/:importId/rollback', requireRole(WRITE_ROLES), async (c) => {
    const body = c.req.header('content-length') === '0' ? {} : await readJson(c).catch(() => ({}));
    return c.json(await service.rollback(ctx(c), id(c), body));
  });

  return r;
}
