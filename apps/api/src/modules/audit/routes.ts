import { randomUUID } from 'node:crypto';
import { Hono, type MiddlewareHandler } from 'hono';
import type { Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, requireRole } from '../../http/helpers.js';
import { ValidationError } from '../core/validation.js';
import { maskIp, runWithRequestContext, truncateUserAgent } from './context.js';
import { type AuditEntry, auditScope } from './log.js';
import { type AuditReader, createAuditReader } from './repository.js';

/** Denetim gunlugunu okuyabilen roller (yalnizca kendi apartmani; platform: destek oturumuyla). */
export const AUDIT_READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ACTION = /^[a-z_]+(\.[a-z_+]+)*\.?$/;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;

/** Istemciye: tablo anahtarlari ve indeks alanlari gizlenir; zincir alanlari (dogrulama icin) kalir. */
export function auditView(e: AuditEntry) {
  const { PK: _pk, SK: _sk, GSI1PK: _g1, GSI1SK: _g2, ttl: _ttl, entityType: _et, ...rest } = e;
  return rest;
}

function parseDateTime(value: string | undefined, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!ISO_DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
    throw new ValidationError(`${field} saat dilimli ISO tarih-saat olmali`, field);
  }
  return new Date(value).toISOString();
}

/**
 * `GET /api/audit` - salt okunur, sayfali (en yeni once).
 *   ?limit=1-100 (vars. 50) &from=&to= (ISO) &action=<on ek> &actorId= &cursor=
 * Kapsam her zaman JWT'deki apartmandir; baska apartman sorgulanamaz.
 */
export function auditRoutes({ authenticate, reader = createAuditReader() }: { authenticate: Authenticator; reader?: AuditReader }) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));

  r.get('/', requireRole(AUDIT_READ_ROLES), async (c) => {
    const claims = c.get('claims');
    if (!claims.apartmentId) return c.json({ error: 'forbidden', message: 'Apartman baglami gerekli' }, 403);
    const q = c.req.query();
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit 1-100 arasinda olmali', 'limit');
    if (q.action !== undefined && !ACTION.test(q.action)) throw new ValidationError('Gecersiz action', 'action');
    if (q.actorId !== undefined && !ACTOR.test(q.actorId)) throw new ValidationError('Gecersiz actorId', 'actorId');
    const page = await reader.list(auditScope(claims.apartmentId), {
      limit,
      cursor: q.cursor,
      from: parseDateTime(q.from, 'from'),
      to: parseDateTime(q.to, 'to'),
      action: q.action,
      actorId: q.actorId,
    });
    c.header('cache-control', 'no-store');
    return c.json({ items: page.items.map(auditView), ...(page.cursor ? { cursor: page.cursor } : {}) });
  });

  return r;
}

type LambdaEnv = { event?: { requestContext?: { requestId?: string; http?: { sourceIp?: string; userAgent?: string } } } };

/**
 * Her istegi denetim baglamiyla sarar: requestId (API Gateway veya `x-request-id`), kisaltilmis
 * IP (/24, /48) ve kisaltilmis User-Agent. Aktor, kimlik dogrulamasindan sonra eklenir.
 */
export function requestContext(): MiddlewareHandler {
  return async (c, next) => {
    const rc = (c.env as LambdaEnv | undefined)?.event?.requestContext;
    const requestId = rc?.requestId ?? c.req.header('x-request-id') ?? randomUUID();
    const ip = maskIp(rc?.http?.sourceIp ?? c.req.header('x-forwarded-for'));
    const userAgent = truncateUserAgent(rc?.http?.userAgent ?? c.req.header('user-agent'));
    await runWithRequestContext({ requestId, ...(ip ? { ip } : {}), ...(userAgent ? { userAgent } : {}) }, () => next());
  };
}
