import { Hono } from 'hono';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import type { SupportService } from './service.js';

/**
 * `/api/support/sessions` - yalnizca `platform_admin`.
 *
 *   POST /                         { apartmentId, reason (>=20), durationMinutes? (5-60, vars. 60) }
 *                                  -> oturum + `header` (istekte `X-Support-Session` degeri)
 *   GET  /?apartmentId=            o apartmandaki destek oturumlari (en yeni once)
 *   POST /:apartmentId/:sessionId/end   oturumu erken bitirir
 *
 * Oturum acma/bitirme ve oturum icindeki her istek apartmanin denetim zincirine yazilir.
 */
export function supportRoutes({ authenticate, service }: { authenticate: Authenticator; service: SupportService }) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));
  // Destek oturumu ile (observer olarak) yeni oturum acilamaz: rol kontrolu orijinal claim'de.
  r.use('*', requireRole(['platform_admin']));

  r.post('/', async (c) => c.json(await service.start(c.get('claims'), await readJson(c)), 201));
  r.get('/', async (c) => c.json({ items: await service.list(c.req.query('apartmentId') ?? '') }));
  r.post('/:apartmentId/:sessionId/end', async (c) =>
    c.json(await service.end(c.get('claims'), c.req.param('apartmentId'), c.req.param('sessionId'))),
  );
  return r;
}
