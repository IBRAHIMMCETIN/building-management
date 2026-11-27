import type { Context } from 'hono';
import { handleError } from '../../http/helpers.js';
import { GateRateLimitError } from './throttle.js';

export type GateErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'limit_reached'
  | 'plate_taken'
  | 'pass_revoked'
  | 'pass_used'
  | 'pass_expired'
  | 'pass_not_yet_valid'
  | 'pass_host_left'
  | 'already_inside'
  | 'approval_expired'
  | 'not_inside'
  | 'invalid_state'
  | 'response_expired';

const HTTP_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  limit_reached: 409,
  plate_taken: 409,
  pass_revoked: 409,
  pass_used: 409,
  pass_expired: 409,
  pass_not_yet_valid: 409,
  pass_host_left: 409,
  already_inside: 409,
  approval_expired: 409,
  not_inside: 409,
  invalid_state: 409,
  response_expired: 409,
} as const satisfies Record<GateErrorCode, number>;

/** Guvenlik kapisi hatalari; anlamli HTTP durum koduna eslenir. */
export class GateError extends Error {
  readonly httpStatus: (typeof HTTP_STATUS)[GateErrorCode];
  constructor(
    readonly code: GateErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
    this.httpStatus = HTTP_STATUS[code];
  }
}

/** Modul rotalarinin hata eslemesi: GateError burada, digerleri ortak `handleError`'da. */
export function handleGateError(err: Error, c: Context) {
  if (err instanceof GateError) return c.json({ error: err.code, message: err.message }, err.httpStatus);
  // Deneme siniri (throttle.ts): 429 + Retry-After (pencere sonuna kadar saniye).
  if (err instanceof GateRateLimitError) {
    c.header('Retry-After', String(err.retryAfterSeconds));
    return c.json({ error: err.code, message: err.message, retryAfterSeconds: err.retryAfterSeconds }, 429);
  }
  return handleError(err, c);
}
