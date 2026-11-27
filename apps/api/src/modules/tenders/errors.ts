export type TenderErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid_state' | 'unprocessable' | 'unavailable';

const HTTP_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_state: 409,
  unprocessable: 422,
  unavailable: 503,
} as const satisfies Record<TenderErrorCode, number>;

/** Ihale / teklif hatalari; anlamli HTTP durum koduna eslenir. */
export class TenderError extends Error {
  readonly httpStatus: (typeof HTTP_STATUS)[TenderErrorCode];
  constructor(
    readonly code: TenderErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'TenderError';
    this.httpStatus = HTTP_STATUS[code];
  }
}
