export type TicketErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'invalid_state' | 'unprocessable' | 'unavailable';

const HTTP_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  invalid_state: 409,
  unprocessable: 422,
  unavailable: 503,
} as const satisfies Record<TicketErrorCode, number>;

/** Faz 3 (O1) - Ariza / bakim islemleri hatalari; anlamli HTTP durum koduna eslenir. */
export class TicketError extends Error {
  readonly httpStatus: (typeof HTTP_STATUS)[TicketErrorCode];
  constructor(
    readonly code: TicketErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TicketError';
    this.httpStatus = HTTP_STATUS[code];
  }
}
