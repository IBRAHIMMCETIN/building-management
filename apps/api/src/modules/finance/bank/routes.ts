import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../../http/helpers.js';
import { BankError } from './errors.js';
import type { BankContext, BankService } from './service.js';

/**
 * Yazma: yalnizca yonetici rolleri. Okuma: yonetici + denetci. `platform_admin` apartman verisini
 * yalnizca destek oturumuyla (sunucu tarafinda `observer` rolune indirgenmis, salt okunur) gorur.
 */
const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type BankRoutesDeps = { authenticate: Authenticator; service: BankService };

/**
 * `/api/bank` - Faz B1: banka ekstresi aktarimi.
 *   GET  /templates                       hazir sutun esleme sablonlari
 *   POST /statements/upload-url           { bankAccountId, fileName, contentType, size } -> imzali PUT
 *   POST /statements                      { statementId, bankAccountId, fileName, format? } -> onizleme
 *   POST /statements/:statementId/commit  { expectedVersion, acknowledgeWarnings? } -> satirlari yazar
 *   GET  /statements?bankAccountId=       ekstre gecmisi (en yeni once)
 *   GET  /statements/:statementId
 *   GET  /lines?bankAccountId=&status=&from=&to=&statementId=&order=&limit=&cursor=
 *   GET  /formats/:bankAccountId          hesaba kayitli sutun eslemesi
 *   PUT  /formats/:bankAccountId          { format, expectedVersion? } (surum kosullu, denetlenir)
 */
export function bankRoutes({ authenticate, service }: BankRoutesDeps) {
  const r = new Hono<Env>();
  r.onError((err, c) => {
    if (err instanceof BankError) {
      if (err.httpStatus >= 500) console.error(err);
      return c.json({ error: err.code, message: err.message, ...(err.details ?? {}) }, err.httpStatus);
    }
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

  const ctx = (c: Context<Env>): BankContext => {
    const { apartmentId, userId, role } = c.get('claims');
    return { apartmentId: apartmentId as string, userId, role };
  };

  r.get('/templates', requireRole(READ_ROLES), (c) => c.json(service.templates()));

  r.post('/statements/upload-url', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.createUploadUrl(ctx(c), await readJson(c)), 201),
  );
  r.post('/statements', requireRole(WRITE_ROLES), async (c) => c.json(await service.preview(ctx(c), await readJson(c))));
  r.post('/statements/:statementId/commit', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.commit(ctx(c), c.req.param('statementId'), await readJson(c))),
  );
  r.get('/statements', requireRole(READ_ROLES), async (c) =>
    c.json(await service.listStatements(ctx(c), { bankAccountId: c.req.query('bankAccountId') })),
  );
  r.get('/statements/:statementId', requireRole(READ_ROLES), async (c) => c.json(await service.getStatement(ctx(c), c.req.param('statementId'))));

  r.get('/lines', requireRole(READ_ROLES), async (c) => {
    const q = c.req.query();
    return c.json(
      await service.listLines(ctx(c), {
        bankAccountId: q.bankAccountId,
        status: q.status,
        from: q.from,
        to: q.to,
        statementId: q.statementId,
        order: q.order,
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  });

  r.get('/formats/:bankAccountId', requireRole(READ_ROLES), async (c) => c.json(await service.getFormat(ctx(c), c.req.param('bankAccountId'))));
  r.put('/formats/:bankAccountId', requireRole(WRITE_ROLES), async (c) =>
    c.json(await service.putFormat(ctx(c), c.req.param('bankAccountId'), await readJson(c))),
  );

  return r;
}
