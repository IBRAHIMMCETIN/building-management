export type PollErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'poll_closed' | 'not_eligible' | 'unprocessable';

const HTTP_STATUS = {
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  poll_closed: 409,
  not_eligible: 403,
  unprocessable: 422,
} as const satisfies Record<PollErrorCode, number>;

/** Y1 - Anket / oylama hatalari; anlamli HTTP durum koduna eslenir. */
export class PollError extends Error {
  readonly httpStatus: (typeof HTTP_STATUS)[PollErrorCode];
  constructor(
    readonly code: PollErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PollError';
    this.httpStatus = HTTP_STATUS[code];
  }
}
