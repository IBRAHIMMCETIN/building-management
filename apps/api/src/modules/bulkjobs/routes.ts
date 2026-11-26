import { type Context, Hono } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, requireRole } from '../../http/helpers.js';
import { assertId } from '../core/validation.js';
import { type BulkJobContext, type BulkJobService, jobView } from './service.js';

const READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];
const WRITE_ROLES: readonly Role[] = ['apartment_manager', 'management_company'];

/**
 * Arka plan toplu islerinin durumu (ilerleme cubugu icin hafif sorgu):
 *   GET  /api/jobs/:jobId         durum, islenen / toplam, yuzde, hatali bolum ornekleri, sonuc
 *   POST /api/jobs/:jobId/retry   basarisiz / hatali biten isi yeniden baslatir (idempotent)
 * Tenant izolasyonu: is yalnizca JWT'deki apartmanda aranir.
 */
export function bulkJobRoutes({ authenticate, service }: { authenticate: Authenticator; service: BulkJobService }) {
  const r = new Hono<Env>();
  r.use('*', authenticateWith(authenticate));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });
  r.onError(handleError);

  const ctx = (c: Context<Env>): BulkJobContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };
  const id = (c: Context<Env>) => assertId(c.req.param('jobId'), 'jobId');

  r.get('/:jobId', requireRole(READ_ROLES), async (c) => {
    c.header('cache-control', 'no-store');
    return c.json(jobView(await service.get(ctx(c), id(c))));
  });
  r.post('/:jobId/retry', requireRole(WRITE_ROLES), async (c) => c.json(jobView(await service.retry(ctx(c), id(c))), 202));
  return r;
}
