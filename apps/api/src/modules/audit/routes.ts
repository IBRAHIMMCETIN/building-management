import { randomUUID } from 'node:crypto';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import type { AuthClaims, Authenticator, Role } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError } from '../../http/helpers.js';
import { ValidationError } from '../core/validation.js';
import { maskIp, runWithRequestContext, truncateUserAgent } from './context.js';
import { type AuditEntry, PLATFORM_SCOPE, auditScope } from './log.js';
import { type AuditReader, type CheckpointStore, createAuditReader, createDynamoCheckpointStore, readIntegrity } from './repository.js';

/** Denetim gunlugunu okuyabilen roller (yalnizca kendi apartmani; platform: destek oturumuyla). */
export const AUDIT_READ_ROLES: readonly Role[] = ['apartment_manager', 'management_company', 'observer'];

/**
 * Okunacak zincir. `?scope=platform` yalnizca dogrudan `platform_admin` icindir (destek
 * oturumu salt okunur denetci olarak YALNIZCA o apartmanin zincirini gorur). Diger tum
 * durumlarda kapsam JWT'deki apartmandir; baska apartman sorgulanamaz.
 */
function resolveScope(c: Context<Env>): { scope: string } | { error: Response } {
  const claims: AuthClaims = c.get('claims');
  const requested = c.req.query('scope');
  if (requested !== undefined && requested !== 'apartment' && requested !== 'platform') {
    throw new ValidationError('scope apartment veya platform olmali', 'scope');
  }
  if (requested === 'platform') {
    if (claims.role !== 'platform_admin' || claims.supportSessionId) {
      return { error: c.json({ error: 'forbidden', message: 'Platform zincirini yalnizca platform yoneticisi gorebilir' }, 403) };
    }
    return { scope: PLATFORM_SCOPE };
  }
  if (!AUDIT_READ_ROLES.includes(claims.role)) {
    return { error: c.json({ error: 'forbidden', message: 'Bu islem icin yetkiniz yok' }, 403) };
  }
  if (!claims.apartmentId) return { error: c.json({ error: 'forbidden', message: 'Apartman baglami gerekli' }, 403) };
  return { scope: auditScope(claims.apartmentId) };
}

const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const ACTION = /^[a-z_]+(\.[a-z_+]+)*\.?$/;
const ACTOR = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Istemciye: yalnizca indeks alanlari (hash'e girmez) gizlenir. Hash'e giren tum alanlar
 * (PK, SK, ttl, entityType dahil) kalir; arayuz her kaydin SHA-256'sini tarayicida yeniden
 * hesaplayip zincir bagini dogrulayabilsin. PK yalnizca istegin kendi kapsamidir.
 */
export function auditView(e: AuditEntry) {
  const { GSI1PK: _g1, GSI1SK: _g2, ...rest } = e;
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
 *   ?limit=1-100 (vars. 50) &from=&to= (ISO) &action=<on ek> &actorId= &cursor= &scope=apartment|platform
 * `GET /api/audit/integrity?scope=` - gecelik zincir dogrulamasinin durumu (kontrol noktasi).
 */
export function auditRoutes({
  authenticate,
  reader = createAuditReader(),
  checkpoints = createDynamoCheckpointStore(),
  now = () => new Date(),
}: {
  authenticate: Authenticator;
  reader?: AuditReader;
  checkpoints?: Pick<CheckpointStore, 'get'>;
  now?: () => Date;
}) {
  const r = new Hono<Env>();
  r.onError(handleError);
  r.use('*', authenticateWith(authenticate));

  r.get('/integrity', async (c) => {
    const resolved = resolveScope(c);
    if ('error' in resolved) return resolved.error;
    c.header('cache-control', 'no-store');
    return c.json(await readIntegrity(resolved.scope, { reader, checkpoints, now }));
  });

  r.get('/', async (c) => {
    const resolved = resolveScope(c);
    if ('error' in resolved) return resolved.error;
    const q = c.req.query();
    const limit = q.limit === undefined ? 50 : Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ValidationError('limit 1-100 arasinda olmali', 'limit');
    if (q.action !== undefined && !ACTION.test(q.action)) throw new ValidationError('Gecersiz action', 'action');
    if (q.actorId !== undefined && !ACTOR.test(q.actorId)) throw new ValidationError('Gecersiz actorId', 'actorId');
    const page = await reader.list(resolved.scope, {
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
