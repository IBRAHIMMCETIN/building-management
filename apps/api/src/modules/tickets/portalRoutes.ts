import { type Context, Hono } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { ValidationError } from '../core/validation.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { TicketContext, TicketService } from './service.js';

/** Sakinin portalda yapabilecegi gecisler (diger gecisler yonetim / gorevli ekranindadir). */
const RESIDENT_ACTIONS = new Set(['confirm', 'reopen', 'cancel']);

export type TicketPortalRoutesDeps = { authenticate: Authenticator; service: TicketService };

/**
 * `/api/portal/tickets` - Faz 3 (O1-2) sakin portali: ariza / talep bildirimi ve takibi.
 * Kimlik ve daireler JWT + guncel uyelik kayitlarindan; yalnizca herkese acik olaylar doner.
 *
 *   GET   /                      ?status=   acti(g)im + dairemin talepleri
 *   GET   /similar               ?category=&blockId=   ortak alanda benzer acik talep uyarisi
 *   POST  /                      { idempotencyKey, title, description, category, location, photos? }
 *   POST  /photos/upload-url     { contentType, size }
 *   GET   /:id                   talep + herkese acik zaman cizelgesi
 *   POST  /:id/comments          { body, photos? }
 *   POST  /:id/confirm           { version, rating?, note? }
 *   POST  /:id/reopen            { version, note }
 *   POST  /:id/cancel            { version }
 *   GET   /:id/photos/:photoId
 */
export function ticketPortalRoutes({ authenticate, service }: TicketPortalRoutesDeps) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['resident']));
  r.use('*', async (c, next) => {
    if (!c.get('claims').apartmentId) return c.json({ error: 'forbidden', message: 'Aktif apartman baglami gerekli' }, 403);
    await next();
  });

  const ctx = (c: Context<Env>): TicketContext => {
    const claims = c.get('claims');
    return { apartmentId: claims.apartmentId as string, userId: claims.userId, role: claims.role };
  };
  const id = (c: Context<Env>) => c.req.param('id') ?? '';

  r.get('/', async (c) => c.json(await service.list(ctx(c), { status: c.req.query('status'), cursor: c.req.query('cursor'), limit: c.req.query('limit') })));
  r.get('/similar', async (c) => c.json(await service.similar(ctx(c), { category: c.req.query('category'), blockId: c.req.query('blockId') })));
  r.post('/', async (c) => {
    const result = await service.create(ctx(c), await readJson(c));
    return c.json(result, result.replayed ? 200 : 201);
  });
  r.post('/photos/upload-url', async (c) => c.json(await service.photoUploadUrl(ctx(c), await readJson(c))));
  r.get('/:id', async (c) => c.json(await service.get(ctx(c), id(c))));
  r.post('/:id/comments', async (c) => {
    const body = (await readJson(c)) as Record<string, unknown> | null;
    if (body && typeof body === 'object' && body.visibility !== undefined && body.visibility !== 'public') throw new ValidationError('Sakin yalnızca herkese açık yorum ekleyebilir', 'visibility');
    return c.json(await service.comment(ctx(c), id(c), body), 201);
  });
  r.post('/:id/:action', async (c) => {
    const action = c.req.param('action');
    if (!RESIDENT_ACTIONS.has(action)) return c.json({ error: 'not_found', message: 'Bilinmeyen işlem' }, 404);
    const body = (await readJson(c)) as Record<string, unknown>;
    return c.json(await service.transition(ctx(c), id(c), { ...(body && typeof body === 'object' ? body : {}), action }));
  });
  r.get('/:id/photos/:photoId', async (c) => c.json(await service.photo(ctx(c), id(c), c.req.param('photoId') ?? '')));

  return r;
}
