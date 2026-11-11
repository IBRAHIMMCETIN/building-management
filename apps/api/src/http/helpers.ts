import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AuthClaims, Authenticator, Role } from '../auth/claims.js';
import { DataAccessError } from '../config/dynamodb.js';
import { AccessDeniedError } from './errors.js';
import { CoreError } from '../modules/core/service.js';
import { DocumentError } from '../modules/documents/errors.js';
import { FinanceError } from '../modules/finance/service.js';
import { PortalError } from '../modules/portal/service.js';
import type { TableKeys } from '../modules/core/types.js';
import { ValidationError } from '../modules/core/validation.js';

/** Modul rotalarinin ortak Hono ortami: dogrulanmis claim'ler `claims` altinda. */
export type Env = { Variables: { claims: AuthClaims } };

/** Istemciye ic DynamoDB anahtarlarini (PK/SK) gostermeyiz. */
export function publicView<T extends object>(item: T): Omit<T, 'PK' | 'SK'> {
  const { PK: _pk, SK: _sk, ...rest } = item as T & Partial<TableKeys>;
  return rest as Omit<T, 'PK' | 'SK'>;
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ValidationError('Gecersiz JSON govdesi');
  }
}

/** Kimlik dogrulanamazsa 401; basariliysa claim'leri `c.var.claims`'e koyar. */
export function authenticateWith(authenticate: Authenticator): MiddlewareHandler<Env> {
  return async (c, next) => {
    const claims = await authenticate(c);
    if (!claims) return c.json({ error: 'unauthorized' }, 401);
    c.set('claims', claims);
    await next();
  };
}

export function requireRole(roles: readonly Role[]): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!roles.includes(c.get('claims').role)) {
      return c.json({ error: 'forbidden', message: 'Bu islem icin yetkiniz yok' }, 403);
    }
    await next();
  };
}

export function handleError(err: Error, c: Context) {
  if (err instanceof ValidationError) {
    return c.json({ error: 'validation_error', message: err.message, field: err.field }, 400);
  }
  if (err instanceof CoreError) {
    return c.json({ error: err.code, message: err.message }, err.httpStatus);
  }
  if (err instanceof FinanceError) {
    return c.json({ error: err.code, message: err.message }, err.httpStatus);
  }
  if (err instanceof AccessDeniedError) {
    return c.json({ error: 'forbidden', message: err.message }, 403);
  }
  if (err instanceof PortalError) {
    return c.json({ error: err.code, message: err.message, ...err.details }, err.httpStatus);
  }
  if (err instanceof DocumentError) {
    if (err.httpStatus >= 500) console.error(err);
    return c.json({ error: err.code, message: err.message }, err.httpStatus);
  }
  if (err instanceof DataAccessError) {
    if (err.httpStatus >= 500) console.error(err);
    return c.json({ error: err.code, message: err.message }, err.httpStatus as ContentfulStatusCode);
  }
  console.error(err);
  return c.json({ error: 'internal_error' }, 500);
}
