import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Authenticator } from '../../auth/claims.js';
import { type Env, authenticateWith, handleError, readJson, requireRole } from '../../http/helpers.js';
import { DemoUnavailableError } from './ipMac.js';
import { DemoRequestNotFoundError, DemoRequestValidationError, type DemoRequestMeta, type DemoRequestService } from './service.js';
import { DemoRateLimitError } from './throttle.js';

/** Govde siniri: en uzun gecerli form ~3 KB; 16 KB ustu ayristirilmadan 413. */
export const DEMO_BODY_LIMIT_BYTES = 16 * 1024;

type LambdaEnv = { event?: { requestContext?: { http?: { sourceIp?: string } } } };

/**
 * Istemci IP'si. Lambda'da YALNIZCA API Gateway'in `sourceIp` degeri (baslik sahtelenebilir);
 * Lambda disinda (yerel sunucu, testler) `x-forwarded-for` ilk degeri. User-Agent okunmaz / saklanmaz.
 */
export function requestMeta(c: Context): DemoRequestMeta {
  const event = (c.env as LambdaEnv | undefined)?.event;
  const sourceIp = event ? event.requestContext?.http?.sourceIp : c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
  return sourceIp ? { sourceIp } : {};
}

function demoErrors(err: Error, c: Context) {
  if (err instanceof DemoRateLimitError) {
    // Retry-After CORS ile tarayiciya acik degildir: sure govdede de doner.
    c.header('Retry-After', String(err.retryAfterSeconds));
    return c.json({ error: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds }, 429);
  }
  if (err instanceof DemoRequestValidationError) {
    return c.json({ error: 'validation_error', message: err.message, ...(err.field ? { field: err.field } : {}), fields: err.fields }, 400);
  }
  if (err instanceof DemoRequestNotFoundError) return c.json({ error: err.code, message: err.message }, 404);
  if (err instanceof DemoUnavailableError) {
    console.error(JSON.stringify({ msg: 'demo_request_unavailable', cause: err.cause instanceof Error ? err.cause.name : 'config' }));
    return c.json({ error: err.code, message: err.message }, 503);
  }
  return handleError(err, c);
}

/**
 * Herkese acik uc (`/api/public/demo-requests`, API Gateway'de JWT'siz ayri rota + rota throttling'i).
 *   POST /   { fullName, email, phone?, organization, unitRange, message?, kvkkConsent: true, kvkkVersion, bmCheck? }
 *            -> 201 { received: true } | 400 validation_error | 413 | 429 rate_limited | 503
 * Bu rota hicbir sey OKUMAZ: yanit yalnizca alindi bilgisidir (kayit kimligi bile donmez).
 */
export function publicDemoRequestRoutes({ service }: { service: DemoRequestService }) {
  const r = new Hono();
  r.onError(demoErrors);
  r.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  r.post(
    '/',
    bodyLimit({
      maxSize: DEMO_BODY_LIMIT_BYTES,
      onError: (c) => c.json({ error: 'payload_too_large', message: 'İstek çok büyük' }, 413),
    }),
    async (c) => c.json(await service.create(await readJson(c), requestMeta(c)), 201),
  );
  r.all('*', (c) => c.json({ error: 'not_found' }, 404));
  return r;
}

/**
 * Platform ekibi (`/api/platform/demo-requests`, yalnizca `platform_admin`; destek oturumu haric).
 *   GET  /?limit=&cursor=          -> { items, nextCursor? }  en yeni once (yalnizca `new`)
 *   POST /:requestId/erase  { status: deleted | spam, reason }  -> { requestId, status }
 *        KVKK silme talebi / spam: kisisel alanlar kaldirilir, kayit listeden duser (platform denetim zinciri).
 */
export function platformDemoRequestRoutes({ authenticate, service }: { authenticate: Authenticator; service: DemoRequestService }) {
  const r = new Hono<Env>();
  r.onError(demoErrors);
  r.use('*', authenticateWith(authenticate));
  r.use('*', requireRole(['platform_admin']));
  r.use('*', async (c, next) => {
    if (c.get('claims').supportSessionId) return c.json({ error: 'forbidden', message: 'Destek oturumunda platform listeleri kullanilamaz' }, 403);
    await next();
    c.header('Cache-Control', 'no-store');
  });
  r.get('/', async (c) => c.json(await service.list({ limit: c.req.query('limit'), cursor: c.req.query('cursor') })));
  r.post('/:requestId/erase', async (c) => c.json(await service.erase(c.get('claims').userId, c.req.param('requestId'), await readJson(c))));
  return r;
}
