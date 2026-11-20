import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { CariClosure, ClosureService } from './closures.js';
import type { FinanceContext, FinanceService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type FinanceRoutesDeps = { authenticate: Authenticator; service: FinanceService; closures?: ClosureService };

/**
 * Uclar: GET /accounts, /summary, /dues-status, /transactions?from&to&limit&cursor, /balance/:unitId
 *        POST /accounts, /dues, /payments, /expenses, /transactions/:id/reversal
 * Tasinmada cari kapama:
 *        GET  /units/:unitId/closures/preview?party&moveOutDate&userIds   (yazmaz)
 *        GET  /units/:unitId/closures, /closures/:closureId
 *        POST /units/:unitId/closures, /closures/:closureId/reverse
 *
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden gelir; URL/govde ile
 * degistirilemez. Claim'de apartmentId yoksa (ornegin apartman secilmemis) 403 doner.
 */
export function financeRoutes({ authenticate, service, closures }: FinanceRoutesDeps) {
  const r = new Hono<Env>();
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) {
      return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    }
    await next();
  });
  r.onError(handleError);

  const ctx = (c: Context<Env>): FinanceContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId };
  };

  r.get('/accounts', requireRole(READ_ROLES), async (c) => {
    const accounts = await service.listAccounts(ctx(c), c.req.query('type'));
    return c.json({ items: accounts.map(publicView) });
  });
  r.post('/accounts', requireRole(WRITE_ROLES), async (c) => {
    const account = await service.createAccount(ctx(c), await readJson(c));
    return c.json(publicView(account), 201);
  });
  r.patch('/accounts/:accountId', requireRole(WRITE_ROLES), async (c) => {
    const account = await service.updateAccount(ctx(c), c.req.param('accountId'), await readJson(c));
    return c.json(publicView(account));
  });

  // Toplu tahakkuk onizlemesi (yazmaz): paylar ve gider kalemi muafiyetleri.
  r.post('/dues/preview', requireRole(WRITE_ROLES), async (c) => c.json(await service.previewBulk(ctx(c), await readJson(c))));

  r.post('/dues', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.charge(ctx(c), await readJson(c));
    if (result.mode === 'single') {
      return c.json(
        { mode: 'single', replayed: result.replayed, transaction: publicView(result.transaction) },
        result.replayed ? 200 : 201,
      );
    }
    const { mode: _mode, ...bulk } = result;
    return c.json({ mode: 'bulk', ...bulk }, result.replayed ? 200 : 201);
  });

  r.post('/payments', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.recordPayment(ctx(c), await readJson(c));
    return c.json(
      {
        replayed: result.replayed,
        payment: publicView(result.payment),
        transaction: publicView(result.transaction),
      },
      result.replayed ? 200 : 201,
    );
  });

  r.post('/expenses', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.recordExpense(ctx(c), await readJson(c));
    return c.json(
      {
        replayed: result.replayed,
        expense: publicView(result.expense),
        transaction: publicView(result.transaction),
      },
      result.replayed ? 200 : 201,
    );
  });

  r.post('/transactions/:transactionId/reversal', requireRole(WRITE_ROLES), async (c) => {
    const result = await service.reverseTransaction(ctx(c), c.req.param('transactionId'), await readJson(c));
    return c.json(
      { replayed: result.replayed, transaction: publicView(result.transaction) },
      result.replayed ? 200 : 201,
    );
  });

  // ----- Raporlar (salt okunur) -----
  r.get('/summary', requireRole(READ_ROLES), async (c) => c.json(await service.summary(ctx(c))));

  r.get('/dues-status', requireRole(READ_ROLES), async (c) => c.json(await service.duesStatus(ctx(c))));

  r.get('/transactions', requireRole(READ_ROLES), async (c) =>
    c.json(
      await service.listTransactions(ctx(c), {
        from: c.req.query('from'),
        to: c.req.query('to'),
        limit: c.req.query('limit'),
        cursor: c.req.query('cursor'),
      }),
    ),
  );

  r.get('/balance/:unitId', requireRole(READ_ROLES), async (c) => {
    return c.json(await service.getUnitBalance(ctx(c), c.req.param('unitId')));
  });

  // ----- Tasinmada cari kapama -----
  if (closures) {
    const view = (c: CariClosure) => publicView(c);
    r.get('/units/:unitId/closures/preview', requireRole(WRITE_ROLES), async (c) =>
      c.json(
        await closures.preview(ctx(c), c.req.param('unitId'), {
          party: c.req.query('party'),
          moveOutDate: c.req.query('moveOutDate'),
          userIds: c.req.query('userIds'),
        }),
      ),
    );
    r.get('/units/:unitId/closures', requireRole(READ_ROLES), async (c) =>
      c.json({ items: (await closures.listForUnit(ctx(c), c.req.param('unitId'))).map(view) }),
    );
    r.post('/units/:unitId/closures', requireRole(WRITE_ROLES), async (c) => {
      const result = await closures.create(ctx(c), c.req.param('unitId'), await readJson(c));
      return c.json({ replayed: result.replayed, closure: view(result.closure) }, result.replayed ? 200 : 201);
    });
    r.get('/closures/:closureId', requireRole(READ_ROLES), async (c) => c.json(view(await closures.get(ctx(c), c.req.param('closureId')))));
    r.post('/closures/:closureId/reverse', requireRole(WRITE_ROLES), async (c) =>
      c.json({ closure: view(await closures.reverse(ctx(c), c.req.param('closureId'), await readJson(c))) }),
    );
  }

  return r;
}

