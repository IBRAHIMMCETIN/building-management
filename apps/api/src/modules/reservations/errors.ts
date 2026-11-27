export type ReservationErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'slot_taken' | 'invalid_state' | 'unprocessable';

const HTTP_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  slot_taken: 409,
  invalid_state: 409,
  unprocessable: 422,
} as const satisfies Record<ReservationErrorCode, number>;

/** Ortak alan rezervasyonu hatalari; anlamli HTTP durum koduna eslenir. */
export class ReservationError extends Error {
  readonly httpStatus: (typeof HTTP_STATUS)[ReservationErrorCode];
  constructor(
    readonly code: ReservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReservationError';
    this.httpStatus = HTTP_STATUS[code];
  }
}
