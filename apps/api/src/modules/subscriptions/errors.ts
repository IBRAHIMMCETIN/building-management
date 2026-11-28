/** Abonelik islemleri hatalari (http/helpers.ts eslestirir; bu dosya hicbir modulu import etmez). */
export class SubscriptionError extends Error {
  readonly code: 'not_found' | 'conflict' | 'invalid_transition';
  readonly httpStatus: 404 | 409;
  constructor(code: SubscriptionError['code'], message: string) {
    super(message);
    this.name = 'SubscriptionError';
    this.code = code;
    this.httpStatus = code === 'not_found' ? 404 : 409;
  }
}
