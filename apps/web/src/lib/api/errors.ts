/**
 * API hata govdesi: `{ error: string, message?: string, field?: string, ...details }`
 * (apps/api/src/http/helpers.ts -> handleError).
 */
export type ApiErrorBody = {
  error: string;
  message?: string;
  field?: string;
  [key: string]: unknown;
};

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly body?: ApiErrorBody;

  constructor(status: number, body?: ApiErrorBody) {
    super(body?.message ?? defaultMessage(status));
    this.name = 'ApiError';
    this.status = status;
    this.code = body?.error ?? `http_${status}`;
    this.field = body?.field;
    this.body = body;
  }

  get isUnauthorized() {
    return this.status === 401;
  }

  get isForbidden() {
    return this.status === 403;
  }
}

/** Ag hatasi, zaman asimi vb. (sunucudan yanit hic gelmedi). */
export class NetworkError extends Error {
  constructor(cause: unknown) {
    super('Sunucuya ulaşılamadı. Bağlantınızı kontrol edip tekrar deneyin.', { cause });
    this.name = 'NetworkError';
  }
}

/** Oturum yok veya yenilenemedi: kullanici yeniden giris yapmali. */
export class AuthRequiredError extends Error {
  constructor(message = 'Oturumunuzun süresi doldu. Lütfen tekrar giriş yapın.') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

function defaultMessage(status: number): string {
  if (status === 401) return 'Oturum doğrulanamadı.';
  if (status === 403) return 'Bu işlem için yetkiniz yok.';
  if (status === 404) return 'Kayıt bulunamadı.';
  if (status === 429) return 'Çok fazla istek gönderildi, biraz sonra tekrar deneyin.';
  if (status >= 500) return 'Sunucuda beklenmeyen bir hata oluştu.';
  return `İstek başarısız (${status}).`;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && typeof (value as ApiErrorBody).error === 'string';
}

/** Kullaniciya gosterilecek mesaj. Bu siniflarin mesajlari arayuz icin yazilmistir. */
export function errorMessage(err: unknown): string {
  if (
    err instanceof ApiError ||
    err instanceof NetworkError ||
    err instanceof AuthRequiredError ||
    (err instanceof Error && err.name === 'AuthFlowError')
  ) {
    return err.message;
  }
  return 'Beklenmeyen bir hata oluştu.';
}
