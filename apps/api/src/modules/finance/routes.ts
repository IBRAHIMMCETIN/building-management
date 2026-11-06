import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, publicView, readJson, requireRole } from '../../http/helpers.js';
import type { FinanceContext, FinanceService } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

export type FinanceRoutesDeps = { authenticate: Authenticator; service: FinanceService };

/**
 * Tenant izolasyonu: `apartmentId` YALNIZCA JWT claim'inden gelir; URL/govde ile
 * degistirilemez. Claim'de apartmentId yoksa (ornegin apartman secilmemis) 403 doner.
 */
export function financeRoutes({ authenticate, service }: FinanceRoutesDeps) {
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

  r.get('/balance/:unitId', requireRole(READ_ROLES), async (c) => {
    return c.json(await service.getUnitBalance(ctx(c), c.req.param('unitId')));
  });

  return r;
}

