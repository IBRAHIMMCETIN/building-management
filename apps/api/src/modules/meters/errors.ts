/** Finans 2.3 - Sayac modulu hatalari; anlamli HTTP durum koduna eslenir (`http/helpers.ts`). */
export type MeterErrorCode = 'not_found' | 'conflict' | 'unprocessable' | 'forbidden' | 'unavailable';

const HTTP_STATUS = {
  not_found: 404,
  conflict: 409,
  unprocessable: 422,
  forbidden: 403,
  unavailable: 503,
} as const satisfies Record<MeterErrorCode, number>;

export class MeterError extends Error {
  readonly code: MeterErrorCode;
  readonly httpStatus: (typeof HTTP_STATUS)[MeterErrorCode];
  /** Toplu islemlerde satir bazli hatalar vb. (yanita eklenir). */
  readonly details: Record<string, unknown> | undefined;

  constructor(code: MeterErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'MeterError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = details;
  }
}
